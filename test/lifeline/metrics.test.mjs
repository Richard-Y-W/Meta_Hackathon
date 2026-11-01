import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreMessages, scoreBackground } from '../../src/lifeline/metrics.mjs';

test('lost and late messages remain in the offered denominator', () => {
  const result = scoreMessages({
    offered: [
      { id: 'a', createdAtMs: 0, deadlineMs: 500 },
      { id: 'b', createdAtMs: 0, deadlineMs: 500 },
      { id: 'c', createdAtMs: 0, deadlineMs: 500 },
    ],
    receipts: [
      { id: 'a', receivedAtMs: 500 },
      { id: 'a', receivedAtMs: 501 },
      { id: 'b', receivedAtMs: 501 },
    ],
    fromMs: 0,
    toMs: 1000,
  });
  assert.equal(result.offered, 3);
  assert.equal(result.onTime, 1);
  assert.equal(result.late, 1);
  assert.equal(result.lost, 1);
  assert.equal(result.duplicateReceipts, 1);
  assert.equal(result.deliveryRate, 1 / 3);
});

const HAND = JSON.parse(readFileSync(new URL('../../fixtures/lifeline/development/scoring-hand-calculated.json', import.meta.url), 'utf8'));

test('the hand-calculated fixture matches the scorer, including per-flow results', () => {
  const { offered, receipts, fromMs, toMs, captureThroughMs, handCalculated: expected } = HAND;
  const result = scoreMessages({ offered, receipts, fromMs, toMs, captureThroughMs });
  for (const key of ['offered', 'onTime', 'late', 'lost', 'duplicateReceipts', 'invalidReceipts', 'unknownReceipts', 'deliveryRate']) {
    assert.equal(result[key], expected[key], key);
  }
  assert.deepEqual(result.byFlow, expected.byFlow);
});

test('receipt order does not matter; the earliest valid receipt decides', () => {
  const offered = [{ id: 'a', createdAtMs: 0, deadlineMs: 100 }];
  const late = scoreMessages({ offered, receipts: [{ id: 'a', receivedAtMs: 300 }, { id: 'a', receivedAtMs: 50 }], fromMs: 0, toMs: 10, captureThroughMs: 1000 });
  assert.equal(late.onTime, 1);
  assert.equal(late.duplicateReceipts, 1);
});

test('retries keep one logical message: a retried delivery counts once', () => {
  const offered = [{ id: 'a', createdAtMs: 0, deadlineMs: 500 }];
  const receipts = [{ id: 'a', receivedAtMs: 420 }, { id: 'a', receivedAtMs: 430 }, { id: 'a', receivedAtMs: 650 }];
  const result = scoreMessages({ offered, receipts, fromMs: 0, toMs: 10, captureThroughMs: 1000 });
  assert.deepEqual([result.offered, result.onTime, result.duplicateReceipts], [1, 1, 2]);
});

test('unknown receipt IDs never inflate delivery', () => {
  const result = scoreMessages({ offered: [{ id: 'a', createdAtMs: 0, deadlineMs: 500 }], receipts: [{ id: 'zz', receivedAtMs: 10 }], fromMs: 0, toMs: 10, captureThroughMs: 1000 });
  assert.deepEqual([result.onTime, result.lost, result.unknownReceipts], [0, 1, 1]);
});

test('duplicate offered IDs make the workload invalid', () => {
  const offered = [{ id: 'a', createdAtMs: 0, deadlineMs: 500 }, { id: 'a', createdAtMs: 5, deadlineMs: 500 }];
  assert.throws(() => scoreMessages({ offered, receipts: [], fromMs: 0, toMs: 10 }), err => err.code === 'workload_invalid' && err.detail === 'duplicate_offered_id');
});

test('malformed records are rejected rather than scored', () => {
  for (const offered of [[{ id: 'a', createdAtMs: NaN, deadlineMs: 500 }], [{ id: 'a', createdAtMs: 0, deadlineMs: -1 }], [{ id: '', createdAtMs: 0, deadlineMs: 5 }]]) {
    assert.throws(() => scoreMessages({ offered, receipts: [], fromMs: 0, toMs: 10 }), err => err.code === 'workload_invalid');
  }
  assert.throws(() => scoreMessages({ offered: [], receipts: [{ id: 'a', receivedAtMs: Infinity }], fromMs: 0, toMs: 10 }), err => err.code === 'workload_invalid');
  assert.throws(() => scoreMessages({ offered: [], receipts: [], fromMs: 10, toMs: 0 }), err => err.code === 'workload_invalid');
});

test('zero offered messages yield a null rate, never 100%', () => {
  const result = scoreMessages({ offered: [], receipts: [], fromMs: 0, toMs: 1000 });
  assert.equal(result.offered, 0);
  assert.equal(result.deliveryRate, null);
});

test('window boundaries: createdAt == fromMs is included, createdAt == toMs is excluded, receipt at deadline is on time', () => {
  const offered = [{ id: 'in', createdAtMs: 100, deadlineMs: 50 }, { id: 'out', createdAtMs: 200, deadlineMs: 50 }];
  const receipts = [{ id: 'in', receivedAtMs: 150 }, { id: 'out', receivedAtMs: 210 }];
  const result = scoreMessages({ offered, receipts, fromMs: 100, toMs: 200, captureThroughMs: 300 });
  assert.deepEqual([result.offered, result.onTime, result.unknownReceipts], [1, 1, 0]);
});

