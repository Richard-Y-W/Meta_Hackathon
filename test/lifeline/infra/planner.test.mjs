// P12: joint plan validation, joint feasibility, bounded search and timed execution. The integration tests
// drive the real coupled town worker (town environment); they skip with a reason if it is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateTimedPlan } from '../../../src/lifeline/kernel/plans.mjs';
import { evaluatePlan, jointFeasibility, runTimedPlan, searchPlans, templates, RETAIN } from '../../../src/lifeline/kernel/planner.mjs';
import { spawnTownWorker } from '../../../src/lifeline/domains/town.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const skip = existsSync(`${ROOT}.work/environments/town/bin/python`) ? false : 'town environment not found';
const CONTROLS = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/town/plan-controls.json', import.meta.url), 'utf8'));
const S = 1_000_000;
const NOW = 1860 * S, GRID = 60 * S;
const RES = { 'gen-portable': {} };
const allocate = (id, at) => ({ id, domain: 'resource', action: { type: 'allocate_generator', params: { resourceId: 'gen-portable', site: 'pump-station' } }, atUs: at, durationUs: 600 * S, resources: [{ id: 'gen-portable', use: 'allocate', site: 'pump-station' }] });
const pumpOn = (at, providedBy) => ({ id: 'pu1-on', domain: 'water', action: { type: 'set_pump', params: { pumpId: 'PU1', on: true } }, atUs: at, preconditions: [{ kind: 'supply_available', asset: 'PU1', providedBy }] });

test('RED: a generator cannot be allocated twice', () => {
  const plan = { steps: [allocate('a', NOW), { ...allocate('b', NOW + GRID), resources: [{ id: 'gen-portable', use: 'allocate', site: 'substation' }] }] };
  assert.equal(validateTimedPlan(plan, { nowUs: NOW, gridUs: GRID, resources: RES }).code, 'resource_double_allocation');
  assert.equal(validateTimedPlan({ steps: [allocate('a', NOW)] }, { nowUs: NOW, gridUs: GRID, resources: RES, allocated: { 'gen-portable': 'pump-station' } }).code, 'resource_double_allocation');
  const released = { steps: [allocate('a', NOW), { id: 'r', domain: 'resource', action: { type: 'release_generator', params: { resourceId: 'gen-portable' } }, atUs: NOW + 900 * S, resources: [{ id: 'gen-portable', use: 'release' }] }, allocate('b', NOW + 1200 * S)] };
  assert.equal(validateTimedPlan(released, { nowUs: NOW, gridUs: GRID, resources: RES }).ok, true);
});

test('RED: a pump cannot be restored before its supply is available', () => {
  assert.equal(validateTimedPlan({ steps: [allocate('gen', NOW), pumpOn(NOW + 300 * S, 'gen')] }, { nowUs: NOW, gridUs: GRID, resources: RES }).code, 'precondition_unmet');
  assert.equal(validateTimedPlan({ steps: [allocate('gen', NOW), pumpOn(NOW + 600 * S, 'gen')] }, { nowUs: NOW, gridUs: GRID, resources: RES }).ok, true);
  assert.equal(validateTimedPlan({ steps: [pumpOn(NOW, 'missing')] }, { nowUs: NOW, gridUs: GRID, resources: RES }).code, 'precondition_unmet');
});

test('RED: a late command is refused', () => {
  assert.equal(validateTimedPlan({ steps: [allocate('gen', NOW - GRID)] }, { nowUs: NOW, gridUs: GRID, resources: RES }).code, 'late_command');
  assert.equal(validateTimedPlan({ steps: [{ ...allocate('gen', NOW), deadlineUs: NOW + 300 * S }] }, { nowUs: NOW, gridUs: GRID, resources: RES }).code, 'late_command');
  assert.equal(validateTimedPlan({ steps: [allocate('gen', NOW + 30 * S)] }, { nowUs: NOW, gridUs: GRID, resources: RES }).code, 'off_grid_step');
});

test('RED: individually feasible steps that are jointly infeasible are refused', async () => {
  // Fake preview: each pump alone fits the generator; both together overload it.
  const preview = async ({ steps }) => ({ receipts: steps.map(s => ({ id: s.id, status: 'delivered' })), events: steps.filter(s => s.id.startsWith('pump')).length > 1 ? [{ type: 'generator_overload' }] : [] });
  const plan = { steps: [{ id: 'pump-a' }, { id: 'pump-b' }] };
  const r = await jointFeasibility(plan, { preview, horizonUs: 3600 * S });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'jointly_infeasible');
  assert.equal((await jointFeasibility({ steps: [{ id: 'pump-a' }] }, { preview, horizonUs: 3600 * S })).ok, true);
});

