import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { appendFileSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLifelineHandler } from '../../src/lifeline/http.mjs';
import { Ledger } from '../../src/lifeline/ledger.mjs';

const REPO = new URL('../..', import.meta.url).pathname;
const ROOT = join(REPO, '.work/tmp/http-test');

function bundle(name, { terminal = 'completed' } = {}) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  const ledger = new Ledger(join(dir, 'events.jsonl'));
  ledger.append('built', { configRevision: 1 });
  ledger.append('decision', { controller: 'meta', source: 'meta', proposal: { proposalId: 'p1', actions: [] }, decision: { admitted: true, code: 'ok', decidedAtMs: 1 } });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ runId: `run-${name}`, controller: 'meta', terminal, scenario: { path: 'fixtures/lifeline/development/cascade.json', scenarioId: 'dev-cascade-1' }, trafficStartAtMs: 0, durationMs: 120000, ledger: ledger.finalize(), provider: { model: 'm', credentialPresent: true } }));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ status: terminal === 'completed' ? 'scored' : 'run_incomplete', results: { primary: { offered: 10, onTime: 9, deliveryRate: 0.9 } }, series: {}, background: {} }));
  writeFileSync(join(dir, 'controller-view.jsonl'), JSON.stringify({ seq: 1, collectedAtMs: 1, links: {}, services: {} }) + '\n');
  return dir;
}

function fakeSpawn() {
  const runs = [];
  const spawnRun = args => { const child = new EventEmitter(); child.args = args; child.exitCode = null; child.kill = () => { child.exitCode = 143; child.emit('exit', 143); }; runs.push(child); return child; };
  return { spawnRun, runs };
}