test('an incomplete receiver capture is run_incomplete, not network loss', () => {
  const offered = [{ id: 'a', createdAtMs: 900, deadlineMs: 500 }];
  // The capture must extend through the largest deadline (1400); stopping at toMs is not enough.
  assert.throws(() => scoreMessages({ offered, receipts: [], fromMs: 0, toMs: 1000 }), err => err.code === 'run_incomplete' && err.detail === 'receiver_capture_incomplete');
  assert.throws(() => scoreMessages({ offered, receipts: [], fromMs: 0, toMs: 1000, captureThroughMs: 1399 }), err => err.code === 'run_incomplete');
  assert.equal(scoreMessages({ offered, receipts: [], fromMs: 0, toMs: 1000, captureThroughMs: 1400 }).lost, 1);
});

test('a sender manifest that disagrees with the offered records is run_incomplete', () => {
  const offered = [{ id: 'a', createdAtMs: 0, deadlineMs: 5 }];
  assert.throws(() => scoreMessages({ offered, receipts: [], fromMs: 0, toMs: 10, senderManifest: { complete: false, count: 1 } }), err => err.code === 'run_incomplete' && err.detail === 'sender_manifest_incomplete');
  assert.throws(() => scoreMessages({ offered, receipts: [], fromMs: 0, toMs: 10, senderManifest: { complete: true, count: 2 } }), err => err.code === 'run_incomplete' && err.detail === 'sender_manifest_mismatch');
});

test('the scorer does not mutate its inputs', () => {
  const input = structuredClone({ offered: HAND.offered, receipts: HAND.receipts });
  scoreMessages({ ...input, fromMs: HAND.fromMs, toMs: HAND.toMs, captureThroughMs: HAND.captureThroughMs });
  assert.deepEqual(input, { offered: HAND.offered, receipts: HAND.receipts });
});

// A separately written reference: brute force over every offered message, no maps or sorting.
function reference({ offered, receipts, fromMs, toMs }) {
  let n = 0, onTime = 0, late = 0, lost = 0;
  for (const m of offered) {
    if (m.createdAtMs < fromMs || m.createdAtMs >= toMs) continue;
    n++;
    let earliest = null;
    for (const r of receipts) if (r.id === m.id && r.receivedAtMs >= m.createdAtMs && (earliest === null || r.receivedAtMs < earliest)) earliest = r.receivedAtMs;
    if (earliest === null) lost++;
    else if (earliest <= m.createdAtMs + m.deadlineMs) onTime++;
    else late++;
  }
  return { offered: n, onTime, late, lost, deliveryRate: n ? onTime / n : null };
}

test('randomized cross-check against the independent reference calculation', () => {
  let seed = 20261031;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let trial = 0; trial < 200; trial++) {
    const offered = Array.from({ length: Math.floor(rand() * 40) }, (_, i) => ({ id: `m${i}`, createdAtMs: Math.floor(rand() * 2000), deadlineMs: 100 + Math.floor(rand() * 500) }));
    const receipts = [];
    for (const m of offered) for (let k = Math.floor(rand() * 4); k > 0; k--) receipts.push({ id: m.id, receivedAtMs: m.createdAtMs - 50 + Math.floor(rand() * 900) });
    for (let k = Math.floor(rand() * 3); k > 0; k--) receipts.push({ id: `ghost${k}`, receivedAtMs: Math.floor(rand() * 3000) });
    receipts.sort(() => rand() - 0.5);
    const window = { fromMs: 500, toMs: 1500 };
    const got = scoreMessages({ offered, receipts, ...window, captureThroughMs: 4000 });
    const want = reference({ offered, receipts, ...window });
    for (const key of Object.keys(want)) assert.equal(got[key], want[key], `trial ${trial} ${key}`);
  }
});

test('background throughput keeps the independently scheduled denominator after throttling', () => {
  const offered = [0, 1000, 2000, 3000].map(atMs => ({ sourceId: 'bulk-shelter', atMs, bytes: 1_000_000 }));
  // Throttled at 2000: the sender transmits half, and the schedule still counts the full demand.
  const delivered = [{ sourceId: 'bulk-shelter', atMs: 100, bytes: 1_000_000 }, { sourceId: 'bulk-shelter', atMs: 1100, bytes: 1_000_000 },
    { sourceId: 'bulk-shelter', atMs: 2100, bytes: 500_000 }, { sourceId: 'bulk-shelter', atMs: 3100, bytes: 500_000 }];
  const result = scoreBackground({ offered, delivered, fromMs: 0, toMs: 4000 });
  assert.equal(result.offeredBytes, 4_000_000);
  assert.equal(result.deliveredBytes, 3_000_000);
  assert.equal(result.deliveredFraction, 0.75);
  assert.equal(scoreBackground({ offered: [], delivered: [], fromMs: 0, toMs: 1 }).deliveredFraction, null);
});
