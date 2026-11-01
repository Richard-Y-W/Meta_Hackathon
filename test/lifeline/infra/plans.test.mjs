import test from 'node:test';
import assert from 'node:assert/strict';
import { planHash, orderActions } from '../../../src/lifeline/kernel/plans.mjs';
import { authorize } from '../../../src/lifeline/kernel/arbiter.mjs';

const plan = (o = {}) => ({ planId: 'plan-1', runId: 'run-1', proposer: 'meta', expectedConfigurationRevisions: { communications: 4 }, expiresAtUs: 60_000_000,
  actions: [{ actionId: 'a', domainId: 'communications', actionType: 'set_background_rate', assets: ['bulk-field'], parameters: { bitsPerSecond: 2_000_000 }, dependsOn: [] },
    { actionId: 'b', domainId: 'communications', actionType: 'set_route', assets: ['r0', 'r1', 'r4', 'r3'], parameters: { flowId: 'dispatch-clinic' }, dependsOn: ['a'] }], ...o });

test('plan identity covers content: any change to actions, bindings or expiry changes the hash', () => {
  const h = planHash(plan());
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(planHash(plan()), h);
  assert.notEqual(planHash(plan({ expiresAtUs: 61_000_000 })), h);
  const changed = plan(); changed.actions[0].parameters.bitsPerSecond = 3_000_000;
  assert.notEqual(planHash(changed), h);
});

test('action order follows declared dependencies; cycles and unknown references are refused', () => {
  assert.deepEqual(orderActions(plan()).order, ['a', 'b']);
  const cyclic = plan(); cyclic.actions[0].dependsOn = ['b'];
  assert.equal(orderActions(cyclic).code, 'dependency_cycle');
  const dangling = plan(); dangling.actions[1].dependsOn = ['z'];
  assert.equal(orderActions(dangling).code, 'unknown_dependency');
});

const grant = (o = {}) => ({ grantId: 'g1', mode: 'bounded_auto', domainId: 'communications', assets: ['bulk-field', 'r0', 'r1', 'r3', 'r4'], actionTypes: ['set_background_rate', 'set_route'],
  limits: { bitsPerSecond: { min: 500_000, max: 6_500_000 } }, fromUs: 0, toUs: 100_000_000, approver: 'sim-operator', environment: 'simulation', ...o });

test('authority modes: observe never actuates; recommend needs approval; approve_each binds to the exact plan hash', () => {
  const p = plan(), a = p.actions[0], h = planHash(p);
  assert.equal(authorize(a, grant({ mode: 'observe' }), { nowUs: 1, planHash: h }).code, 'mode_observe');
  assert.equal(authorize(a, grant({ mode: 'recommend' }), { nowUs: 1, planHash: h }).code, 'approval_required');
  assert.equal(authorize(a, grant({ mode: 'approve_each', approvedPlanHash: h }), { nowUs: 1, planHash: h }).ok, true);
  const altered = plan(); altered.actions[0].parameters.bitsPerSecond = 3_000_000;
  assert.equal(authorize(altered.actions[0], grant({ mode: 'approve_each', approvedPlanHash: h }), { nowUs: 1, planHash: planHash(altered) }).code, 'approval_mismatch');
  assert.equal(authorize(a, grant(), { nowUs: 1, planHash: h }).ok, true);
});

test('authority scope: asset, action type, numeric limit, time window and environment', () => {
  const a = plan().actions[0];
  assert.equal(authorize(a, grant({ assets: ['r0'] }), { nowUs: 1 }).code, 'asset_not_granted');
  assert.equal(authorize(a, grant({ actionTypes: ['set_route'] }), { nowUs: 1 }).code, 'action_not_granted');
  assert.equal(authorize({ ...a, parameters: { bitsPerSecond: 9_000_000 } }, grant(), { nowUs: 1 }).code, 'limit_exceeded');
  assert.equal(authorize(a, grant(), { nowUs: 200_000_000 }).code, 'grant_expired');
  assert.equal(authorize(a, grant({ domainId: 'water' }), { nowUs: 1 }).code, 'domain_not_granted');
  assert.equal(authorize(a, grant({ environment: 'site' }), { nowUs: 1, environment: 'simulation' }).code, 'environment_mismatch');
  assert.equal(authorize(a, null, { nowUs: 1 }).code, 'authority_missing');
});
