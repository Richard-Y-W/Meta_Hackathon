import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigationBudget } from '../../src/lifeline/investigation-clock.mjs';

test('the total investigation deadline is measured on the injected clock and clamps at zero', () => {
  let now = 31000;
  const b = createInvestigationBudget({ startedAtMs: 31000, deadlineMs: 30000, nowMs: () => now });
  assert.equal(b.remainingMs(), 30000);
  now = 49000; assert.equal(b.remainingMs(), 12000);
  assert.equal(b.expired(), false);
  now = 61000; assert.equal(b.expired(), true);
  now = 67000; assert.equal(b.remainingMs(), 0);
  assert.equal(b.deadlineAtMs, 61000);
});

test('a per-call timeout is bounded by the remaining total budget', () => {
  let now = 49000;
  const b = createInvestigationBudget({ startedAtMs: 31000, deadlineMs: 30000, nowMs: () => now });
  assert.equal(b.callTimeoutMs(18000), 12000);
  now = 40000;
  assert.equal(b.callTimeoutMs(18000), 18000);
});

test('invalid budgets are refused rather than silently unbounded', () => {
  for (const bad of [{ startedAtMs: -1, deadlineMs: 1 }, { startedAtMs: 0, deadlineMs: 0 }, { startedAtMs: 0, deadlineMs: Infinity }, { startedAtMs: NaN, deadlineMs: 5 }]) {
    assert.throws(() => createInvestigationBudget({ ...bad, nowMs: () => 0 }), /invalid_budget/);
  }
});
