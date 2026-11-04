// LIFELINE v2: think slow, act fast. Four layers run side by side on the town clock:
//   priority  the existing coordinated safety rules (unchanged)
//   reflex    fast: every step, if buses go dark it fires the pre-planned response at once (the tie that
//             re-energizes the pump station by the grid map, then the generator); no model on this path
//   brain     slow: when new warning signs arrive, the LLM states threats; each threat's spread is predicted
//             in simulation (what fails, when) and its reflex response is verified
//             and act-now interventions (e.g. pre-close a tie) are chosen only if they help when the threat
//             comes and do no harm when it does not
//   planner   the verified rolling planner for mitigation during an incident, as in the conventional hybrid
import { GRID, deenergized } from '../kernel/research-protocol.mjs';
import { CATALOG, priority, rolling } from '../controllers/joint.mjs';
import { buildBrainPrompt, parseBrain, telemetrySummary, threatType } from './brain.mjs';

const S = 1_000_000, MIN = 60 * S;
const DEFAULT_LAYOUT = { pumpStationBus: 'bus-7', backupPumpBus: 'bus-14', substationRouterBus: 'bus-14' };
const deadBuses = obs => obs.readings.filter(r => /^power:v-bus-/.test(r.sensorId) && r.value === 0 && obs.atUs - r.observedAtUs <= obs.staleAfterUs).map(r => r.assetId).sort();
const step = (id, domain, action, atUs, extra = {}) => ({ id, domain, action, atUs, ...extra });
const tieStep = (tie, atUs) => step(`reflex-${tie}`, 'power', { type: 'set_switch', params: { switchId: tie, closed: true } }, atUs, { cost: 1 });
const genStep = atUs => step('reflex-gen', 'resource', { type: 'allocate_generator', params: { resourceId: 'gen-portable', site: 'pump-station' } }, atUs, { durationUs: 600 * S, resources: [{ id: 'gen-portable', use: 'allocate', site: 'pump-station' }], cost: 2 });

