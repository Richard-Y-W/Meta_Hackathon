// Conventional comparators for the coupled town (P13). Every controller acts only through the town's
// controller interface (observe, command, admitted model, preview) with the same capability catalog,
// observation ages, execution path and budgets as any proposed system.
//   independent  each utility acts on its own assets and its own telemetry
//   priority     a coordinated rule: shared restoration ETA and tank endurance decide a demand shift
//   rolling      the P12 planner re-decided every period and on outside changes (receding horizon)
//   oracle       the rolling planner given the true future: a private ceiling, never a comparator
import { validateTimedPlan } from '../kernel/plans.mjs';
import { evaluatePlan, searchPlans, templates } from '../kernel/planner.mjs';
import { spawnTownWorker } from '../domains/town.mjs';

const S = 1_000_000;
const RES = { 'gen-portable': {} };
export const CATALOG = {
  switches: ['sw-S1', 'sw-S2', 'sw-S3'], pumps: ['PU1', 'PU2'], links: ['PF', 'PZ'], sheddableLinks: ['PZ'], resources: ['gen-portable'], generators: [{ id: 'gen-portable', site: 'pump-station', setupUs: 600 * S }],
  stationModes: ['auto', 'paused'], capabilities: ['set_switch', 'allocate_generator', 'release_generator', 'set_station_mode', 'set_pump', 'set_link'],
};

const reading = (obs, id) => obs.readings.find(r => r.sensorId === id);
const fresh = (obs, id) => { const r = reading(obs, id); return r && r.value !== null && obs.atUs - r.observedAtUs <= obs.staleAfterUs ? r.value : null; };
const step = (id, domain, action, atUs, extra = {}) => ({ id, domain, action, atUs, ...extra });

export function independent(policy) {
  let deadSince = null, tried = 0, dispatched = false;
  return {
    name: 'independent', label: 'independent domain control',
    async decide({ nowUs, obs }) {
      const steps = [];
      // Any monitored bus de-energized (layout-independent: the rule does not know which bus feeds what).
      const dead = obs.readings.some(r => /^power:v-bus-/.test(r.sensorId) && fresh(obs, r.sensorId) === 0);
      deadSince = dead ? deadSince ?? nowUs : null;
      let redecideAtUs;
      if (dead && nowUs - deadSince >= policy.independent.tieDelayUs && tried < policy.independent.ties.length) {
        steps.push(step('tie', 'power', { type: 'set_switch', params: { switchId: policy.independent.ties[tried++], closed: true } }, nowUs));
        redecideAtUs = nowUs + 2 * policy.gridUs; // check the result and try the next tie promptly if still dead
      } else if (dead && tried === 0) {
        redecideAtUs = deadSince + policy.independent.tieDelayUs; // the rule's own delay, not the next period
      }
      if (policy.independent.dispatchGeneratorOnStationPowerLoss && !dispatched && fresh(obs, 'water:mains-pump-station') === 0) {
        dispatched = true;
        steps.push(step('gen', 'resource', { type: 'allocate_generator', params: { resourceId: 'gen-portable', site: 'pump-station' } }, nowUs));
      }
      return { planId: 'independent', steps, ...(redecideAtUs !== undefined ? { redecideAtUs } : {}) };
    },
  };
}

export function priority(policy) {
  const base = independent(policy);
  let shifted = false;
  return {
    name: 'priority', label: 'coordinated priority rule',
    async decide(ctx) {
      const plan = await base.decide(ctx);
      const { nowUs, obs, advisory } = ctx;
      const level = fresh(obs, 'water:lv-T1');
      const allocating = plan.steps.some(s => s.id === 'gen');
      if (!shifted && allocating && advisory && level !== null) {
        const p = policy.priority;
        const enduranceUs = ((level - p.minLevelM) * p.tankAreaM2 / p.drawM3s) * S;
        // Restoration ETAs are the line_restore events of the advisory scenarios (a threat advisory's first
        // event is the threat itself, not a restoration).
        const etas = advisory.etaScenarios.flatMap(s => s.assume.filter(a => a.type === 'line_restore').map(a => a.atUs));
        const latestEta = etas.length ? Math.max(...etas) : Infinity;
        // Shift only if storage alone outlasts the latest declared ETA with margin; resume at the first ETA.
        if (etas.length && nowUs + enduranceUs - p.enduranceMarginUs >= latestEta) {
          shifted = true;
          const resumeAt = Math.min(...etas);
          plan.steps.push(step('pause', 'water', { type: 'set_station_mode', params: { mode: 'paused' } }, nowUs, { order: 1 }));
          plan.steps.push(step('resume', 'water', { type: 'set_station_mode', params: { mode: 'auto' } }, resumeAt - (resumeAt % policy.gridUs)));
        }
      }
      return { ...plan, planId: 'priority' };
    },
  };
}

