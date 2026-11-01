import test from 'node:test';
import assert from 'node:assert/strict';
import { createArbiter } from '../../../src/lifeline/kernel/arbiter.mjs';

test('an investigation holds no locks, so immediate recovery is never blocked by an 18 s model call', () => {
  const a = createArbiter({ slots: 2 });
  const inv = a.beginInvestigation({ owner: 'meta', nowUs: 0 });
  assert.equal(inv.locks.length, 0);
  const rec = a.acquire({ owner: 'adaptive', planId: 'rec-1', priority: 'recovery', lockSet: ['r0', 'r3'], nowUs: 1_000 });
  assert.equal(rec.ok, true);
});

test('recovery preempts a lower-priority reservation that has not started; the preemption is recorded', () => {
  const a = createArbiter({ slots: 2 });
  assert.equal(a.acquire({ owner: 'meta', planId: 'sup-1', priority: 'supervisory', lockSet: ['r1', 'r4'], nowUs: 0 }).ok, true);
  const rec = a.acquire({ owner: 'adaptive', planId: 'rec-1', priority: 'recovery', lockSet: ['r4'], nowUs: 10 });
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.preempted, ['sup-1']);
  assert.ok(a.trace().some(t => t.event === 'preempted' && t.planId === 'sup-1' && t.by === 'rec-1'));
});

test('recovery waits only for an action already executing, never for a reservation', () => {
  const a = createArbiter({ slots: 2 });
  a.acquire({ owner: 'meta', planId: 'sup-1', priority: 'supervisory', lockSet: ['r4'], nowUs: 0 });
  a.markExecuting('sup-1');
  const rec = a.acquire({ owner: 'adaptive', planId: 'rec-1', priority: 'recovery', lockSet: ['r4'], nowUs: 10 });
  assert.deepEqual([rec.ok, rec.code, rec.waitFor], [false, 'lock_busy_executing', 'sup-1']);
  a.release('sup-1');
  assert.equal(a.acquire({ owner: 'adaptive', planId: 'rec-1', priority: 'recovery', lockSet: ['r4'], nowUs: 20 }).ok, true);
});

test('equal or lower priority cannot preempt; conflicting lock sets are detected', () => {
  const a = createArbiter({ slots: 3 });
  a.acquire({ owner: 'x', planId: 'p1', priority: 'supervisory', lockSet: ['r1'], nowUs: 0 });
  assert.equal(a.acquire({ owner: 'y', planId: 'p2', priority: 'supervisory', lockSet: ['r1', 'r2'], nowUs: 1 }).code, 'lock_conflict');
  assert.equal(a.acquire({ owner: 'z', planId: 'p3', priority: 'diagnostic', lockSet: ['r1'], nowUs: 2 }).code, 'lock_conflict');
  assert.equal(a.acquire({ owner: 'z', planId: 'p4', priority: 'diagnostic', lockSet: ['r5'], nowUs: 3 }).ok, true);
});

test('bounded execution slots; recovery may take a slot from a waiting lower-priority plan', () => {
  const a = createArbiter({ slots: 1 });
  a.acquire({ owner: 'meta', planId: 'sup-1', priority: 'supervisory', lockSet: ['r1'], nowUs: 0 });
  assert.equal(a.acquire({ owner: 'meta', planId: 'sup-2', priority: 'supervisory', lockSet: ['r2'], nowUs: 1 }).code, 'no_slot');
  const rec = a.acquire({ owner: 'adaptive', planId: 'rec-1', priority: 'recovery', lockSet: ['r3'], nowUs: 2 });
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.preempted, ['sup-1']);
});

test('a burst of supervisory requests cannot starve recovery', () => {
  const a = createArbiter({ slots: 2 });
  for (let i = 0; i < 50; i++) a.acquire({ owner: 'meta', planId: `sup-${i}`, priority: 'supervisory', lockSet: [`asset-${i % 5}`], nowUs: i });
  const t0 = performance.now();
  const rec = a.acquire({ owner: 'adaptive', planId: 'rec-1', priority: 'recovery', lockSet: ['asset-0', 'asset-1'], nowUs: 100 });
  assert.equal(rec.ok, true);
  assert.ok(performance.now() - t0 < 50, 'arbitration is immediate under load');
});

test('manual override cancels plans holding the overridden assets and blocks automation on them', () => {
  const a = createArbiter({ slots: 2 });
  a.acquire({ owner: 'meta', planId: 'sup-1', priority: 'supervisory', lockSet: ['pump-1'], nowUs: 0 });
  const o = a.override({ operator: 'op-1', assets: ['pump-1'], nowUs: 5 });
  assert.deepEqual(o.cancelled, ['sup-1']);
  assert.equal(a.acquire({ owner: 'adaptive', planId: 'rec-1', priority: 'recovery', lockSet: ['pump-1'], nowUs: 6 }).code, 'manual_override');
  a.clearOverride('pump-1');
  assert.equal(a.acquire({ owner: 'adaptive', planId: 'rec-1', priority: 'recovery', lockSet: ['pump-1'], nowUs: 7 }).ok, true);
});

test('a proposer supersedes its own reservation that has not started; others still conflict', () => {
  const a = createArbiter({ slots: 2 });
  a.acquire({ owner: 'meta', planId: 'sup-1', priority: 'supervisory', lockSet: ['r4'], nowUs: 0 });
  const newer = a.acquire({ owner: 'meta', planId: 'sup-2', priority: 'supervisory', lockSet: ['r4', 'r5'], nowUs: 5 });
  assert.equal(newer.ok, true);
  assert.deepEqual(newer.superseded, ['sup-1']);
  assert.ok(a.trace().some(t => t.event === 'superseded' && t.planId === 'sup-1' && t.by === 'sup-2'));
  assert.equal(a.acquire({ owner: 'adaptive', planId: 'x', priority: 'supervisory', lockSet: ['r5'], nowUs: 6 }).code, 'lock_conflict');
  a.markExecuting('sup-2');
  assert.equal(a.acquire({ owner: 'meta', planId: 'sup-3', priority: 'supervisory', lockSet: ['r4'], nowUs: 7 }).code, 'lock_busy_executing');
});