// Pre-planned response to a dark set of buses: the lines whose trip explains it, and the ties that would
// re-energize the pump station (then the most buses) for those lines; ties with one end dark otherwise.
export function reflexTies(dead, layout = DEFAULT_LAYOUT) {
  const key = dead.join(',');
  const lines = Object.keys(GRID.lines).filter(l => deenergized([l]).join(',') === key);
  const score = (t, l) => { const after = deenergized([l], [t]); return (dead.includes(layout.pumpStationBus) && !after.includes(layout.pumpStationBus) ? 100 : 0) + (dead.length - after.length); };
  if (lines.length) {
    const best = new Map();
    for (const l of lines) for (const t of Object.keys(GRID.ties)) { const s = score(t, l); if (s > 0 && s > (best.get(t) ?? -1)) best.set(t, s); }
    return [...best.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }
  return Object.entries(GRID.ties).filter(([, [a, b]]) => dead.includes(a) !== dead.includes(b)).map(([t]) => t).sort();
}

export function reflexLayer({ layout = DEFAULT_LAYOUT, gridUs = 60 * S, log = () => {} } = {}) {
  let incident = null; // { dead, queue, tried, generator }
  return {
    name: 'reflex', label: 'armed reflexes (pre-planned, instant)', sync: true,
    async decide({ town, nowUs, obs }) {
      const dead = deadBuses(obs);
      const critical = dead.filter(b => b === layout.pumpStationBus || GRID.essentialBuses.includes(b));
      if (!critical.length) { if (incident) log({ kind: 'reflex', atUs: nowUs, text: `buses restored (${incident.tried.join(', ') || 'no action needed'})` }); incident = null; return { planId: 'reflex-idle', steps: [], redecideAtUs: nowUs + gridUs }; }
      if (!incident || dead.join(',') !== incident.dead.join(',')) {
        const queue = reflexTies(dead, layout);
        incident = { dead, queue, tried: incident?.tried ?? [], generator: incident?.generator ?? false };
        log({ kind: 'reflex', atUs: nowUs, text: `dark buses ${dead.join(', ')} → pre-planned response: ${queue.length ? `close ${queue.join(' then ')}` : 'no tie can help'}${dead.includes(layout.pumpStationBus) ? ', generator if still dark' : ''}` });
      }
      const steps = [];
      const next = incident.queue.find(t => !incident.tried.includes(t));
      if (next) { incident.tried.push(next); steps.push(tieStep(next, nowUs)); }
      else if (dead.includes(layout.pumpStationBus) && !incident.generator) {
        const state = await town.state();
        if (!state.resources['gen-portable']?.allocatedTo) steps.push(genStep(nowUs));
        incident.generator = true;
      }
      if (steps.length) log({ kind: 'reflex-fire', atUs: nowUs, text: `fired: ${steps.map(s => s.action.params.switchId ?? 'portable generator to pump station').join(', ')}` });
      return { planId: 'reflex', steps, redecideAtUs: nowUs + gridUs };
    },
  };
}

// Threats become planner scenarios: the trip at the start and at the end of its window, plus "nothing
// happens", so an act-now intervention must help under the threat and do no harm under a false alarm.
export function threatAdvisory(threats, nowUs, gridUs = 60 * S) {
  if (!threats.length) return null;
  const at = m => nowUs + Math.ceil(m * MIN / gridUs) * gridUs;
  const scenarios = [{ label: 'no-threat', assume: [] }];
  for (const t of threats) for (const [edge, m] of [['early', t.windowMin[0]], ['late', t.windowMin[1]]]) {
    scenarios.push({ label: `${t.id}-${edge}`, assume: [{ domain: 'power', faultId: `brain-${t.id}`, atUs: at(Math.max(m, 1)), type: threatType(t.assetId), assetId: t.assetId }] });
  }
  return { issuedAtUs: nowUs, source: 'LIFELINE brain', etaScenarios: scenarios };
}

const EVENT_TEXT = {
  supply_lost: e => `${e.assetId === 'PU1' ? 'pump station' : e.assetId} loses power`, supply_restored: e => `${e.assetId === 'PU1' ? 'pump station' : e.assetId} power restored`,
  router_battery_exhausted: e => `${e.assetId === 'rt-pump' ? 'pump-station control radio' : e.assetId} battery exhausted: remote control lost`,
  generator_fuel_exhausted: () => 'portable generator out of fuel', generator_overload: () => 'portable generator overloaded',
};
// Predicted spread of one threat: the cascade with no intervention, from the coupled simulation.
export async function predictSpread({ town, modelId, nowUs, earliestUs = nowUs, threat, horizonUs, gridUs = 60 * S }) {
  // The window is relative to when the brain was asked; the trip cannot be simulated before the snapshot.
  const tripAt = Math.max(nowUs + Math.ceil(Math.max(threat.windowMin[0], 1) * MIN / gridUs) * gridUs, earliestUs + gridUs);
  const assume = [{ domain: 'power', faultId: `brain-${threat.id}`, atUs: tripAt, type: threatType(threat.assetId), assetId: threat.assetId }];
  const dark = GRID.lines[threat.assetId] ? deenergized([threat.assetId]) : ['all buses'];
  const o = await town.preview({ steps: [], horizonUs }, modelId, assume);
  const chain = [{ atUs: tripAt, text: `${threat.assetId} fails; dark: ${dark.join(', ') || 'nothing'}` }];
  for (const e of o.events) if (EVENT_TEXT[e.type]) chain.push({ atUs: e.atUs, text: EVENT_TEXT[e.type](e) });
  if (o.firstEssentialLossUs !== null) chain.push({ atUs: o.firstEssentialLossUs, text: 'essential service (hospital water or essential power) below 99%' });
  chain.sort((a, b) => a.atUs - b.atUs);
  return { tripAtUs: tripAt, chain, waterEssentialUnmetM3: o.waterEssentialUnmetM3, powerEssentialUnservedJ: o.powerEssentialUnservedJ, minTankLevelM: o.minTankLevelM };
}

// Act-now coordination for one threat: the few interventions that matter (pre-closing a tie that would
// back-feed the threatened buses, dispatching the generator), each simulated if the threat comes and if it
// does not. Chosen only if it reduces predicted essential loss and does no harm under a false alarm.
const essential = o => (o.waterEssentialUnmetM3 ?? Infinity) * 1e6 + (o.powerEssentialUnservedJ ?? Infinity) / 1e3;
export async function preArm({ town, modelId, nowUs, threat, spread, horizonUs, quiet, allocated }) {
  if (!spread || threat.confidence < 0.5 || (spread.waterEssentialUnmetM3 <= 0.01 && spread.powerEssentialUnservedJ <= 1e6)) return null;
  const assume = [{ domain: 'power', faultId: `brain-${threat.id}`, atUs: spread.tripAtUs, type: threatType(threat.assetId), assetId: threat.assetId }];
  const options = [...threat.reflex.slice(0, 2).map(t => ({ label: `pre-close ${t}`, steps: [tieStep(t, nowUs)] })), ...(allocated ? [] : [{ label: 'pre-dispatch the portable generator to the pump station', steps: [genStep(nowUs)] }])];
  let best = null;
  for (const o of options) {
    const hit = await town.preview({ steps: o.steps, horizonUs }, modelId, assume);
    if (essential(hit) >= essential(spread)) continue;
    const calm = await town.preview({ steps: o.steps, horizonUs }, modelId, []);
    const harmless = essential(calm) <= essential(quiet) + 1 && calm.waterNonessentialUnmetM3 <= quiet.waterNonessentialUnmetM3 + 0.5 && calm.constraintSeconds <= quiet.constraintSeconds;
    if (!harmless) continue;
    const fuel = Object.values(calm.fuelUsedJ ?? {}).reduce((a, b) => a + b, 0);
    const cand = { ...o, ifThreat: hit, ifCalm: calm, key: [essential(hit), fuel] };
    if (!best || cand.key[0] < best.key[0] || (cand.key[0] === best.key[0] && cand.key[1] < best.key[1])) best = cand;
  }
  return best;
}

export function brainLayer({ policy, callModel, reports = [], providerCapS = 45, shared, log = () => {} }) {
  const read = new Set();
  return {
    name: 'brain', label: 'LIFELINE brain (Meta model reads warning signs)',
    async decide({ town, nowUs, obs }) {
      const visible = reports.filter(r => r.atUs <= nowUs);
      const fresh = visible.filter(r => !read.has(r.id));
      if (!fresh.length) return { planId: 'brain-idle', steps: [], redecideAtUs: nowUs + policy.gridUs };
      fresh.forEach(r => { read.add(r.id); log({ kind: 'warning', atUs: r.atUs, text: `${r.source}: ${r.text}`, reportId: r.id }); });
      const state = await town.state();
      const prompt = buildBrainPrompt({ nowUs, reports: visible, telemetry: telemetrySummary({ obs, state }) });
      const res = await callModel({ prompt: prompt.text, timeoutMs: providerCapS * 1000 });
      const call = { atUs: nowUs, code: res.code, durationMs: res.durationMs, usage: res.usage ?? null };
      shared.calls.push(call);
      if (res.code !== 'ok') { log({ kind: 'brain', atUs: nowUs, text: `brain unavailable (${res.code}); armed reflexes and rules continue` }); return { planId: 'brain-failed', steps: [], redecideAtUs: nowUs + policy.gridUs }; }
      const parsed = parseBrain(res.text, prompt);
      call.parse = parsed.ok ? 'ok' : parsed.code;
      if (!parsed.ok) { log({ kind: 'brain', atUs: nowUs, text: `brain answer rejected (${parsed.code}); previous threats kept` }); return { planId: 'brain-rejected', steps: [], redecideAtUs: nowUs + policy.gridUs }; }
      // In a live session the town keeps running while the model thinks; plan from the time of the model
      // snapshot actually simulated (in batch runs the world waits, and this equals the request time).
      const { modelId, atUs } = await town.admittedModel();
      const baseUs = Math.max(nowUs, atUs ?? nowUs);
      const horizonUs = Math.min(policy.durationUs - baseUs, 150 * MIN);
      const threats = [], steps = [];
      const quiet = horizonUs > 0 ? await town.preview({ steps: [], horizonUs }, modelId, []) : null;
      let allocated = Boolean(state.resources['gen-portable']?.allocatedTo);
      for (const t of parsed.threats) {
        const spread = horizonUs > 0 ? await predictSpread({ town, modelId, nowUs, earliestUs: baseUs, threat: t, horizonUs, gridUs: policy.gridUs }) : null;
        const reflex = GRID.lines[t.assetId] ? reflexTies(deenergized([t.assetId]), state.layout ?? DEFAULT_LAYOUT) : [];
        const threat = { ...t, assessedAtUs: nowUs, spread, reflex };
        log({ kind: 'threat', atUs: nowUs, text: `threat ${t.assetId} in ${t.windowMin[0]}-${t.windowMin[1]} min (confidence ${t.confidence}): ${t.why}`, threat });
        const act = horizonUs > 0 ? await preArm({ town, modelId, nowUs: baseUs, threat, spread, horizonUs, quiet, allocated }) : null;
        const before = shared.threats.find(x => x.assetId === t.assetId && x.actNow);
        if (before && !act) threat.actNow = { ...before.actNow, done: true }; // already protected by an earlier act-now
        if (act) {
          threat.actNow = { label: act.label, atUs: nowUs, chain: spread.chain, without: { waterEssentialUnmetM3: spread.waterEssentialUnmetM3, powerEssentialUnservedJ: spread.powerEssentialUnservedJ },
            ifThreat: { waterEssentialUnmetM3: act.ifThreat.waterEssentialUnmetM3, powerEssentialUnservedJ: act.ifThreat.powerEssentialUnservedJ } };
          if (!steps.some(x => x.id === act.steps[0].id)) steps.push(...act.steps.map(x => ({ ...x, id: `pre-${x.id}` })));
          if (act.steps.some(x => x.action.type === 'allocate_generator')) allocated = true;
          log({ kind: 'act-now', atUs: nowUs, text: `act now: ${act.label} — verified: if ${t.assetId} fails, essential loss ${act.ifThreat.waterEssentialUnmetM3.toFixed(1)} m³ water / ${(act.ifThreat.powerEssentialUnservedJ / 1e6).toFixed(0)} MJ power instead of ${spread.waterEssentialUnmetM3.toFixed(1)} m³ / ${(spread.powerEssentialUnservedJ / 1e6).toFixed(0)} MJ; harmless if it does not` });
        } else if (spread && (spread.waterEssentialUnmetM3 > 0.01 || spread.powerEssentialUnservedJ > 1e6)) {
          log({ kind: 'armed', atUs: nowUs, text: `armed: if ${t.assetId} fails → ${reflex.length ? `close ${reflex.join(' then ')}` : 'no tie can help'}${t.assetId !== 'grid-hv' ? '' : ''}, generator if the pump station stays dark` });
        }
        threats.push(threat);
      }
      for (const d of parsed.dismissed) log({ kind: 'dismissed', atUs: nowUs, text: `dismissed (${d.evidence.join(', ')}): ${d.why}` });
      shared.threats = threats;
      shared.advisory = threatAdvisory(threats.filter(t => t.confidence >= 0.2), nowUs, policy.gridUs);
      if (!threats.length) log({ kind: 'brain', atUs: nowUs, text: 'no threat stated; standing down' });
      return { planId: steps.length ? 'brain-act-now' : 'brain-assessed', steps, redecideAtUs: nowUs + policy.gridUs };
    },
  };
}

// The verified rolling planner for mitigation during an incident (pause/resume the station, shed a zone),
// on its normal schedule and scenarios, exactly as in the conventional hybrid.
export function plannerLayer(policy) {
  return Object.assign(rolling(policy), { name: 'planner', label: 'verified planner (mitigation during an incident)' });
}

export function lifeline(policy, { callModel, reports = [], providerCapS = 45, layout = DEFAULT_LAYOUT } = {}) {
  const shared = { threats: [], advisory: null, calls: [], log: [] };
  const log = e => shared.log.push(e);
  return {
    name: 'lifeline', label: 'LIFELINE v2: brain + verified planner + armed reflexes', shared,
    layers: [priority(policy), reflexLayer({ layout, gridUs: policy.gridUs, log }), brainLayer({ policy, callModel, reports, providerCapS, shared, log }), plannerLayer(policy)],
  };
}
export { CATALOG };
