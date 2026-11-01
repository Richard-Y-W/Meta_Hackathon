import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInventory, candidatePaths, loads, essentialDemandBps, backgroundWireBps } from '../../src/lifeline/controllers/common.mjs';
import { createPriorityController } from '../../src/lifeline/controllers/priority.mjs';
import { createAdaptiveController, CapacityBeliefs } from '../../src/lifeline/controllers/adaptive.mjs';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const SCENARIO = read('../../fixtures/lifeline/development/cascade.json');
const POLICY = read('../../fixtures/lifeline/policy-v1.json');
const ORACLES = read('../../fixtures/lifeline/development/controller-oracles.json');
const INV = buildInventory(SCENARIO, POLICY);
const LINK_IDS = INV.topology.links.map(l => l.linkId);

function observation({ down = [], stale = false, seq = 10, at = 30_000 } = {}) {
  return { version: 'ObservationV1', runId: 'run-1', seq, collectedAtMs: at, ageMs: 5, stale, configRevision: 1,
    links: Object.fromEntries(LINK_IDS.map(id => [id, { state: down.includes(id) ? 'down' : 'up' }])), services: {} };
}

const reference = () => Object.fromEntries(INV.essential.map(f => [f.flowId, { version: 0, path: INV.reference[f.flowId].primary, ackPath: INV.reference[f.flowId].ackPrimary }]));
const scheduled = () => Object.fromEntries(INV.background.map(s => [s.sourceId, s.scheduledBps]));

// Rates: on-time fraction per flow, and measured per-directed-link throughput/backlog for saturation.
function rates({ onTime = {}, links = {} } = {}) {
  const services = Object.fromEntries(INV.essential.map(f => [f.flowId, { recentOnTimeFraction: onTime[f.flowId] ?? 1, retransmissionRatio: 1 }]));
  return { links, services };
}

function state(o = {}) {
  return { observation: observation(o.obs), rates: o.rates ?? rates(), routes: o.routes ?? reference(), backgroundRates: o.backgroundRates ?? scheduled(), nowMs: o.nowMs ?? 30_000, remaining: o.remaining ?? { interventionBundles: 12, incidentProbeBytes: 262_144 } };
}

const routeOf = intent => Object.fromEntries((intent?.actions ?? []).filter(a => a.type === 'set_route').map(a => [a.flowId, a.path]));

// Decide until a non-probe intent appears, answering probes as clean, as persistence requires repeated samples.
function settle(c, base, steps = 5) {
  for (let i = 0; i < steps; i++) {
    const nowMs = base.nowMs + i * 500;
    const intent = c.decide({ ...base, nowMs });
    if (intent?.actions?.[0]?.type === 'probe_path') {
      c.applied(intent, { status: 'confirmed', nowMs, receipts: [{ status: 'confirmed', measurement: { lossFraction: 0, sent: 16, received: 16 } }] });
      continue;
    }
    if (intent) return intent;
  }
  return null;
}

test('candidate paths: at most three simple paths, shortest first, deterministic ties', () => {
  assert.deepEqual(candidatePaths(INV.topology, 'r0', 'r3'), [['r0', 'r3'], ['r0', 'r1', 'r2', 'r3'], ['r0', 'r1', 'r4', 'r3']]);
  assert.equal(candidatePaths(INV.topology, 'r0', 'r3', 10).every(p => new Set(p).size === p.length), true);
});

test('declared demands match the oracle arithmetic', () => {
  assert.equal(essentialDemandBps(INV.essential[0]), 682_240);
  assert.ok(Math.abs(backgroundWireBps(INV.background.find(s => s.sourceId === 'bulk-field'), 6_500_000) - 6_727_500) < 1);
});

