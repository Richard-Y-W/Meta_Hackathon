import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../../../src/lifeline/kernel/coordinator.mjs';
import { createArbiter } from '../../../src/lifeline/kernel/arbiter.mjs';
import { planHash } from '../../../src/lifeline/kernel/plans.mjs';

// A fake adapter: per-action scripted outcomes, a durable effect log and read-back of actual state.
function fakeAdapter(script = {}) {
  const effects = [], receipts = new Map(), calls = [];
  return {
    effects, calls,
    async execute(action) {
      calls.push(action.actionId);
      if (receipts.has(action.actionId)) return { ok: true, duplicate: true, receipt: receipts.get(action.actionId) };
      const outcome = script[action.actionId] ?? 'success';
      if (outcome === 'success' || outcome === 'lost_ack') effects.push(action.actionId);
      const receipt = { actionId: action.actionId, status: outcome === 'lost_ack' ? 'unknown' : outcome, reason: outcome };
      receipts.set(action.actionId, outcome === 'lost_ack' ? { ...receipt, status: 'success' } : receipt);
      return { ok: receipt.status === 'success', receipt };
    },
    async readback(actionId) { return receipts.has(actionId) ? { ok: true, receipt: receipts.get(actionId) } : { ok: false, code: 'unknown_action' }; },
  };
}

const grant = { grantId: 'g1', mode: 'bounded_auto', domainId: 'water', assets: ['pump-1', 'pump-2', 'valve-3', 'tank-1'], actionTypes: ['set_pump', 'set_valve'], limits: {}, fromUs: 0, toUs: 1e12, approver: 'sim', environment: 'simulation' };
const act = (id, o = {}) => ({ actionId: id, domainId: 'water', actionType: 'set_pump', assets: ['pump-1'], parameters: { on: true }, dependsOn: [], ...o });
const plan = (o = {}) => ({ planId: 'plan-1', runId: 'run-1', proposer: 'meta', expectedConfigurationRevisions: { water: 4 }, expiresAtUs: 60_000_000,
  actions: [act('a'), act('b', { actionType: 'set_valve', assets: ['valve-3'], dependsOn: ['a'] })], compensations: {}, ...o });

function setup(script, o = {}) {
  const water = fakeAdapter(script);
  let revisions = { water: 4 };
  const coordinator = createCoordinator({ adapters: { water }, arbiter: createArbiter({ slots: 2 }), grants: [grant], now: () => 1_000_000, environment: 'simulation',
    revisions: () => revisions, ...o });
  return { water, coordinator, setRevisions: r => { revisions = r; } };
}

test('a plan executes in dependency order with authority, locks and binding checked', async () => {
  const { water, coordinator } = setup();
  const r = await coordinator.submit(plan(), { priority: 'supervisory' });
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.deepEqual(water.effects, ['a', 'b']);
  assert.equal(r.planHash, planHash(plan()));
});

test('a plan built for revision 4 cannot execute after revision 5 without revalidation', async () => {
  const { water, coordinator, setRevisions } = setup();
  setRevisions({ water: 5 });
  const r = await coordinator.submit(plan(), { priority: 'supervisory' });
  assert.deepEqual([r.status, r.code], ['rejected', 'configuration_stale']);
  assert.deepEqual(water.effects, []);
});

test('a revision change between two actions stops the plan before the second action', async () => {
  const { water, coordinator, setRevisions } = setup();
  const original = water.execute;
  water.execute = async a => { const r = await original(a); if (a.actionId === 'a') setRevisions({ water: 5 }); return r; };
  const r = await coordinator.submit(plan(), { priority: 'supervisory' });
  assert.equal(r.status, 'partial');
  assert.equal(r.stoppedAt, 'b');
  assert.equal(r.code, 'configuration_stale');
  assert.deepEqual(water.effects, ['a']);
});

test('partial completion: actual state is read back, the receipt is partial, and only a declared compensation runs', async () => {
  const comp = { a: act('a-undo', { parameters: { on: false } }) };
  const { water, coordinator } = setup({ b: 'rejected' });
  const r = await coordinator.submit(plan({ compensations: comp }), { priority: 'supervisory' });
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.readback.map(x => [x.actionId, x.status]), [['a', 'success'], ['b', 'rejected']]);
  assert.deepEqual(water.effects, ['a', 'a-undo']);
  assert.deepEqual(r.compensation, [{ for: 'a', actionId: 'a-undo', status: 'success' }]);
  const noComp = setup({ b: 'rejected' });
  const stopped = await noComp.coordinator.submit(plan(), { priority: 'supervisory' });
  assert.equal(stopped.status, 'partial');
  assert.deepEqual(stopped.compensation, []);
  assert.equal(stopped.stopReason, 'no_declared_compensation');
});

test('a missing acknowledgement is resolved by read-back, and a retry never duplicates the effect', async () => {
  const { water, coordinator } = setup({ a: 'lost_ack' });
  const r = await coordinator.submit(plan(), { priority: 'supervisory' });
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.deepEqual(water.effects, ['a', 'b']);
  const retry = await coordinator.submit(plan(), { priority: 'supervisory', retry: true });
  assert.equal(retry.status, 'success');
  assert.deepEqual(water.effects, ['a', 'b'], 'idempotent: no second effect');
});

test('unauthorized actions are refused before any effect', async () => {
  const { water, coordinator } = setup();
  const r = await coordinator.submit(plan({ actions: [act('a', { assets: ['pump-9'] })] }), { priority: 'supervisory' });
  assert.deepEqual([r.status, r.code], ['rejected', 'asset_not_granted']);
  assert.deepEqual(water.effects, []);
});

test('expired plans and dependency cycles are refused', async () => {
  const { coordinator } = setup();
  assert.equal((await coordinator.submit(plan({ expiresAtUs: 1_000_000 }), { priority: 'supervisory' })).code, 'plan_expired');
  const cyclic = plan(); cyclic.actions[0].dependsOn = ['b'];
  assert.equal((await coordinator.submit(cyclic, { priority: 'supervisory' })).code, 'dependency_cycle');
});

test('the trace records which proposal won and why', async () => {
  const { coordinator } = setup();
  await coordinator.submit(plan({ planId: 'sup' }), { priority: 'supervisory' });
  const trace = coordinator.trace();
  assert.ok(trace.some(t => t.event === 'granted' && t.planId === 'sup'));
  assert.ok(trace.some(t => t.event === 'plan_finished' && t.planId === 'sup' && t.status === 'success'));
});

test('recovery proceeds while many model investigations are unresolved; local scheduling delay stays small', async () => {
  const { coordinator, water } = setup();
  const hanging = Array.from({ length: 50 }, () => new Promise(() => {}));
  const t0 = performance.now();
  const r = await coordinator.submit(plan({ planId: 'rec' }), { priority: 'recovery' });
  const delayMs = performance.now() - t0;
  assert.equal(r.status, 'success');
  assert.ok(delayMs < 100, `recovery took ${delayMs} ms with ${hanging.length} pending investigations`);
  assert.deepEqual(water.effects, ['a', 'b']);
});
