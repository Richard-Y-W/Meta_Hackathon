// Resource-aware joint intervention search (P12). Bounded templates from the capability catalog are
// validated statically (plans.validateTimedPlan), simulated from the admitted estimated state under every
// declared uncertainty scenario, and ranked by the frozen service policy on their worst scenario:
// essential water unmet, then essential power unserved, then constraint time, then reserve (fuel) used,
// then the mean reserve use over scenarios, then action cost. A search that runs out of budget returns its best admitted plan, or retains policy.
import { validateTimedPlan } from './plans.mjs';

const S = 1_000_000;
export const RETAIN = { planId: 'retain-policy', steps: [], template: 'retain' };

export function rankKey(outcome, plan) {
  return [round(outcome.waterEssentialUnmetM3, 1e-3), round(outcome.powerEssentialUnservedJ, 1e3), outcome.constraintSeconds ?? 0,
    Object.values(outcome.fuelUsedJ ?? {}).reduce((a, b) => a + b, 0), (plan.steps ?? []).reduce((a, s) => a + (s.cost ?? 0), 0)];
}
const round = (v, q) => (v === null || v === undefined ? Infinity : Math.round(v / q) * q);
const compare = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

// Templates over the town's capability catalog and the observed state, instantiated at the decision time.
// Settings already in effect are part of the state: a paused station gets a resume candidate, and an
// allocated generator is used as it is rather than allocated again.
export function templates({ nowUs, catalog, state = {}, pauses = [3600 * S, 7200 * S] }) {
  const out = [RETAIN, { planId: 'probe-only', template: 'probe_only', steps: [] }];
  const gen = catalog.generators?.[0];
  const allocated = gen && state.resources?.[gen.id]?.allocatedTo;
  const pause = { id: 'pause', domain: 'water', action: { type: 'set_station_mode', params: { mode: 'paused' } }, atUs: nowUs, order: 1, cost: 0.5 };
  const resume = at => ({ id: 'resume', domain: 'water', action: { type: 'set_station_mode', params: { mode: 'auto' } }, atUs: at, cost: 0.5 });
  for (const sw of catalog.switches ?? []) {
    out.push({ planId: `close-${sw}`, template: 'switch', steps: [{ id: 'close', domain: 'power', action: { type: 'set_switch', params: { switchId: sw, closed: true } }, atUs: nowUs, cost: 1 }] });
  }
  if (state.stationMode === 'paused') out.push({ planId: 'resume-station', template: 'restore_setting', steps: [resume(nowUs)] });
  if (gen && !allocated) {
    const allocate = { id: 'gen', domain: 'resource', action: { type: 'allocate_generator', params: { resourceId: gen.id, site: gen.site } }, atUs: nowUs, durationUs: gen.setupUs, resources: [{ id: gen.id, use: 'allocate', site: gen.site }], cost: 2 };
    out.push({ planId: 'generator', template: 'generator', steps: [allocate] });
    for (const p of pauses) out.push({ planId: `generator-pause-${p / S}s`, template: 'generator+demand_shift', steps: [allocate, pause, { ...resume(nowUs + p), dependsOn: ['pause'] }] });
  } else if (gen && state.stationMode !== 'paused') {
    for (const p of pauses) out.push({ planId: `pause-${p / S}s`, template: 'demand_shift', steps: [pause, { ...resume(nowUs + p), dependsOn: ['pause'] }] });
  }
  return out;
}

// Simulate a plan under every scenario; its ranking outcome is the worst scenario by the policy order.
export async function evaluatePlan(plan, { preview, horizonUs, scenarios }) {
  const runs = [];
  for (const s of scenarios) runs.push({ scenario: s.label, outcome: await preview({ steps: plan.steps, horizonUs }, s.assume ?? []) });
  const worst = runs.reduce((w, r) => (w === null || compare(rankKey(r.outcome, plan), rankKey(w.outcome, plan)) > 0 ? r : w), null);
  // Robust order: the worst scenario decides service and reserve; among plans equal there, the mean reserve
  // use over the declared scenarios breaks the tie before action cost.
  const meanFuel = runs.reduce((a, r) => a + Object.values(r.outcome.fuelUsedJ ?? {}).reduce((x, y) => x + y, 0), 0) / runs.length;
  const k = rankKey(worst.outcome, plan);
  return { plan, runs, worst, key: [k[0], k[1], k[2], k[3], meanFuel, k[4]] };
}

// Steps that are each feasible alone but fail together (e.g. two loads that overload one generator).
export async function jointFeasibility(plan, { preview, horizonUs, assume = [] }) {
  const failure = o => o.events.some(e => e.type === 'generator_overload') || o.receipts.some(r => r.status === 'rejected');
  const together = await preview({ steps: plan.steps, horizonUs }, assume);
  if (!failure(together)) return { ok: true, code: 'ok' };
  for (const step of plan.steps) {
    const alone = await preview({ steps: [step, ...plan.steps.filter(s => (step.dependsOn ?? []).includes(s.id))], horizonUs }, assume);
    if (failure(alone)) return { ok: false, code: 'step_infeasible', stepId: step.id };
  }
  return { ok: false, code: 'jointly_infeasible', events: together.events.filter(e => e.type === 'generator_overload'), receipts: together.receipts };
}

export async function searchPlans({ candidates, validate, evaluate, budget, clock = () => Date.now() }) {
  const started = clock();
  const ranking = [], refused = [];
  let overrun = false;
  for (const plan of candidates.slice(0, budget.maxCandidates)) {
    if (clock() - started > budget.wallMs) { overrun = true; break; }
    const v = validate(plan);
    if (!v.ok) { refused.push({ planId: plan.planId, code: v.code, stepId: v.stepId }); continue; }
    ranking.push(await evaluate(plan));
  }
  if (candidates.length > budget.maxCandidates) overrun = true;
  ranking.sort((a, b) => compare(a.key, b.key));
  const best = ranking[0] ?? { plan: RETAIN, key: null, runs: [] };
  return { best, ranking, refused, evaluated: ranking.length, overrun, elapsedMs: clock() - started };
}

// Timed execution bound to the world revision the plan was made from (outside events: faults, trips). An
// outside change expires the remainder; completed steps are not rolled back (there is no multi-domain
// atomicity); the caller reads actual state and replans. The plan's own effects do not expire it.
export async function runTimedPlan({ town, plan, untilUs, gridUs, replan }) {
  const log = [];
  const expected = (await town.state()).worldRevision;
  const pending = [...plan.steps].sort((a, b) => a.atUs - b.atUs || (a.order ?? 0) - (b.order ?? 0));
  let now = (await town.state()).nowUs;
  while (pending.length && now <= untilUs) {
    const state = await town.state();
    if (state.worldRevision !== expected) {
      for (const s of pending.splice(0)) log.push({ id: s.id, status: 'expired', atUs: now, reason: 'outside_change', worldRevision: state.worldRevision, expected });
      const next = replan ? await replan({ nowUs: now, state, observation: await town.observe() }) : null;
      return { log, expiredAtUs: now, replanned: next };
    }
    for (const s of pending.filter(x => x.atUs <= now)) {
      pending.splice(pending.indexOf(s), 1);
      const revision = s.domain === 'power' ? state.revisions.power : state.revisions.water;
      const r = await town.command(s.domain, s.action, revision);
      log.push({ id: s.id, status: r.status, reason: r.reason ?? null, atUs: now });
    }
    if (!pending.length) break;
    now += gridUs;
    await town.advance(now);
  }
  return { log, expiredAtUs: null, replanned: null };
}