for (const make of [createPriorityController, createAdaptiveController]) {
  const name = make.name.replace('create', '');

  test(`${name}: no fault means no action`, () => {
    const c = make(INV, POLICY);
    assert.equal(c.decide(state()), null);
    assert.equal(c.decide(state({ nowMs: 31_000 })), null);
  });

  test(`${name}: stale telemetry means no action`, () => {
    const c = make(INV, POLICY);
    assert.equal(c.decide(state({ obs: { down: ['r0-r3'], stale: true } })), null);
  });

  test(`${name}: a complete partition is reported unavailable without consuming an action`, () => {
    const c = make(INV, POLICY);
    const intent = c.decide(state({ obs: { down: ['r2-r3', 'r3-r4', 'r0-r3'] } }));
    assert.equal(intent?.actions ?? null, null);
    assert.deepEqual(c.unavailable().sort(), ['dispatch-clinic', 'field-clinic']);
  });

  test(`${name}: losing primary and backup produces a feasible route with a matching acknowledgement path`, () => {
    const c = make(INV, POLICY);
    const intent = c.decide(state({ obs: { down: ['r0-r3', 'r1-r2'] } })); // an outage acts without waiting for persistence
    const action = intent.actions.find(a => a.type === 'set_route' && a.flowId === 'dispatch-clinic');
    assert.deepEqual(action.path, ORACLES.cases.doubleOutage[name === 'PriorityController' ? 'priority' : 'adaptive']['dispatch-clinic']);
    assert.deepEqual(action.ackPath, [...action.path].reverse());
    // On version 0 the effective old path is the failed-over backup, whose broken link is r1-r2.
    assert.ok(intent.preconditions.some(p => p.kind === 'link_state' && p.linkId === 'r1-r2' && p.state === 'down'));
  });

  test(`${name}: hysteresis holds off a second change to the same flow`, () => {
    const c = make(INV, POLICY);
    const first = c.decide(state({ obs: { down: ['r0-r3', 'r1-r2'] } }));
    c.applied(first, { nowMs: 30_000, status: 'confirmed' });
    const moved = { ...reference(), 'dispatch-clinic': { version: 1, path: routeOf(first)['dispatch-clinic'], ackPath: [...routeOf(first)['dispatch-clinic']].reverse() } };
    const second = c.decide(state({ obs: { down: ['r0-r3', 'r1-r2'] }, routes: moved, nowMs: 31_000 }));
    assert.equal(routeOf(second)['dispatch-clinic'], undefined); // field-clinic's broken ack path may still be fixed
  });

  test(`${name}: background shedding stays within policy bounds and never touches essential sources`, () => {
    const c = make(INV, POLICY);
    const congested = state({ obs: { down: ['r0-r3'] }, routes: { ...reference(), 'dispatch-clinic': { version: 1, path: ['r0', 'r1', 'r2', 'r3'], ackPath: ['r3', 'r2', 'r1', 'r0'] } },
      rates: rates({ onTime: { 'dispatch-clinic': 0.6, 'field-clinic': 0.62 }, links: { 'r1-r2': { r1: { txBps: 7_900_000, backlogBytes: 120_000, dropsPerS: 30 } } } }) });
    let intent = c.decide(congested);
    if (!intent?.actions?.some(a => a.type === 'set_background_rate')) intent = c.decide({ ...congested, nowMs: 30_500 }); // persistence
    for (const action of intent?.actions ?? []) {
      if (action.type !== 'set_background_rate') continue;
      const source = INV.background.find(s => s.sourceId === action.sourceId);
      assert.ok(source, 'only registered background sources');
      assert.ok(action.bitsPerSecond >= source.minBps && action.bitsPerSecond <= source.scheduledBps);
    }
    assert.ok(intent, 'congestion on an essential path produces an intervention');
  });
}

test('priority: no background is shed for flows that have no feasible path', () => {
  const c = createPriorityController(INV, POLICY);
  const cut = o => state({ nowMs: o, obs: { down: ['r2-r3', 'r3-r4', 'r0-r3'] }, rates: rates({ onTime: { 'dispatch-clinic': 0, 'field-clinic': 0 } }) });
  assert.equal(c.decide(cut(30_000)), null);
  assert.equal(c.decide(cut(30_500)), null);
});

test('priority: a single outage already handled by reference fast-failover needs no action', () => {
  const c = createPriorityController(INV, POLICY);
  assert.equal(c.decide(state({ obs: { down: ['r0-r3'] } })), null);
});

test('adaptive: after reference failover overloads the ring, it moves both clinic flows to the minimum-peak plan', () => {
  const c = createAdaptiveController(INV, POLICY);
  const intent = settle(c, state({ obs: { down: ['r0-r3'] } }));
  assert.deepEqual(routeOf(intent), ORACLES.cases.outage.adaptive);
});

test('adaptive: headroom alone never triggers a change in a healthy network', () => {
  const c = createAdaptiveController(INV, POLICY);
  assert.equal(settle(c, state()), null);
});

