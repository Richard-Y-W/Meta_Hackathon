// Plan execution across domain adapters. Before every action: binding to configuration revisions (own
// effects advance the expectation; anyone else's change stops the plan), authority and locks. Lost
// acknowledgements are resolved by read-back; partial completion runs only declared compensations.
// No multi-domain atomicity is assumed.
import { CONTRACT } from './contracts.mjs';
import { authorize } from './arbiter.mjs';
import { orderActions, planHash } from './plans.mjs';

export function createCoordinator({ adapters, arbiter, grants, now, environment, revisions }) {
  const log = [];
  let sequence = 0;
  const note = entry => log.push({ ...entry, atUs: now() });

  const envelope = (plan, action, grantId) => ({
    schemaVersion: CONTRACT.schemaVersion, runId: plan.runId, domainId: action.domainId, sequence: ++sequence, tickUs: now(), kind: 'action',
    actionId: action.actionId, capabilityId: `${action.domainId === 'communications' ? 'comms' : action.domainId}.${action.actionType}`, parameters: action.parameters,
    preconditions: action.preconditions ?? [], effectDeadlineUs: plan.expiresAtUs, lockSet: action.assets ?? [], authorityGrant: grantId, compensation: plan.compensations?.[action.actionId] ? 'declared' : 'stop',
  });

  const grantFor = action => grants.find(g => g.domainId === action.domainId) ?? null;

  function staleDomain(expected) {
    const current = revisions();
    return Object.keys(expected).find(domain => current[domain] !== expected[domain]) ?? null;
  }

  async function run(plan, action, hash) {
    const grant = grantFor(action);
    const auth = authorize(action, grant, { nowUs: now(), planHash: hash, environment });
    if (!auth.ok) return { receipt: { actionId: action.actionId, status: 'rejected', reason: auth.code }, code: auth.code };
    const adapter = adapters[action.domainId];
    if (!adapter) return { receipt: { actionId: action.actionId, status: 'rejected', reason: 'no_adapter' }, code: 'no_adapter' };
    let result = await adapter.execute(envelope(plan, action, auth.grantId));
    let receipt = result.receipt;
    if (receipt?.status === 'unknown') {
      const rb = await adapter.readback(action.actionId);
      if (rb.ok) { note({ event: 'readback_resolved', planId: plan.planId, actionId: action.actionId, status: rb.receipt.status }); receipt = rb.receipt; }
    }
    return { receipt, code: receipt?.status === 'success' ? 'ok' : receipt?.reason ?? 'failed' };
  }

  async function finish(plan, hash, status, extra = {}) {
    arbiter.release(plan.planId);
    note({ event: 'plan_finished', planId: plan.planId, planHash: hash, status, ...('code' in extra ? { code: extra.code } : {}) });
    return { planId: plan.planId, planHash: hash, status, ...extra };
  }

  return {
    async submit(plan, { priority }) {
      const hash = planHash(plan);
      note({ event: 'plan_submitted', planId: plan.planId, planHash: hash, proposer: plan.proposer, priority });
      const order = orderActions(plan);
      if (!order.ok) return finish(plan, hash, 'rejected', { code: order.code });
      if (now() >= plan.expiresAtUs) return finish(plan, hash, 'rejected', { code: 'plan_expired' });
      const expected = { ...plan.expectedConfigurationRevisions };
      const drift = staleDomain(expected);
      if (drift) return finish(plan, hash, 'rejected', { code: revisions()[drift] > expected[drift] ? 'configuration_stale' : 'future_revision', domain: drift });
      const byId = Object.fromEntries(plan.actions.map(a => [a.actionId, a]));
      for (const id of order.order) {
        const auth = authorize(byId[id], grantFor(byId[id]), { nowUs: now(), planHash: hash, environment });
        if (!auth.ok) return finish(plan, hash, 'rejected', { code: auth.code, actionId: id });
      }
      const lockSet = [...new Set(plan.actions.flatMap(a => a.assets ?? []))];
      const lock = arbiter.acquire({ owner: plan.proposer, planId: plan.planId, priority, lockSet, nowUs: now() });
      if (!lock.ok) return finish(plan, hash, 'rejected', { code: lock.code, waitFor: lock.waitFor });
      arbiter.markExecuting(plan.planId);
      const done = [];
      for (const id of order.order) {
        const changed = staleDomain(expected);
        if (changed) return finish(plan, hash, done.length ? 'partial' : 'rejected', { code: 'configuration_stale', stoppedAt: id, completed: done.map(d => d.actionId) });
        const { receipt, code } = await run(plan, byId[id], hash);
        if (receipt.status === 'success') {
          done.push(receipt);
          if (receipt.resultingConfigurationRevision !== undefined) expected[byId[id].domainId] = receipt.resultingConfigurationRevision;
          continue;
        }
        // Partial completion: read back what actually happened, then compensate only as declared.
        const readback = [];
        for (const r of [...done, receipt]) {
          const rb = await adapters[byId[r.actionId].domainId].readback(r.actionId);
          readback.push({ actionId: r.actionId, status: rb.ok ? rb.receipt.status : 'unknown' });
        }
        const compensation = [];
        for (const r of [...done].reverse()) {
          const comp = plan.compensations?.[r.actionId];
          if (!comp) continue;
          const c = await run(plan, comp, hash);
          compensation.push({ for: r.actionId, actionId: comp.actionId, status: c.receipt.status });
        }
        return finish(plan, hash, done.length ? 'partial' : 'rejected', {
          code, stoppedAt: id, readback, compensation, ...(compensation.length ? {} : { stopReason: 'no_declared_compensation' }),
        });
      }
      return finish(plan, hash, 'success', { receipts: done });
    },
    trace: () => [...arbiter.trace(), ...log].map(e => ({ ...e })),
  };
}
