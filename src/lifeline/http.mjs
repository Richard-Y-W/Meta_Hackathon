// LIFELINE operator and judge endpoints. The browser reads retained runs and one live run, injects only
// admitted administrative faults into that run's control file, and can stop or export it. It never
// reaches the privileged worker and cannot submit proposals.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readEvents } from './ledger.mjs';

const CONTROLLERS = new Set(['meta', 'adaptive', 'priority']);
const OPERATOR_FAULTS = {
  link_down: { fields: ['kind', 'linkId'] },
  link_up: { fields: ['kind', 'linkId'] },
  link_rate: { fields: ['kind', 'linkId', 'bwMbit'], check: f => typeof f.bwMbit === 'number' && f.bwMbit > 0 && f.bwMbit <= 100 },
  link_loss: { fields: ['kind', 'linkId', 'lossPercent'], check: f => typeof f.lossPercent === 'number' && f.lossPercent > 0 && f.lossPercent <= 100 },
};
const ID = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const lines = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);

function findRuns(root, prefix = '', depth = 0) {
  if (!existsSync(root) || depth > 3) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const id = prefix ? `${prefix}/${name}` : name;
    if (existsSync(join(dir, 'manifest.json'))) out.push({ id, dir });
    else out.push(...findRuns(dir, id, depth + 1));
  }
  return out;
}

function topologyOf(repo, manifest) {
  const scenario = readJson(resolve(repo, manifest.scenario.path));
  return {
    scenarioId: scenario.scenarioId, synthetic: scenario.synthetic, switches: scenario.topology.switches,
    links: scenario.topology.links.map(l => ({ linkId: l.linkId, a: l.a, b: l.b, nominalMbps: l.bwMbit })),
    hosts: scenario.topology.hosts.map(h => ({ hostId: h.hostId, switch: h.switch })),
    flows: scenario.workload.essential.map(f => ({ flowId: f.flowId, source: f.source, destination: f.destination, deadlineMs: f.deadlineMs })),
  };
}

const modeOf = (controller, live) => (live ? (controller === 'meta' ? 'live-meta' : 'live-deterministic') : 'recorded-replay');

