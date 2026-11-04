// LIFELINE town endpoints (P15; LIFELINE v2 storylines and controller added Nov 3). One live coupled-town session runs at the town's accelerated clock: each
// wall tick advances one coupling step. Conventional rules decide synchronously; the planner layer runs
// asynchronously and its result is scheduled when it arrives, so its computation time passes on the town
// clock exactly as in the experiments. The browser can start, inject admitted judge faults, stop and
// export; it never reaches the worker, the evaluator's hidden schedule or the credential.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { priority, rolling } from './controllers/joint.mjs';
import { spawnTownWorker } from './domains/town.mjs';
import { lifeline } from './brain/lifeline.mjs';
import { LANDMARKS } from './brain/brain.mjs';
import { stubBrain } from './brain/stub.mjs';
import { callModel as metaCall } from './meta-provider.mjs';

const S = 1_000_000;
export const JUDGE_FAULTS = {
  line_trip: ['line-1-2', 'line-2-3', 'line-3-8', 'line-12-13', 'line-14-8'],
  actuator_unavailable: ['PU1', 'PU2'],
  router_fail: ['rt-pump', 'rt-sub'],
  sensor_freeze: ['lv-T1', 'pr-JH', 'v-bus-7', 'v-bus-9'],
};
const RUN_ID = /^town-[0-9]{14}-[0-9]+$/;