export function rolling(policy, { oracleFaults = null } = {}) {
  return {
    name: oracleFaults ? 'oracle' : 'rolling', label: oracleFaults ? 'ORACLE: perfect-information ceiling (not deployable)' : 'rolling-horizon joint optimizer',
    oracle: Boolean(oracleFaults),
    async decide({ town, nowUs, advisory }) {
      const scenarios = oracleFaults ? [{ label: 'truth', assume: oracleFaults.filter(f => f.atUs > nowUs) }]
        : advisory ? advisory.etaScenarios : [{ label: 'no-forecast', assume: [] }];
      const { modelId } = await town.admittedModel();
      const state = await town.state();
      const allocated = Object.fromEntries(Object.entries(state.resources).filter(([, r]) => r.allocatedTo).map(([id, r]) => [id, r.allocatedTo]));
      const r = await searchPlans({
        candidates: templates({ nowUs, catalog: CATALOG, state }),
        validate: p => validateTimedPlan(p, { nowUs, gridUs: policy.gridUs, resources: RES, allocated }),
        evaluate: p => evaluatePlan(p, { preview: (pl, a) => town.preview(pl, modelId, a), horizonUs: policy.durationUs - nowUs, scenarios }),
        budget: { maxCandidates: 20, wallMs: 600_000 },
      });
      const w = r.best.worst?.outcome;
      return { ...r.best.plan, search: { evaluated: r.evaluated, overrun: r.overrun, elapsedMs: r.elapsedMs }, replaceFuture: true,
        predicted: w ? { scenario: r.best.worst.scenario, waterEssentialUnmetM3: w.waterEssentialUnmetM3, powerEssentialUnservedJ: w.powerEssentialUnservedJ, horizonUs: policy.durationUs - nowUs } : null };
    },
  };
}

// One episode: decisions every period and on outside changes; immediate steps run now, later steps wait
// (a receding-horizon controller replaces them at its next decision); an outside change expires them.
// A layered controller runs independent layers side by side (e.g. fast rules and a slower planner), each
// with its own latency, decision schedule and queued steps; this is how conventional control keeps acting
// while a slower decision is computed.
export function hybrid(policy) {
  return { name: 'hybrid', label: 'rules in parallel with the rolling joint optimizer', layers: [priority(policy), rolling(policy)] };
}

const REACTIVE = new Set(['independent', 'priority']);