async function server(opts = {}) {
  rmSync(ROOT, { recursive: true, force: true });
  bundle('pilot/p5.r1.meta');
  bundle('failed-run', { terminal: 'run_incomplete' });
  const spawn = fakeSpawn();
  const handler = createLifelineHandler({ repo: REPO, artifactsRoot: ROOT, liveRoot: join(ROOT, 'live'), spawnRun: spawn.spawnRun, credentialPresent: true, ...opts });
  const srv = http.createServer(async (req, res) => { if (!(await handler(req, res))) { res.writeHead(404); res.end('{}'); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  return { srv, call, spawn, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test('retained runs are listed as recorded-replay with their measured result', async t => {
  const s = await server();
  t.after(s.close);
  const r = await s.call('GET', '/api/lifeline/runs');
  assert.equal(r.status, 200);
  const run = r.body.runs.find(x => x.id === 'pilot/p5.r1.meta');
  assert.equal(run.mode, 'recorded-replay');
  assert.equal(run.deliveryRate, 0.9);
});

test('a run view includes topology, events, observations and score; path traversal is refused', async t => {
  const s = await server();
  t.after(s.close);
  const r = await s.call('GET', '/api/lifeline/run?id=pilot/p5.r1.meta');
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'recorded-replay');
  assert.ok(r.body.topology.links.length === 8);
  assert.equal(r.body.events.find(e => e.type === 'decision').source, 'meta');
  assert.equal(r.body.summary.results.primary.deliveryRate, 0.9);
  for (const id of ['../../etc', '/etc/passwd', 'pilot/../../..']) assert.equal((await s.call('GET', `/api/lifeline/run?id=${encodeURIComponent(id)}`)).status, 400);
});

test('a failed run can still be exported, with its incomplete status preserved', async t => {
  const s = await server();
  t.after(s.close);
  const r = await s.call('GET', '/api/lifeline/export?id=failed-run');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.equal(r.body.manifest.terminal, 'run_incomplete');
  assert.equal(r.body.summary.status, 'run_incomplete');
});

test('only one live run at a time; explicit start and stop', async t => {
  const s = await server();
  t.after(s.close);
  const start = await s.call('POST', '/api/lifeline/live/start', { scenario: 'operator', controller: 'meta' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.mode, 'live-meta');
  assert.equal((await s.call('POST', '/api/lifeline/live/start', { scenario: 'operator', controller: 'adaptive' })).status, 409);
  const stop = await s.call('POST', '/api/lifeline/live/stop', { liveId: start.body.liveId });
  assert.equal(stop.status, 200);
  const control = readFileSync(join(start.body.out, 'control.jsonl'), 'utf8');
  assert.match(control, /"kind":"stop"/);
});

test('unknown scenarios and controllers are refused; the meta controller needs a credential', async t => {
  const s = await server({ credentialPresent: false });
  t.after(s.close);
  assert.equal((await s.call('POST', '/api/lifeline/live/start', { scenario: '../../x', controller: 'meta' })).status, 400);
  assert.equal((await s.call('POST', '/api/lifeline/live/start', { scenario: 'operator', controller: 'root' })).status, 400);
  const meta = await s.call('POST', '/api/lifeline/live/start', { scenario: 'operator', controller: 'meta' });
  assert.deepEqual([meta.status, meta.body.code], [409, 'provider_unavailable']);
  assert.equal((await s.call('POST', '/api/lifeline/live/start', { scenario: 'operator', controller: 'adaptive' })).body.mode, 'live-deterministic');
});

test('judge faults are validated, bound to the live run, and appended for the orchestrator only', async t => {
  const s = await server();
  t.after(s.close);
  const { body: live } = await s.call('POST', '/api/lifeline/live/start', { scenario: 'operator', controller: 'adaptive' });
  const ok = await s.call('POST', '/api/lifeline/live/fault', { liveId: live.liveId, kind: 'link_rate', linkId: 'r1-r2', bwMbit: 3 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  for (const bad of [{ kind: 'reboot', linkId: 'r1-r2' }, { kind: 'link_down', linkId: 'r9-r1' }, { kind: 'link_rate', linkId: 'r1-r2', bwMbit: 0 }, { kind: 'link_loss', linkId: 'r1-r2', lossPercent: 150 }, { kind: 'link_down', linkId: 'r1-r2', cmd: 'x' }]) {
    assert.equal((await s.call('POST', '/api/lifeline/live/fault', { liveId: live.liveId, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await s.call('POST', '/api/lifeline/live/fault', { liveId: 'live-stale', kind: 'link_down', linkId: 'r1-r2' })).status, 409);
  const control = readFileSync(join(live.out, 'control.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(control.map(c => c.fault?.kind), ['link_rate']);
});

test('live status resumes events after a sequence number and shows a dead run as disconnected', async t => {
  const s = await server();
  t.after(s.close);
  const { body: live } = await s.call('POST', '/api/lifeline/live/start', { scenario: 'operator', controller: 'adaptive' });
  const ledger = new Ledger(join(live.out, 'events.jsonl'));
  ledger.append('built', {}); ledger.append('decision', { source: 'deterministic' }); ledger.append('execution', { status: 'confirmed' });
  const all = await s.call('GET', `/api/lifeline/live?liveId=${live.liveId}&after=0`);
  assert.equal(all.body.events.length, 3);
  assert.equal(all.body.state, 'running');
  const later = await s.call('GET', `/api/lifeline/live?liveId=${live.liveId}&after=2`);
  assert.deepEqual(later.body.events.map(e => e.type), ['execution']);
  s.spawn.runs[0].kill();
  const dead = await s.call('GET', `/api/lifeline/live?liveId=${live.liveId}&after=3`);
  assert.equal(dead.body.state, 'disconnected');
  assert.equal(dead.body.active, false);
});

test('mutating requests need JSON and a same-origin request', async t => {
  const s = await server();
  t.after(s.close);
  const r = await fetch(`http://127.0.0.1:${s.srv.address().port}/api/lifeline/live/start`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
  const cross = await fetch(`http://127.0.0.1:${s.srv.address().port}/api/lifeline/live/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
});
