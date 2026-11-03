// P19: an ablation removes exactly one mechanism. It must not silently remove the rule layer (baseline
// recovery), change the candidate plans the planner can evaluate, or change what is observed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { advisoryFor, variants } from '../../../src/lifeline/controllers/ablations.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const S = 1_000_000;
const POLICY = JSON.parse(readFileSync(new URL('fixtures/lifeline/infra/town/baseline-policy.json', `file://${ROOT}`), 'utf8'));
const ADVISORY = { issuedAtUs: 0, etaScenarios: [{ label: 'eta-nominal', assume: [{ domain: 'power', faultId: 'eta', atUs: 7200 * S, type: 'line_restore', assetId: 'line-8-9' }] }] };

function fakeTown({ world = 1 } = {}) {
  const previewed = [], observed = [];
  return { previewed, observed,
    state: async () => ({ nowUs: 1800 * S, worldRevision: world, stationMode: 'auto', revisions: { power: world, water: 0 }, closedLinks: [], layout: { pumpStationBus: 'bus-10', backupPumpBus: 'bus-13', substationRouterBus: 'bus-13' },
      resources: { 'gen-portable': { allocatedTo: null, fuelJ: 120e6 } } }),
    observe: async () => { observed.push(1); return { atUs: 1800 * S, staleAfterUs: 120 * S, routers: {}, readings: [{ sensorId: 'water:lv-T1', assetId: 'T1', value: 2.5, observedAtUs: 1800 * S }], clock: { acceleration: 60 } }; },
    admittedModel: async () => ({ modelId: 'm1' }), receipts: async () => ({ receipts: [] }),
    preview: async (pl, modelId, assume) => { previewed.push(JSON.stringify({ steps: pl.steps.map(s => [s.domain, s.action, s.atUs]), assume })); return { waterEssentialUnmetM3: 0, powerEssentialUnservedJ: 0, waterNonessentialUnmetM3: 0, constraintSeconds: 0, fuelUsedJ: {}, firstEssentialLossUs: 5400 * S, events: [], receipts: [] }; },
  };
}
function make(spy = { calls: 0 }, slept = []) {
  const callModel = async () => { spy.calls++; return { code: 'ok', text: 'not json', durationMs: 1 }; };
  return variants(POLICY, { callModel, maxCalls: 6, providerCapS: 30, matchedDelayMs: 21_500, sleep: async ms => { slept.push(ms); } });
}

test('RED: every variant keeps the priority rule layer, except the declared no-coupling comparator', () => {
  for (const [name, f] of Object.entries(make())) {
    const c = f();
    if (name === 'independent') { assert.equal(c.layers, undefined); continue; }
    assert.equal(c.layers[0].name, 'priority', name);
    assert.equal(c.layers.length, 2, name);
  }
});

test('RED: planner variants evaluate the identical candidate set and observations as the conventional planner', async () => {
  const sets = {};
  for (const name of ['hybrid', 'meta-narrator', 'meta-latency-matched', 'meta-fixed-cadence']) {
    const town = fakeTown();
    const planner = make()[name]().layers[1];
    await planner.decide({ town, nowUs: 1800 * S, obs: await town.observe(), advisory: ADVISORY });
    // The Meta gate previews "retain" once before deciding to call; the candidate evaluations are the rest.
    sets[name] = [...new Set(town.previewed)].sort();
  }
  for (const name of ['meta-narrator', 'meta-latency-matched', 'meta-fixed-cadence']) assert.deepEqual(sets[name], sets.hybrid, name);
});

test('RED: matched latency waits the measured provider time and never reaches the provider', async () => {
  const spy = { calls: 0 }, slept = [];
  const planner = make(spy, slept)['meta-latency-matched']().layers[1];
  const town = fakeTown();
  await planner.decide({ town, nowUs: 1800 * S, obs: await town.observe(), advisory: ADVISORY });
  assert.equal(spy.calls, 0);
  assert.deepEqual(slept, [21_500]);
  assert.equal(planner.calls[0].code, 'latency_only');
});

test('RED: only the no-forecast variant loses the advisory; the fixed cadence calls without an incident', async () => {
  const v = make(), c = { advisory: ADVISORY };
  for (const [name, f] of Object.entries(v)) assert.equal(advisoryFor(f(), c), name === 'hybrid-no-forecast' ? null : ADVISORY, name);
  const quiet = fakeTown({ world: 0 });
  const spyA = { calls: 0 }, spyB = { calls: 0 };
  await make(spyA)['meta-fixed-cadence']().layers[1].decide({ town: quiet, nowUs: 0, obs: await quiet.observe(), advisory: null });
  await make(spyB)['meta-narrator']().layers[1].decide({ town: quiet, nowUs: 0, obs: await quiet.observe(), advisory: null });
  assert.deepEqual([spyA.calls, spyB.calls], [1, 0]);
});