test('bounded search returns the best admitted plan on overrun, or retains policy', async () => {
  let t = 0;
  const clock = () => t;
  const evaluate = async plan => { t += 100; return { plan, key: [plan.score, 0, 0, 0, 0, 0], runs: [] }; };
  const candidates = [RETAIN, ...[5, 1, 3, 0.5].map((score, i) => ({ planId: `p${i}`, score, steps: [] }))].map((p, i) => ({ ...p, score: p.score ?? 9 }));
  const r = await searchPlans({ candidates, validate: () => ({ ok: true }), evaluate, budget: { maxCandidates: 10, wallMs: 250 }, clock });
  assert.equal(r.overrun, true);
  assert.equal(r.evaluated, 3);
  assert.equal(r.best.plan.planId, 'p1');
  const none = await searchPlans({ candidates, validate: () => ({ ok: true }), evaluate, budget: { maxCandidates: 10, wallMs: -1 }, clock });
  assert.equal(none.best.plan.planId, 'retain-policy');
  const refused = await searchPlans({ candidates: [{ planId: 'bad', steps: [allocate('g', NOW - GRID)] }], validate: p => validateTimedPlan(p, { nowUs: NOW, gridUs: GRID, resources: RES }), evaluate, budget: { maxCandidates: 5, wallMs: 1e9 }, clock });
  assert.deepEqual(refused.refused, [{ planId: 'bad', code: 'late_command', stepId: 'g' }]);
});

async function townAt(t, c) {
  const town = spawnTownWorker({ root: ROOT });
  t.after(() => town.close());
  await town.initialize({ caseId: 't-no-fault', faults: c.faults, tankInitialLevels: c.tankInitialLevels });
  await town.advance(CONTROLS.decisionAtUs);
  return town;
}

async function decide(town) {
  const { modelId } = await town.admittedModel();
  const state = await town.state();
  const allocated = Object.fromEntries(Object.entries(state.resources).filter(([, r]) => r.allocatedTo).map(([id, r]) => [id, r.allocatedTo]));
  const preview = (plan, assume) => town.preview(plan, modelId, assume);
  return searchPlans({
    candidates: templates({ nowUs: state.nowUs, catalog: CONTROLS.catalog, state }),
    validate: p => validateTimedPlan(p, { nowUs: state.nowUs, gridUs: CONTROLS.gridUs, resources: RES, allocated }),
    evaluate: p => evaluatePlan(p, { preview, horizonUs: CONTROLS.horizonUs, scenarios: CONTROLS.scenarios }),
    budget: CONTROLS.budget,
  });
}

test('cross-domain tradeoff: with high storage the planner uses storage to preserve the generator reserve', { skip }, async t => {
  const town = await townAt(t, CONTROLS.cases.find(c => c.caseId === 'pc-high-storage'));
  const r = await decide(town);
  const byId = Object.fromEntries(r.ranking.map(x => [x.plan.planId, x]));
  assert.match(r.best.plan.planId, /^generator-pause/);
  assert.equal(r.best.worst.outcome.waterEssentialUnmetM3, 0);
  assert.deepEqual(r.best.key.slice(0, 4), byId.generator.key.slice(0, 4)); // equal in the worst (late-restoration) scenario
  assert.ok(r.best.key[4] < byId.generator.key[4], 'less generator fuel on average over the declared restoration scenarios');
  assert.ok(byId['retain-policy'].key[0] > 0, 'doing nothing loses essential water');
});

test('opposite case: with lower measured storage the same shift is harmful and is not chosen', { skip }, async t => {
  const town = await townAt(t, CONTROLS.cases.find(c => c.caseId === 'pc-lower-storage'));
  const r = await decide(town);
  const byId = Object.fromEntries(r.ranking.map(x => [x.plan.planId, x]));
  assert.equal(r.best.plan.planId, 'generator');
  assert.ok(byId['generator-pause-3600s'].key[0] > 0, 'pausing would breach essential water');
});

test('a second fault between actions expires the remainder; state is read and the town replans without rollback', { skip }, async t => {
  const c = CONTROLS.cases.find(x => x.caseId === 'pc-second-fault');
  const town = await townAt(t, c);
  const plan = (await decide(town)).best.plan;
  assert.ok(plan.steps.length >= 2);
  let replanInput = null;
  const r = await runTimedPlan({ town, plan, untilUs: CONTROLS.decisionAtUs + CONTROLS.horizonUs, gridUs: CONTROLS.gridUs,
    replan: async input => { replanInput = input; return decide(town); } });
  assert.equal(r.expiredAtUs, 3600 * S);
  assert.ok(r.log.some(x => x.status === 'expired'));
  assert.ok(r.log.some(x => x.status === 'delivered'));
  const state = await town.state();
  assert.equal(state.resources['gen-portable'].allocatedTo, 'pump-station'); // completed steps stand: no invented rollback
  assert.ok(replanInput && replanInput.nowUs === 3600 * S);
  assert.equal(r.replanned.best.plan.planId, 'resume-station', 'the replan restores the setting the expired step would have restored');
  assert.ok(!r.replanned.ranking.some(x => x.plan.steps.some(s => s.action.type === 'allocate_generator')), 'the allocated generator is not allocated again');
});