export async function runTownEpisode({ root, policy, c, controller, advisory = null, makeTown = () => spawnTownWorker({ root }), wallClock = () => Date.now() }) {
  const town = makeTown();
  const log = [];
  try {
    await town.initialize({ caseId: 't-no-fault', faults: c.faults, tankInitialLevels: c.tankInitialLevels, ...(c.layout ? { layout: c.layout } : {}) });
    const clock = (await town.observe()).clock;
    const layers = (controller.layers ?? [controller]).map(ctrl => ({ ctrl, future: [], nextDecision: 0, busyUntil: 0 }));
    let world = (await town.state()).worldRevision;
    for (let nowUs = 0; nowUs <= policy.durationUs; nowUs += policy.gridUs) {
      if (nowUs > 0) await town.advance(nowUs);
      const state = await town.state();
      const changed = state.worldRevision !== world;
      if (changed) {
        for (const L of layers) { for (const s of L.future) log.push({ id: s.id, layer: L.ctrl.name, status: 'expired', atUs: nowUs }); L.future = []; }
        world = state.worldRevision;
      }
      const visible = advisory && nowUs >= advisory.issuedAtUs ? advisory : null;
      // Steps that have become available run first; a new decision then plans from the resulting state.
      for (const L of layers) {
        for (const s of L.future.filter(x => x.atUs <= nowUs).sort((x, y) => (x.order ?? 0) - (y.order ?? 0))) {
          L.future.splice(L.future.indexOf(s), 1);
          const st = await town.state();
          const r = await town.command(s.domain, s.action, s.domain === 'power' ? st.revisions.power : st.revisions.water);
          log.push({ id: s.id, layer: L.ctrl.name, status: r.status, reason: r.reason ?? null, atUs: nowUs, action: s.action });
        }
      }
      for (const L of layers) {
        // A layer still computing its last decision cannot start another. Decisions are periodic; reactive
        // planners also re-decide on outside changes; a rule may ask to re-decide sooner.
        if (!(nowUs < policy.durationUs && nowUs >= L.busyUntil && (nowUs >= L.nextDecision || (changed && !REACTIVE.has(L.ctrl.name))))) continue;
        L.nextDecision = nowUs + policy.periodUs;
        // Decision latency is charged on the town clock (P11): wall time x acceleration, rounded up to the
        // grid. The world keeps running meanwhile; the plan's steps cannot act before it is available.
        const started = wallClock();
        const plan = await L.ctrl.decide({ town, nowUs, obs: await town.observe(), advisory: visible });
        const wallSeconds = (wallClock() - started) / 1000;
        // The oracle is a ceiling: perfect information and instant decisions (no latency charged).
        const chargedUs = L.ctrl.oracle ? 0 : Math.ceil(wallSeconds * clock.acceleration * S / policy.gridUs) * policy.gridUs;
        const availableUs = nowUs + chargedUs;
        L.busyUntil = availableUs;
        if (plan.redecideAtUs !== undefined) L.nextDecision = Math.min(L.nextDecision, Math.max(plan.redecideAtUs, availableUs));
        if (plan.replaceFuture) L.future = [];
        L.future.push(...plan.steps.map(s => ({ ...s, atUs: Math.max(s.atUs, availableUs) })));
        log.push({ atUs: nowUs, layer: L.ctrl.name, decision: plan.planId, wallSeconds, chargedUs, availableUs, ...(plan.search ? { search: plan.search } : {}) });
      }
    }
    const truth = await town.evaluatorTruth();
    const state = await town.state();
    const trace = town.trace ? (await town.trace()).trace : [];
    return { caseId: c.caseId, controller: controller.name, label: controller.label, oracle: Boolean(controller.oracle), trace, truth,
      waterEssentialUnmetM3: truth.water.essentialUnmetM3, powerEssentialUnservedJ: truth.power.essentialUnservedJ,
      waterNonessentialUnmetM3: Object.entries(truth.water.byNode ?? {}).filter(([n]) => !['JH', 'JF'].includes(n)).reduce((a, [, v]) => a + (v.deficitM3 ?? 0), 0),
      fuelUsedJ: 120e6 - state.resources['gen-portable'].fuelJ, commands: log.filter(x => x.status), decisions: log.filter(x => x.decision),
      chargedDecisionUs: log.filter(x => x.decision).reduce((x, y) => x + y.chargedUs, 0), clock };
  } finally { await town.close(); }
}

// Exhaustive check on a small finite space from one decision point, scored by previews of the same
// admitted model under the same scenarios: tie closure x generator dispatch time x station mode per 1 h slot.
export async function exhaustiveSchedules({ town, nowUs, gridUs, horizonUs, scenarios, slots = 4, slotUs = 3600 * S, ties = [null, ...CATALOG.switches] }) {
  const { modelId } = await town.admittedModel();
  let best = null, evaluated = 0;
  const modes = Array.from({ length: 2 ** slots }, (_, k) => Array.from({ length: slots }, (_, i) => ((k >> i) & 1 ? 'paused' : 'auto')));
  for (const tie of ties) for (const dispatch of [0, slotUs, null]) {
    for (const schedule of modes) {
      const steps = [];
      if (tie) steps.push(step('tie', 'power', { type: 'set_switch', params: { switchId: tie, closed: true } }, nowUs, { cost: 1 }));
      if (dispatch !== null) steps.push(step('gen', 'resource', { type: 'allocate_generator', params: { resourceId: 'gen-portable', site: 'pump-station' } }, nowUs + dispatch, { durationUs: 600 * S, resources: [{ id: 'gen-portable', use: 'allocate' }], cost: 2 }));
      schedule.forEach((mode, i) => {
        const prev = i === 0 ? 'auto' : schedule[i - 1];
        if (mode !== prev) steps.push(step(`m${i}`, 'water', { type: 'set_station_mode', params: { mode } }, nowUs + i * slotUs, { order: 1, cost: 0.5 }));
      });
      if (schedule.at(-1) === 'paused') steps.push(step('mend', 'water', { type: 'set_station_mode', params: { mode: 'auto' } }, nowUs + slots * slotUs - gridUs, { order: 1, cost: 0.5 }));
      const r = await evaluatePlan({ planId: `x-${dispatch}-${schedule.join('')}`, steps }, { preview: (pl, a) => town.preview(pl, modelId, a), horizonUs, scenarios });
      evaluated++;
      if (!best || r.key.some((v, i) => v !== best.key[i]) && compareKeys(r.key, best.key) < 0) best = r;
    }
  }
  return { best, evaluated };
}
const compareKeys = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