test('priority: overload persists one sample before shedding, then sheds the background sharing the path', () => {
  const c = createPriorityController(INV, POLICY);
  const congested = o => state({ nowMs: o, rates: rates({ onTime: { 'field-clinic': 0.5 }, links: { 'r1-r2': { r1: { txBps: 3_000_000, backlogBytes: 200_000, dropsPerS: 80 } } } }) });
  assert.equal(c.decide(congested(30_000)), null);
  const intent = c.decide(congested(30_500));
  assert.deepEqual(intent.actions.map(a => [a.type, a.sourceId, a.bitsPerSecond]), [['set_background_rate', 'bulk-field', 500_000]]);
});

test('adaptive: a saturated link narrows the capacity belief to measured throughput; idle links keep nominal', () => {
  const beliefs = new CapacityBeliefs(INV);
  beliefs.update(observation(), rates({ links: { 'r1-r2': { r1: { txBps: 2_950_000, backlogBytes: 200_000, dropsPerS: 60 } }, 'r0-r1': { r0: { txBps: 1_000_000, backlogBytes: 0, dropsPerS: 0 } } } }));
  const [lo, hi] = beliefs.interval('r1>r2');
  assert.ok(lo >= 2_600_000 && lo <= 2_950_000 && hi <= 3_300_000, `${lo} ${hi}`);
  assert.deepEqual(beliefs.interval('r0>r1'), [1_000_000, 8_000_000]);
  beliefs.update(observation({ down: ['r1-r2'] }), rates());
  assert.deepEqual(beliefs.interval('r1>r2'), [0, 0]);
});

test('adaptive: the overload oracle moves field-clinic off the saturated link', () => {
  const c = createAdaptiveController(INV, POLICY);
  const sat = { links: { 'r1-r2': { r1: { txBps: 2_950_000, backlogBytes: 220_000, dropsPerS: 70 } } }, onTime: { 'field-clinic': 0.3 } };
  assert.equal(c.decide(state({ rates: rates(sat), nowMs: 30_000 })), null); // one sample is not persistent
  let intent = c.decide(state({ rates: rates(sat), nowMs: 30_500 }));
  if (intent?.actions?.[0]?.type === 'probe_path') {
    // An unmeasured candidate is probed before essential traffic moves onto it.
    assert.deepEqual(intent.actions[0].path, ORACLES.cases.overload.adaptive['field-clinic']);
    c.applied(intent, { status: 'confirmed', nowMs: 31_000, receipts: [{ status: 'confirmed', measurement: { lossFraction: 0, sent: 16, received: 16 } }] });
    intent = c.decide(state({ rates: rates(sat), nowMs: 31_500 }));
  }
  assert.deepEqual(routeOf(intent), ORACLES.cases.overload.adaptive);
});

// Independent exhaustive reference: same objective, written as plain nested loops.
function bruteForce(inventory, capacity, observation) {
  const flows = inventory.essential;
  const upTopology = { ...inventory.topology, links: inventory.topology.links.filter(l => observation.links[l.linkId].state === 'up') };
  const options = flows.map(f => candidatePaths(upTopology, f.from, f.to));
  const grids = inventory.background.map(s => [s.scheduledBps, s.scheduledBps / 2, s.scheduledBps / 4, s.minBps]);
  let best = null;
  const choose = (i, routes) => {
    if (i < flows.length) { for (const p of options[i]) choose(i + 1, { ...routes, [flows[i].flowId]: { path: p, ackPath: [...p].reverse() } }); return; }
    const bg = (j, rates) => {
      if (j < inventory.background.length) { for (const r of grids[j]) bg(j + 1, { ...rates, [inventory.background[j].sourceId]: r }); return; }
      const load = loads({ inventory, routes, rates, observation });
      const fits = path => path.slice(1).every((n, k) => (load[`${path[k]}>${n}`] ?? 0) <= 0.95 * capacity(`${path[k]}>${n}`));
      const ok = flows.map(f => fits(routes[f.flowId].path) && fits(routes[f.flowId].ackPath));
      const score = [flows.reduce((s, f, k) => s + (ok[k] ? 10 ** (3 - f.priority) : 0), 0), Object.values(rates).reduce((a, b) => a + b, 0)];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { score, routes, rates };
    };
    bg(0, {});
  };
  choose(0, {});
  return best;
}

