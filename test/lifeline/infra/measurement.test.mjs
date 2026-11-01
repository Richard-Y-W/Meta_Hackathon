import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreService, recoveryTime, facilityScore, scoreCommunications } from '../../../src/lifeline/kernel/measurement.mjs';

const CASES = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/analytic-service-cases.json', import.meta.url), 'utf8'));
const close = (a, b, msg) => assert.ok(a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b))), `${msg}: ${a} vs ${b}`);

for (const c of CASES.cases) {
  test(`analytic case ${c.id}`, () => {
    const r = scoreService(c);
    for (const [k, v] of Object.entries(c.expected)) {
      if (Array.isArray(v)) v.forEach((x, i) => close(r[k][i], x, `${k}[${i}]`));
      else close(r[k], v, k);
    }
  });
}

test('censored recovery: a short excursion above threshold is not recovery', () => {
  const r = recoveryTime(CASES.recovery);
  assert.equal(r.recovered, CASES.recovery.expected.recovered);
  assert.equal(r.censoredAtUs, CASES.recovery.expected.censoredAtUs);
  const sustained = recoveryTime({ ...CASES.recovery, endUs: 70_000_000 });
  assert.deepEqual([sustained.recovered, sustained.recoveredAtUs], [true, 50_000_000]);
});

test('two retries of one message cannot count as two served messages', () => {
  const offered = [{ id: 'm1', createdAtMs: 0, deadlineMs: 500 }];
  const receipts = [{ id: 'm1', receivedAtMs: 100 }, { id: 'm1', receivedAtMs: 350 }];
  const r = scoreCommunications({ offered, receipts, fromMs: 0, toMs: 10, captureThroughMs: 1000 });
  assert.deepEqual([r.offered, r.onTime, r.duplicateReceipts], [1, 1, 1]);
});

test('missing capture and method-caused loss have different statuses', () => {
  const loss = scoreService({ metric: 'power.active', demand: [{ fromUs: 0, toUs: 1_000_000, value: 100 }], supply: [{ atUs: 0, value: 0 }], fromUs: 0, toUs: 1_000_000 });
  const missing = scoreService({ metric: 'power.active', demand: [{ fromUs: 0, toUs: 1_000_000, value: 100 }], supply: [{ atUs: 0, value: null }], fromUs: 0, toUs: 1_000_000 });
  assert.equal(loss.status, 'scored');
  assert.equal(loss.score, 0);
  assert.equal(missing.status, 'capture_incomplete');
  assert.equal(missing.score, null);
});

test('a facility composite keeps every component beside it, exposing double counting', () => {
  const water = scoreService(CASES.cases[1]);
  const power = scoreService(CASES.cases[0]);
  const f = facilityScore({ facilityId: 'clinic', components: { power, water }, weights: { power: 0.5, water: 0.5 } });
  assert.equal(f.components.power.score, 0.5);
  assert.equal(f.components.water.score, 0.6);
  close(f.weightedScore, 0.55, 'weighted');
  assert.equal(f.minimumScore, 0.5);
  assert.throws(() => facilityScore({ facilityId: 'x', components: { power }, weights: { power: 0.7 } }), /weights_must_sum_to_one/);
});

test('scores are recomputed from raw records only: controller explanations change nothing', () => {
  const c = CASES.cases[0];
  const noisy = { ...c, supply: c.supply.map(s => ({ ...s, controllerNote: 'we fixed it', claimedServed: 1e9 })), explanation: 'trust the model' };
  assert.deepEqual(scoreService(noisy), scoreService(c));
});

test('the measurement module imports no controller or model code', () => {
  const src = readFileSync(new URL('../../../src/lifeline/kernel/measurement.mjs', import.meta.url), 'utf8');
  assert.equal(/controllers\/|meta-provider|forecast|beliefs/.test(src), false);
});

test('malformed schedules are refused rather than scored', () => {
  assert.throws(() => scoreService({ metric: 'power.active', demand: [{ fromUs: 5, toUs: 1, value: 1 }], supply: [], fromUs: 0, toUs: 10 }), /invalid_schedule/);
  assert.throws(() => scoreService({ metric: 'power.active', demand: [{ fromUs: 0, toUs: 10, value: -1 }], supply: [], fromUs: 0, toUs: 10 }), /invalid_schedule/);
  assert.throws(() => scoreService({ metric: 'water.flow', demand: [{ fromUs: 0, toUs: 10, value: 1 }], supply: [{ atUs: 0, value: NaN }], fromUs: 0, toUs: 10 }), /invalid_supply/);
});