export function createLifelineHandler({ repo, artifactsRoot, liveRoot, spawnRun, credentialPresent, liveDurationMs = 180_000 }) {
  const root = resolve(artifactsRoot);
  const scenarios = { operator: { path: 'fixtures/lifeline/development/no-fault.json', note: 'No scheduled faults; the judge injects them' }, 'dev-cascade': { path: 'fixtures/lifeline/development/cascade.json' } };
  try { for (const c of readJson(resolve(repo, 'fixtures/lifeline/protocol-v1.json')).cases) scenarios[c.caseId] = { path: c.path }; } catch { /* protocol optional */ }
  const linkIds = new Set(readJson(resolve(repo, scenarios.operator.path)).topology.links.map(l => l.linkId));
  let live = null;
  let counter = 0;

  const resolveRun = id => {
    if (typeof id !== 'string' || !ID.test(id) || id.split('/').some(s => s === '..' || s === '.')) return null;
    const dir = resolve(root, id);
    if (!(dir === root || dir.startsWith(root + sep)) || !existsSync(join(dir, 'manifest.json'))) return null;
    return dir;
  };

  const liveState = () => {
    if (!live) return { active: false, state: 'idle' };
    const exited = live.child.exitCode !== null && live.child.exitCode !== undefined;
    const state = !exited ? 'running' : live.child.exitCode === 0 ? 'finished' : 'disconnected';
    return { active: !exited, state, liveId: live.liveId, controller: live.controller, scenario: live.scenario, mode: modeOf(live.controller, true), out: live.out, startedAtUnixMs: live.startedAtUnixMs, exitCode: live.child.exitCode ?? null };
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/lifeline/')) return false;
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); return true; };
    const route = url.pathname.slice('/api/lifeline/'.length);
    try {
      if (req.method === 'GET') {
        if (route === 'runs') {
          const runs = findRuns(root).filter(r => !r.dir.startsWith(resolve(liveRoot))).map(({ id, dir }) => {
            const m = readJson(join(dir, 'manifest.json'));
            const s = existsSync(join(dir, 'summary.json')) ? readJson(join(dir, 'summary.json')) : null;
            return { id, runId: m.runId, controller: m.controller, scenarioId: m.scenario?.scenarioId, terminal: m.terminal, mode: 'recorded-replay', deliveryRate: s?.results?.primary?.deliveryRate ?? null, startedAtUnixMs: m.startedAtUnixMs ?? null };
          }).sort((a, b) => (b.startedAtUnixMs ?? 0) - (a.startedAtUnixMs ?? 0));
          return send(200, { runs, scenarios: Object.keys(scenarios) });
        }
        if (route === 'run' || route === 'export') {
          const dir = resolveRun(url.searchParams.get('id'));
          if (!dir) return send(400, { error: 'unknown or invalid run id' });
          const manifest = readJson(join(dir, 'manifest.json'));
          const summary = existsSync(join(dir, 'summary.json')) ? readJson(join(dir, 'summary.json')) : null;
          const events = existsSync(join(dir, 'events.jsonl')) ? readEvents(join(dir, 'events.jsonl')) : [];
          if (route === 'export') {
            const checksums = existsSync(join(dir, 'checksums.txt')) ? readFileSync(join(dir, 'checksums.txt'), 'utf8') : null;
            return send(200, { id: url.searchParams.get('id'), manifest, summary, events, checksums }, { 'Content-Disposition': `attachment; filename="lifeline-${manifest.runId}.json"` });
          }
          const observations = lines(join(dir, 'controller-view.jsonl')).filter((_, i) => i % 2 === 0);
          return send(200, { id: url.searchParams.get('id'), mode: 'recorded-replay', manifest, summary, events, observations, topology: topologyOf(repo, manifest) });
        }
        if (route === 'comparison') {
          const path = join(root, 'pilot-v1', 'comparison.json');
          return existsSync(path) ? send(200, readJson(path)) : send(404, { error: 'no pilot comparison retained yet' });
        }
        if (route === 'live') {
          const status = liveState();
          if (!live) return send(200, status);
          if (url.searchParams.get('liveId') && url.searchParams.get('liveId') !== live.liveId) return send(409, { error: 'stale live run id', ...status });
          const after = Number(url.searchParams.get('after') ?? 0);
          const events = existsSync(join(live.out, 'events.jsonl')) ? readEvents(join(live.out, 'events.jsonl')).filter(e => e.seq > after) : [];
          const observations = lines(join(live.out, 'controller-view.jsonl')).slice(-6);
          return send(200, { ...status, events, observations, topology: live.topology });
        }
        return send(404, { error: 'not found' });
      }
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
      const host = req.headers.host ?? '';
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(403, { error: 'cross-origin action rejected' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'JSON required' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(413, { error: 'request too large' }); }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid JSON' }); }

      if (route === 'live/start') {
        if (!Object.hasOwn(scenarios, body.scenario)) return send(400, { error: 'unknown scenario' });
        if (!CONTROLLERS.has(body.controller)) return send(400, { error: 'unknown controller' });
        if (live && liveState().active) return send(409, { error: 'a live run is already active', ...liveState() });
        if (body.controller === 'meta' && !credentialPresent) return send(409, { code: 'provider_unavailable', error: 'MODEL_API_KEY is not configured on the server' });
        const liveId = `live-${Date.now().toString(36)}-${counter}`;
        const tag = `lfy${'0123456789abcdefghijklmnopqrstuvwxyz'[counter++ % 36]}`;
        const out = join(liveRoot, liveId);
        mkdirSync(out, { recursive: true });
        appendFileSync(join(out, 'control.jsonl'), '');
        const scenario = scenarios[body.scenario];
        const args = ['--scenario', scenario.path, '--controller', body.controller, '--backend', 'mininet', '--tag', tag, '--out', out, '--live-control', join(out, 'control.jsonl'), '--duration-ms', String(liveDurationMs)];
        const child = spawnRun(args);
        live = { liveId, controller: body.controller, scenario: body.scenario, out, child, startedAtUnixMs: Date.now(), topology: topologyOf(repo, { scenario: { path: scenario.path } }) };
        return send(200, liveState());
      }
      if (route === 'live/fault' || route === 'live/stop') {
        if (!live || body.liveId !== live.liveId || !liveState().active) return send(409, { error: 'no active live run with that id', ...liveState() });
        if (route === 'live/stop') {
          appendFileSync(join(live.out, 'control.jsonl'), `${JSON.stringify({ kind: 'stop', atUnixMs: Date.now() })}\n`);
          return send(200, { stopping: true, liveId: live.liveId });
        }
        const { liveId, ...fault } = body;
        const spec = OPERATOR_FAULTS[fault.kind];
        if (!spec) return send(400, { error: 'fault kind not admitted for live control' });
        if (Object.keys(fault).some(k => !spec.fields.includes(k)) || spec.fields.some(k => !Object.hasOwn(fault, k))) return send(400, { error: 'fault fields do not match the admitted kind' });
        if (!linkIds.has(fault.linkId)) return send(400, { error: 'unknown link' });
        if (spec.check && !spec.check(fault)) return send(400, { error: 'fault quantity out of range' });
        appendFileSync(join(live.out, 'control.jsonl'), `${JSON.stringify({ kind: 'fault', fault, atUnixMs: Date.now() })}\n`);
        return send(200, { queued: fault, liveId });
      }
      return send(404, { error: 'not found' });
    } catch (error) {
      return send(500, { error: String(error.message).slice(0, 200) });
    }
  };
}