test('adaptive: its search reaches the exhaustive optimum on known-capacity instances', () => {
  const nominal = key => { const [a, b] = key.split('>'); return INV.nominalCapacityBps[INV.topology.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a)).linkId]; };
  for (const down of [[], ['r0-r3'], ['r0-r3', 'r1-r4'], ['r2-r3']]) {
    const obs = observation({ down });
    const want = bruteForce(INV, nominal, obs);
    const c = createAdaptiveController(INV, POLICY);
    const got = c.plan(obs, rates(), reference(), scheduled());
    assert.equal(got.score[0], want.score[0], `essential score for down=${down}`);
    assert.ok(got.score[1] >= want.score[1] - 1, `background score for down=${down}`);
    assert.equal(got.exhaustive, true);
  }
});

test('adaptive: an idle link reporting zero throughput is not capacity evidence', () => {
  const beliefs = new CapacityBeliefs(INV);
  beliefs.update(observation(), rates({ links: { 'r1-r4': { r1: { txBps: 0, backlogBytes: 0, dropsPerS: 0 } }, 'r3-r4': { r4: { txBps: 4_100_000, backlogBytes: 0, dropsPerS: 0 } } } }));
  assert.equal(beliefs.measured('r1>r4'), false);
  assert.equal(beliefs.measured('r4>r3'), true);
});

test('adaptive: a persistently degraded flow with no capacity explanation is probed elsewhere, then moved', () => {
  const c = createAdaptiveController(INV, POLICY);
  // Counters on r2 are missing and nothing is saturated, yet field-clinic keeps missing deadlines.
  const silent = state({ rates: rates({ onTime: { 'field-clinic': 0.7 } }) });
  let intent = null;
  for (let i = 0; i < 6 && !intent; i++) intent = c.decide({ ...silent, nowMs: 30_000 + i * 500 });
  assert.equal(intent.actions[0].type, 'probe_path');
  assert.equal(intent.actions[0].sourceId, 'field');
  assert.notDeepEqual(intent.actions[0].path, ['r1', 'r2', 'r3']);
  c.applied(intent, { status: 'confirmed', nowMs: 33_000, receipts: [{ status: 'confirmed', measurement: { lossFraction: 0, sent: 16, received: 16 } }] });
  const move = c.decide({ ...silent, nowMs: 33_500 });
  assert.deepEqual(move.actions.map(a => [a.type, a.flowId]), [['set_route', 'field-clinic']]);
  assert.deepEqual(move.actions[0].path, intent.actions[0].path);
  assert.ok(move.preconditions.some(p => p.kind === 'service_on_time_below' && p.flowId === 'field-clinic'));
});

test('adaptive: a lossy alternative probe is not followed, and a briefly degraded flow is left alone', () => {
  const c = createAdaptiveController(INV, POLICY);
  const silent = state({ rates: rates({ onTime: { 'field-clinic': 0.7 } }) });
  let intent = null;
  for (let i = 0; i < 6 && !intent; i++) intent = c.decide({ ...silent, nowMs: 30_000 + i * 500 });
  c.applied(intent, { status: 'confirmed', nowMs: 33_000, receipts: [{ status: 'confirmed', measurement: { lossFraction: 0.4, sent: 16, received: 10 } }] });
  const next = c.decide({ ...silent, nowMs: 33_500 });
  assert.ok(!next || next.actions[0].type === 'probe_path');
  if (next) assert.notDeepEqual(next.actions[0].path, intent.actions[0].path);
  const fresh = createAdaptiveController(INV, POLICY);
  assert.equal(fresh.decide({ ...silent, nowMs: 30_000 }), null);
  assert.equal(fresh.decide({ ...silent, nowMs: 30_500 }), null);
});

test('adaptive: a plan the guard refused is not re-proposed unchanged for a hold period', () => {
  const c = createAdaptiveController(INV, POLICY);
  const s = t => state({ obs: { down: ['r0-r3', 'r1-r2'] }, nowMs: t });
  const first = c.decide(s(30_000));
  assert.ok(first, 'an outage produces a plan');
  c.applied(first, { status: 'rejected', code: 'action_rejected', nowMs: 30_000 });
  assert.equal(c.decide(s(33_000)), null, 'identical plan suppressed after rejection');
  assert.equal(c.decide(s(44_000)), null);
  const again = c.decide(s(45_500));
  assert.deepEqual(again?.actions, first.actions, 'retried once the hold has passed');
});
