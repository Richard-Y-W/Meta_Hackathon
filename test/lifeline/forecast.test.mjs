import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInventory } from '../../src/lifeline/controllers/common.mjs';
import { CapacityBeliefs } from '../../src/lifeline/beliefs.mjs';
import { forecast, onTimeInterval } from '../../src/lifeline/forecast.mjs';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const INV = buildInventory(read('../../fixtures/lifeline/development/cascade.json'), read('../../fixtures/lifeline/policy-v1.json'));
const IDS = INV.topology.links.map(l => l.linkId);
const obs = (down = [], seq = 1) => ({ seq, collectedAtMs: seq * 500, links: Object.fromEntries(IDS.map(id => [id, { state: down.includes(id) ? 'down' : 'up' }])) });
const ref = () => Object.fromEntries(INV.essential.map(f => [f.flowId, { path: INV.reference[f.flowId].primary, ackPath: INV.reference[f.flowId].ackPrimary }]));
const sched = () => Object.fromEntries(INV.background.map(s => [s.sourceId, s.scheduledBps]));

test('flow conservation: each directed link carries exactly the hand-summed demand', () => {
  const b = new CapacityBeliefs(INV);
  const f = forecast({ inventory: INV, beliefs: b, routes: ref(), rates: sched(), observation: obs() });
  // r1>r2: field-clinic 682,240 + bulk-field 6,727,500 (6.5 Mbit/s x 1242/1200).
  assert.ok(Math.abs(f.loads['r1>r2'] - (682_240 + 6_727_500)) < 1);
  // r3>r0: dispatch-clinic acks 52,480 + bulk-shelter 4,140,000.
  assert.ok(Math.abs(f.loads['r3>r0'] - (52_480 + 4_140_000)) < 1);
  const total = Object.values(f.loads).reduce((a, b) => a + b, 0);
  const expected = INV.essential.reduce((s, fl) => s + 682_240 * (ref()[fl.flowId].path.length - 1) + 52_480 * (ref()[fl.flowId].ackPath.length - 1), 0) + 6_727_500 * 2 + 4_140_000 * 2;
  assert.ok(Math.abs(total - expected) < 1);
});

test('capacity constraint: a saturated link measured at 2.95 Mbit/s predicts deadline failure for its essential flow', () => {
  const b = new CapacityBeliefs(INV);
  b.update(obs(), { links: { 'r1-r2': { r1: { txBps: 2_950_000, backlogBytes: 200_000, dropsPerS: 60 } } } });
  const f = forecast({ inventory: INV, beliefs: b, routes: ref(), rates: sched(), observation: obs() });
  const fc = f.flows.find(x => x.flowId === 'field-clinic');
  assert.ok(fc.peakUtilization.pessimistic > 2.5);
  assert.ok(fc.predictedOnTime[1] <= 0.1, JSON.stringify(fc));
  const dc = f.flows.find(x => x.flowId === 'dispatch-clinic');
  assert.deepEqual(dc.predictedOnTime, [0.95, 1]);
});

test('a healthy configuration predicts high delivery and names the links assumed at nominal capacity', () => {
  const f = forecast({ inventory: INV, beliefs: new CapacityBeliefs(INV), routes: ref(), rates: sched(), observation: obs() });
  for (const flow of f.flows) assert.ok(flow.predictedOnTime[0] >= 0.3 && flow.predictedOnTime[1] === 1);
  assert.ok(f.nominalAssumed.includes('r0>r3'));
  assert.equal(f.status, 'ok');
});

test('no path: a route over a down link predicts zero delivery', () => {
  const f = forecast({ inventory: INV, beliefs: new CapacityBeliefs(INV), routes: ref(), rates: sched(), observation: obs(['r0-r3']) });
  const dc = f.flows.find(x => x.flowId === 'dispatch-clinic');
  assert.deepEqual(dc.predictedOnTime, [0, 0]);
  assert.equal(dc.reason, 'link_down');
});

test('flows are reported in operator priority order', () => {
  const f = forecast({ inventory: INV, beliefs: new CapacityBeliefs(INV), routes: ref(), rates: sched(), observation: obs() });
  assert.deepEqual(f.flows.map(x => x.priority), [...f.flows.map(x => x.priority)].sort((a, b) => a - b));
});

test('an inconsistent belief cannot produce a forecast', () => {
  const b = new CapacityBeliefs(INV);
  b.update(obs(), { links: { 'r1-r2': { r1: { txBps: 5_000_000, backlogBytes: 0, dropsPerS: 0 } } } });
  b.applyProposedUpdate({ link: 'r1>r2', hiBps: 3_000_000, evidence: ['obs-7'] }, { 'obs-7': { links: { 'r1-r2': { r1: { txBps: 3_000_000, backlogBytes: 90_000, dropsPerS: 9 } } } } });
  const f = forecast({ inventory: INV, beliefs: b, routes: ref(), rates: sched(), observation: obs() });
  assert.equal(f.status, 'model_inconsistent');
  assert.equal(f.flows, undefined);
});

test('the utilization-to-delivery map is monotone and bounded', () => {
  let last = [1, 1];
  for (const u of [0, 0.5, 0.95, 1, 1.1, 1.3, 1.6, 3]) {
    const [lo, hi] = onTimeInterval(u);
    assert.ok(lo <= hi && lo >= 0 && hi <= 1);
    assert.ok(lo <= last[0] && hi <= last[1]);
    last = [lo, hi];
  }
});

test('the forecast has a stable identity for identical inputs', () => {
  const args = { inventory: INV, beliefs: new CapacityBeliefs(INV), routes: ref(), rates: sched(), observation: obs() };
  assert.equal(forecast(args).forecastId, forecast(args).forecastId);
  assert.notEqual(forecast(args).forecastId, forecast({ ...args, rates: { ...sched(), 'bulk-field': 500_000 } }).forecastId);
});
