// P15: the town endpoints keep visible states accurate: stale run IDs, reconnects, a dead worker, partial
// actions and operator stop. A fake town stands in for the worker; the handler and controllers are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createTownHandler } from '../../../src/lifeline/infra-http.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const S = 1_000_000;

function fakeTown({ dieAtUs = Infinity } = {}) {
  let now = 0, world = 0;
  const commands = [], injected = [];
  return {
    commands, injected,
    initialize: async () => ({}), close: async () => ({}),
    advance: async t => { if (t >= dieAtUs) throw Object.assign(new Error('worker_unavailable: exited:1'), { code: 'worker_unavailable', detail: 'exited:1' }); now = t; if (t === 1800 * S) world++; },
    state: async () => ({ nowUs: now, worldRevision: world, revisions: { power: world, water: 0 }, stationMode: 'auto', closedLinks: [], resources: { 'gen-portable': { allocatedTo: null, fuelJ: 120e6 } } }),
    observe: async () => ({ atUs: now, staleAfterUs: 120 * S, routers: { 'rt-pump': 'up' }, clock: { acceleration: 60 },
      readings: [{ sensorId: 'power:v-bus-7', assetId: 'bus-7', value: now >= 1800 * S ? 0 : 19000, observedAtUs: now }, { sensorId: 'water:mains-pump-station', assetId: 'pump-station', value: 1, observedAtUs: now },
        { sensorId: 'power:st-s1', assetId: 'sw-S1', value: 0, observedAtUs: now }] }),
    trace: async () => ({ trace: [{ atUs: now, tankLevelM: 3, hospitalWaterFraction: 1, essentialPowerFraction: now >= 1800 * S ? 0.3 : 1, routers: {}, pumps: { PU1: { running: true, powered: true, commanded: true } } }], events: [] }),
    command: async (domain, action) => { commands.push(action); return action.params.switchId === 'sw-S1' ? { status: 'rejected', reason: 'actuator_unavailable' } : { status: 'delivered' }; },
    inject: async fault => { injected.push(fault); return { requestedAtUs: now, effectAtUs: now + 60 * S }; },
    evaluatorTruth: async () => ({ water: { essentialUnmetM3: 0 }, power: { essentialUnservedJ: 0 } }),
  };
}

async function harness(t, town) {
  const handle = createTownHandler({ repo: ROOT, makeTown: () => town, tickMs: 0, sleep: () => new Promise(r => setImmediate(r)) });
  const server = http.createServer(async (req, res) => { if (!(await handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const until = async (pred, label) => { for (let i = 0; i < 20000; i++) { const s = (await get('/api/town/live')).body; if (pred(s)) return s; await new Promise(r => setImmediate(r)); } throw new Error(`timeout: ${label}`); };
  return { get, post, until };
}

test('start, reconnect and stale run IDs', async t => {
  const h = await harness(t, fakeTown());
  const started = (await h.post('/api/town/live/start', { caseId: 'b-tie-available', controller: 'priority' })).body;
  assert.match(started.runId, /^town-\d{14}-\d+$/);
  assert.equal(started.state, 'running');
  assert.equal((await h.post('/api/town/live/start', { caseId: 'b-tie-available', controller: 'priority' })).status, 409);
  const again = (await h.get('/api/town/live')).body; // a reconnecting browser gets the same run
  assert.equal(again.runId, started.runId);
  for (const [path, payload] of [['/api/town/live/fault', { runId: 'town-20000101000000-9', fault: { type: 'router_fail', assetId: 'rt-pump' } }], ['/api/town/live/stop', { runId: 'nope' }]]) {
    const r = await h.post(path, payload);
    assert.deepEqual([r.status, r.body.error, r.body.current], [409, 'stale_run', started.runId]);
  }
  assert.equal((await h.get('/api/town/live/export?runId=town-20000101000000-9')).status, 409);
  await h.post('/api/town/live/stop', { runId: started.runId });
});

test('judge faults are admitted only from the list, with request and effect times', async t => {
  const town = fakeTown();
  const h = await harness(t, town);
  const { runId } = (await h.post('/api/town/live/start', { caseId: 'b-no-fault', controller: 'priority' })).body;
  assert.equal((await h.post('/api/town/live/fault', { runId, fault: { type: 'line_trip', assetId: 'line-9-9' } })).status, 400);
  assert.equal((await h.post('/api/town/live/fault', { runId, fault: { type: 'line_trip', assetId: 'line-3-8', atUs: 0 } })).status, 400);
  const ok = await h.post('/api/town/live/fault', { runId, fault: { type: 'router_fail', assetId: 'rt-pump' } });
  assert.equal(ok.status, 200);
  const s = (await h.get('/api/town/live')).body;
  const entry = s.timeline.find(e => e.kind === 'judge_fault');
  assert.equal(entry.effectAtUs - entry.requestedAtUs, 60 * S);
  assert.deepEqual(town.injected, [{ type: 'router_fail', assetId: 'rt-pump' }]);
  await h.post('/api/town/live/stop', { runId });
});

test('a partial action is visible: a refused tie stays refused in the timeline', async t => {
  const h = await harness(t, fakeTown());
  const { runId } = (await h.post('/api/town/live/start', { caseId: 'b-tie-available', controller: 'priority' })).body;
  const s = await h.until(x => x.timeline.some(e => e.kind === 'command' && e.status === 'rejected'), 'refused tie');
  const refused = s.timeline.find(e => e.kind === 'command' && e.status === 'rejected');
  assert.deepEqual([refused.action.params.switchId, refused.reason], ['sw-S1', 'actuator_unavailable']);
  await h.until(x => x.timeline.some(e => e.kind === 'command' && e.status === 'delivered'), 'next tie delivered');
  await h.post('/api/town/live/stop', { runId });
});

test('a dead worker is shown as disconnected, not as running or finished', async t => {
  const h = await harness(t, fakeTown({ dieAtUs: 600 * S }));
  await h.post('/api/town/live/start', { caseId: 'b-no-fault', controller: 'priority' });
  const s = await h.until(x => x.state !== 'running', 'disconnect');
  assert.equal(s.state, 'disconnected');
  assert.equal(s.error.code, 'worker_unavailable');
  assert.equal(s.nowUs, 600 * S);
});

test('operator stop is final and recorded', async t => {
  const h = await harness(t, fakeTown());
  const { runId } = (await h.post('/api/town/live/start', { caseId: 'b-no-fault', controller: 'priority' })).body;
  await h.until(x => x.nowUs >= 300 * S, 'progress');
  const stopped = (await h.post('/api/town/live/stop', { runId })).body;
  assert.equal(stopped.state, 'stopped');
  assert.ok(Number.isInteger(stopped.stoppedAtUs));
  const later = (await h.get('/api/town/live')).body;
  assert.deepEqual([later.state, later.nowUs], ['stopped', stopped.nowUs]);
  assert.equal((await h.post('/api/town/live/fault', { runId, fault: { type: 'router_fail', assetId: 'rt-pump' } })).status, 409);
  assert.equal((await h.get(`/api/town/live/export?runId=${runId}`)).body.schema, 'lifeline.town-live-export.v1');
});
