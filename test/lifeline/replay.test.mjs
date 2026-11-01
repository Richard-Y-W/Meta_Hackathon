import test from 'node:test';
import assert from 'node:assert/strict';
import { compareContractDecision } from '../../scripts/lifeline-replay.mjs';

const recorded = (admitted, code, contractCheck) => ({ admitted, code, checks: contractCheck ? [contractCheck] : [] });

test('a guard-level rejection after a passing contract check agrees with a passing contract replay', () => {
  const d = recorded(false, 'action_rejected', { check: 'contract', ok: true });
  assert.equal(compareContractDecision(d, { ok: true, code: 'ok' }), 'agree');
});

test('a recorded contract rejection must be reproduced with the same code and detail', () => {
  const d = recorded(false, 'route_unavailable', { check: 'contract', ok: false, code: 'route_unavailable', detail: 'unknown_link' });
  assert.equal(compareContractDecision(d, { ok: false, code: 'route_unavailable', detail: 'unknown_link' }), 'agree');
  assert.equal(compareContractDecision(d, { ok: true, code: 'ok' }), 'disagree');
  assert.equal(compareContractDecision(d, { ok: false, code: 'route_unavailable', detail: 'route_not_simple' }), 'disagree');
});

test('an admitted decision whose contract no longer validates is a disagreement', () => {
  const d = recorded(true, 'ok', { check: 'contract', ok: true });
  assert.equal(compareContractDecision(d, { ok: false, code: 'proposal_invalid', detail: 'unknown_field' }), 'disagree');
});

test('decisions refused before the contract check (budget) are not comparable', () => {
  assert.equal(compareContractDecision(recorded(false, 'budget_exhausted', null), { ok: true, code: 'ok' }), 'not_comparable');
});
