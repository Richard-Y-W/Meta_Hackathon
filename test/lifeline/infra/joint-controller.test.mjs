// P13: conventional joint comparators on the coupled town (town environment; skips with a reason if absent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATALOG, exhaustiveSchedules, independent, priority, rolling, runTownEpisode } from '../../../src/lifeline/controllers/joint.mjs';
import { spawnTownWorker } from '../../../src/lifeline/domains/town.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const skip = existsSync(`${ROOT}.work/environments/town/bin/python`) ? false : 'town environment not found';
const POLICY = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/town/baseline-policy.json', import.meta.url), 'utf8'));
const CASE = Object.fromEntries(POLICY.cases.map(c => [c.caseId, c]));
const S = 1_000_000;

test('the joint comparator has every capability the town accepts (none withheld)', { skip }, async t => {
  const town = spawnTownWorker({ root: ROOT });
  t.after(() => town.close());
  await town.initialize({ caseId: 't-no-fault' });
  const town_ = await town.capabilities();
  assert.deepEqual([...CATALOG.capabilities].sort(), town_.commands.sort());
  // Assets too: run 0 of the comparison found tie S2 missing from the planner's catalog, and the
  // independent controller beat the optimizer by closing it.
  for (const kind of ['switches', 'pumps', 'links', 'resources']) assert.deepEqual([...CATALOG[kind]].sort(), town_[kind].sort(), kind);
});

test('no-fault control: no comparator loses service or spends reserve', { skip }, async () => {
  for (const make of [independent, priority]) {
    const r = await runTownEpisode({ root: ROOT, policy: POLICY, c: CASE['b-no-fault'], controller: make(POLICY), advisory: null });
    assert.equal(r.waterEssentialUnmetM3, 0, r.controller);
    assert.equal(r.powerEssentialUnservedJ, 0, r.controller);
    assert.equal(r.fuelUsedJ, 0, r.controller);
    // Every decision's wall time is charged on the accelerated town clock (rounded up to the 60 s grid).
    assert.equal(r.clock.acceleration, 60);
    for (const d of r.decisions) {
      assert.equal(d.chargedUs, Math.ceil(d.wallSeconds * 60 * S / POLICY.gridUs) * POLICY.gridUs);
      assert.equal(d.availableUs, d.atUs + d.chargedUs);
    }
  }
});

test('the rolling optimizer\'s first decision matches exhaustive search over the finite schedule space', { skip }, async t => {
  const town = spawnTownWorker({ root: ROOT });
  t.after(() => town.close());
  const c = CASE['b-high-storage'];
  await town.initialize({ caseId: 't-no-fault', faults: c.faults, tankInitialLevels: c.tankInitialLevels });
  await town.advance(1860 * S);
  const scenarios = POLICY.advisory.etaScenarios;
  const exhaustive = await exhaustiveSchedules({ town, nowUs: 1860 * S, gridUs: POLICY.gridUs, horizonUs: POLICY.durationUs - 1860 * S, scenarios, slots: 2 });
  assert.equal(exhaustive.evaluated, 4 * 3 * 4); // no tie or one of three ties x dispatch now / in 1 h / never x 2 slots of station mode
  const plan = await rolling(POLICY).decide({ town, nowUs: 1860 * S, advisory: POLICY.advisory });
  const tieOf = steps => steps.find(x => x.action.type === 'set_switch')?.action.params.switchId ?? null;
  assert.equal(exhaustive.best.key[0], 0, 'the finite space serves all essential water');
  assert.equal(tieOf(plan.steps), tieOf(exhaustive.best.plan.steps), 'the same immediate tie closure as the exhaustive optimum');
  assert.equal(tieOf(plan.steps), 'sw-S2');
});

test('the oracle is labeled as a ceiling, never a comparator', () => {
  const o = rolling(POLICY, { oracleFaults: [] });
  assert.equal(o.name, 'oracle');
  assert.match(o.label, /ORACLE.*not deployable/);
  assert.equal(rolling(POLICY).oracle, false);
});

test('a step that becomes available runs before the next decision can replace it (P13 run 3 regression)', async () => {
  const S = 1_000_000, issued = [];
  let now = 0, wall = 0;
  const town = {
    initialize: async () => ({}), close: async () => ({}), advance: async t => { now = t; },
    state: async () => ({ nowUs: now, worldRevision: 0, revisions: { power: 0, water: 0 }, resources: { 'gen-portable': { fuelJ: 120e6 } } }),
    observe: async () => ({ clock: { acceleration: 60 }, readings: [], atUs: now, staleAfterUs: 0 }),
    command: async (domain, action) => { issued.push({ atUs: now, action }); return { status: 'delivered' }; },
    evaluatorTruth: async () => ({ water: { essentialUnmetM3: 0 }, power: { essentialUnservedJ: 0 } }),
  };
  // Each decision takes 60 s of wall time: charged 3600 s at 60x, exactly one decision period.
  const controller = { name: 'rolling', decide: async ({ nowUs }) => { wall += 60_000; return { planId: 'p', replaceFuture: true, steps: [{ id: `s${nowUs}`, domain: 'power', action: { type: 'set_switch', params: { switchId: 'sw-S2', closed: true } }, atUs: nowUs }] }; } };
  const policy = { durationUs: 3 * 3600 * S, gridUs: 60 * S, periodUs: 3600 * S };
  const r = await runTownEpisode({ policy, c: { faults: [] }, controller, makeTown: () => town, wallClock: () => wall });
  assert.deepEqual(issued.map(i => i.atUs), [3600 * S, 7200 * S, 10800 * S]);
  assert.ok(r.decisions.every(d => d.chargedUs === 3600 * S));
});

test('the independent rule tries the next tie promptly while the buses stay dead (P13 run 5 baseline fix)', async () => {
  const S = 1_000_000;
  const c = independent(POLICY);
  const dead = nowUs => ({ atUs: nowUs, staleAfterUs: 120 * S, readings: [{ sensorId: 'power:v-bus-7', value: 0, observedAtUs: nowUs }, { sensorId: 'water:mains-pump-station', value: 1, observedAtUs: nowUs }] });
  const first = await c.decide({ nowUs: 1800 * S, obs: dead(1800 * S) });
  assert.deepEqual([first.steps.length, first.redecideAtUs], [0, 1920 * S]);
  const ties = [];
  for (const t of [1920, 2040, 2160]) {
    const p = await c.decide({ nowUs: t * S, obs: dead(t * S) });
    ties.push(p.steps[0].action.params.switchId);
    assert.equal(p.redecideAtUs, t * S + 120 * S);
  }
  assert.deepEqual(ties, ['sw-S1', 'sw-S3', 'sw-S2']);
});