export function createTownHandler({ repo, makeTown = () => spawnTownWorker({ root: repo }), tickMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(),
  apiKey = process.env.MODEL_API_KEY, callModel = ({ prompt, timeoutMs }) => metaCall({ apiKey, prompt, timeoutMs, reasoningEffort: 'low' }) }) {
  const policy = JSON.parse(readFileSync(resolve(repo, 'fixtures/lifeline/infra/town/baseline-policy.json'), 'utf8'));
  const { storylines } = JSON.parse(readFileSync(resolve(repo, 'fixtures/lifeline/infra/town/storylines.json'), 'utf8'));
  // LIFELINE v2 storylines first (they carry warning signs), then the P13 development cases.
  const cases = Object.fromEntries([...storylines.map(st => [st.id, { caseId: st.id, title: st.title, story: st.story, faults: st.faults, tankInitialLevels: st.tankInitialLevels, reports: st.reports, storyline: true }]),
    ...policy.cases.map(c => [c.caseId, c])]);
  const CONTROLLERS = ['lifeline', 'hybrid', 'priority'];
  let live = null, counter = 0;

  const snapshot = () => {
    if (!live) return { state: 'idle' };
    const { town, layers, loop, shared, ...rest } = live;
    // Display only: scenario faults that have already happened (never future ones; controllers never see this).
    const scenarioEvents = (live.scenarioFaults ?? []).filter(f => f.atUs <= live.nowUs && f.atUs > 0).map(f => ({ type: f.type, assetId: f.assetId, atUs: f.atUs }));
    return { ...rest, scenarioFaults: undefined, scenarioEvents, layers: layers.map(L => ({ name: L.ctrl.name, label: L.ctrl.label, pending: L.pending ? { requestedAtUs: L.pending.requestedAtUs } : null })),
      lifeline: shared ? { log: shared.log.slice(-80), threats: shared.threats, brainCalls: shared.calls.map(c => ({ atUs: c.atUs, code: c.code, parse: c.parse ?? null, durationMs: c.durationMs })) } : null };
  };
  const note = (entry) => { live.timeline.push(entry); if (live.timeline.length > 400) live.timeline.shift(); };

  async function tick(L) {
    const t = live.town;
    live.nowUs += policy.gridUs;
    await t.advance(live.nowUs);
    const [state, obs, trace] = [await t.state(), await t.observe(), await t.trace()];
    const point = trace.trace.at(-1);
    live.series.push({ atUs: point.atUs, tankLevelM: point.tankLevelM, hospitalWaterFraction: point.hospitalWaterFraction, essentialPowerFraction: point.essentialPowerFraction,
      routers: point.routers, pumps: Object.fromEntries(Object.entries(point.pumps).map(([k, v]) => [k, { running: v.running, powered: v.powered, commanded: v.commanded }])) });
    if (live.series.length > 600) live.series.shift();
    for (const e of trace.events.slice(live.eventsSeen)) if (['supply_lost', 'supply_restored', 'router_battery_exhausted', 'generator_overload', 'generator_fuel_exhausted', 'router_fail', 'coupling_unresolved'].includes(e.type)) note({ kind: 'event', ...e });
    live.eventsSeen = trace.events.length;
    if (state.worldRevision !== live.world) { for (const x of layers()) { for (const s of x.future) note({ kind: 'command', id: s.id, layer: x.ctrl.name, status: 'expired', atUs: live.nowUs }); x.future = []; } live.world = state.worldRevision; }
    for (const x of layers()) {
      for (const s of x.future.filter(f => f.atUs <= live.nowUs)) {
        x.future.splice(x.future.indexOf(s), 1);
        const st = await t.state();
        const r = await t.command(s.domain, s.action, s.domain === 'power' ? st.revisions.power : st.revisions.water);
        note({ kind: 'command', id: s.id, layer: x.ctrl.name, action: s.action, status: r.status, reason: r.reason ?? null, atUs: live.nowUs, effectAtUs: r.effectAtUs ?? null });
      }
      const visible = live.advisory && live.nowUs >= live.advisory.issuedAtUs ? live.advisory : null;
      if (x.pending || live.nowUs < x.nextDecision) continue;
      x.nextDecision = live.nowUs + policy.periodUs;
      const requestedAtUs = live.nowUs;
      const job = x.ctrl.decide({ town: t, nowUs: requestedAtUs, obs, advisory: visible });
      if (x.ctrl.name === 'priority' || x.ctrl.sync) { await settle(x, await job, requestedAtUs); continue; }
      x.pending = { requestedAtUs };
      job.then(plan => settle(x, plan, requestedAtUs)).catch(error => { x.pending = null; note({ kind: 'decision', layer: x.ctrl.name, status: 'failed', detail: String(error.message ?? error), atUs: live.nowUs }); });
    }
    // Asset states are read after this tick's commands, so the table and the timeline agree.
    { const [state2, obs2] = [await t.state(), await t.observe()];
    live.assets = { stationMode: state2.stationMode, closedLinks: state2.closedLinks, resources: state2.resources,
      switches: Object.fromEntries(obs2.readings.filter(r => /^power:st-s/.test(r.sensorId)).map(r => [r.assetId, r.value === null ? 'unknown' : r.value ? 'closed' : 'open'])),
      buses: Object.fromEntries(obs2.readings.filter(r => /^power:v-bus-/.test(r.sensorId)).map(r => [r.assetId, r.value === null ? 'unknown' : r.value > 0 ? 'live' : 'dark'])),
      routers: obs2.routers };
    }
  }
  const layers = () => live.layers;
  function settle(x, plan, requestedAtUs) {
    x.pending = null;
    const availableUs = Math.max(live.nowUs, requestedAtUs);
    if (plan.redecideAtUs !== undefined) x.nextDecision = Math.min(x.nextDecision, plan.redecideAtUs);
    if (plan.replaceFuture) x.future = [];
    x.future.push(...plan.steps.map(s => ({ ...s, atUs: Math.max(s.atUs, availableUs + policy.gridUs) })));
    if (plan.steps.length || !(x.ctrl.name === 'priority' || x.ctrl.sync || /idle|assessed/.test(plan.planId))) note({ kind: 'decision', layer: x.ctrl.name, plan: plan.planId, steps: plan.steps.map(s => s.action), predicted: plan.predicted ?? null, requestedAtUs, availableUs, atUs: availableUs });
  }

  async function run() {
    try {
      while (live.state === 'running') {
        await sleep(tickMs);
        if (live.state !== 'running') break;
        if (live.nowUs >= policy.durationUs) {
          live.truth = await live.town.evaluatorTruth();
          live.state = 'finished';
          live.endedAtUnixMs = now();
          break;
        }
        await tick();
      }
    } catch (error) {
      if (live.state === 'running') { live.state = 'disconnected'; live.error = { code: error.code ?? 'error', detail: String(error.detail ?? error.message ?? error).slice(0, 200) }; live.endedAtUnixMs = now(); }
    } finally {
      if (live.state !== 'running') await live.town.close().catch(() => {});
    }
  }

  // Measured storyline comparison (scripts/lifeline-v2-run.mjs output), shown as recorded; nothing is computed here.
  const measured = () => {
    try {
      const d = JSON.parse(readFileSync(resolve(repo, process.env.LIFELINE_V2_RESULTS ?? 'artifacts/lifeline/v2/run-0/storylines.json'), 'utf8'));
      return { source: process.env.LIFELINE_V2_RESULTS ?? 'artifacts/lifeline/v2/run-0/storylines.json', brain: d.brain, rows: d.rows.map(r => ({ storyline: r.storyline, controller: r.controller, waterEssentialUnmetM3: r.waterEssentialUnmetM3, powerEssentialUnservedJ: r.powerEssentialUnservedJ, waterNonessentialUnmetM3: r.waterNonessentialUnmetM3, fuelUsedJ: r.fuelUsedJ })) };
    } catch { return { source: null, rows: [] }; }
  };
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON required'), { status: 415 });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw Object.assign(new Error('Request too large'), { status: 413 }); }
    try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  const current = id => (typeof id === 'string' && RUN_ID.test(id) && live && live.runId === id);

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/town/')) return false;
    const route = url.pathname.slice('/api/town/'.length);
    try {
      if (req.method === 'GET') {
        if (route === 'cases') return send(res, 200, { cases: Object.values(cases).map(c => ({ caseId: c.caseId, title: c.title ?? c.caseId, story: c.story ?? null, storyline: Boolean(c.storyline) })), controllers: CONTROLLERS, judgeFaults: JUDGE_FAULTS,
          brain: apiKey ? 'Meta model (live)' : 'rehearsal stand-in (keyword rules, no model)', landmarks: LANDMARKS,
          clock: { mode: 'accelerated_modeled', acceleration: 60, wallSecondsPerStep: tickMs / 1000, stepSimSeconds: policy.gridUs / S } }), true;
        if (route === 'live') return send(res, 200, snapshot()), true;
        if (route === 'v2-results') return send(res, 200, measured()), true;
        if (route === 'live/export') {
          if (!current(url.searchParams.get('runId'))) return send(res, 409, { error: 'stale_run', current: live?.runId ?? null }), true;
          res.setHeader('Content-Disposition', `attachment; filename="${live.runId}.json"`);
          return send(res, 200, { schema: 'lifeline.town-live-export.v1', ...snapshot() }), true;
        }
        return send(res, 404, { error: 'Not found' }), true;
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }), true;
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Cross-origin action rejected' }), true;
      const b = await body(req);
      if (route === 'live/start') {
        if (live?.state === 'running') return send(res, 409, { error: 'already_running', runId: live.runId }), true;
        const c = cases[b.caseId];
        if (!c || !CONTROLLERS.includes(b.controller)) return send(res, 400, { error: 'unknown case or controller' }), true;
        const town = makeTown();
        await town.initialize({ caseId: 't-no-fault', faults: c.faults, tankInitialLevels: c.tankInitialLevels });
        const stamp = new Date(now()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const lf = b.controller === 'lifeline' ? lifeline(policy, { callModel: apiKey ? callModel : stubBrain(), reports: c.reports ?? [] }) : null;
        const ctrls = lf ? lf.layers : b.controller === 'hybrid' ? [priority(policy), rolling(policy)] : [priority(policy)];
        live = { runId: `town-${stamp}-${++counter}`, caseId: c.caseId, controller: b.controller, state: 'running', nowUs: 0, durationUs: policy.durationUs,
          clock: { mode: 'accelerated_modeled', acceleration: 60 }, title: c.title ?? c.caseId, story: c.story ?? null, shared: lf?.shared ?? null, scenarioFaults: c.storyline ? c.faults : [],
          provider: lf ? { state: apiKey ? 'Meta brain live' : 'brain rehearsal (keyword stand-in)', note: 'the brain reads warning signs; reflexes and rules act without it' } : { state: 'model off', note: 'conventional comparator only' },
          startedAtUnixMs: now(), world: (await town.state()).worldRevision, eventsSeen: 0, timeline: [], series: [], assets: null, truth: null, error: null,
          advisory: !c.storyline && c.faults.some(f => f.type === 'line_trip') ? policy.advisory : null, town, layers: ctrls.map(ctrl => ({ ctrl, future: [], nextDecision: 0, pending: null })) };
        live.loop = run();
        return send(res, 200, snapshot()), true;
      }
      if (!current(b.runId)) return send(res, 409, { error: 'stale_run', current: live?.runId ?? null }), true;
      if (route === 'live/stop') {
        if (live.state === 'running') { live.state = 'stopped'; live.stoppedAtUs = live.nowUs; live.endedAtUnixMs = now(); await live.loop; }
        return send(res, 200, snapshot()), true;
      }
      if (route === 'live/fault') {
        if (live.state !== 'running') return send(res, 409, { error: `run is ${live.state}` }), true;
        const f = b.fault ?? {};
        if (!JUDGE_FAULTS[f.type]?.includes(f.assetId) || Object.keys(f).some(k => !['type', 'assetId'].includes(k))) return send(res, 400, { error: 'fault not admitted' }), true;
        const r = await live.town.inject(f);
        note({ kind: 'judge_fault', fault: f, requestedAtUs: r.requestedAtUs, effectAtUs: r.effectAtUs, atUs: r.requestedAtUs });
        return send(res, 200, { injected: r }), true;
      }
      return send(res, 404, { error: 'Not found' }), true;
    } catch (error) {
      return send(res, error.status ?? 400, { error: String(error.message ?? error) }), true;
    }
  };
}
