// Arbitration and authority. Investigations hold no locks; recovery preempts lower-priority reservations
// and waits only for an action that is already executing; every grant names its scope and mode.
const RANK = { protection: 0, recovery: 1, supervisory: 2, diagnostic: 3, discretionary: 4 };

export function authorize(action, grant, { nowUs, planHash, environment } = {}) {
  const no = code => ({ ok: false, code });
  if (!grant) return no('authority_missing');
  if (grant.environment && environment && grant.environment !== environment) return no('environment_mismatch');
  if (!(nowUs >= grant.fromUs && nowUs < grant.toUs)) return no('grant_expired');
  if (grant.domainId !== action.domainId) return no('domain_not_granted');
  if (!grant.actionTypes.includes(action.actionType)) return no('action_not_granted');
  if ((action.assets ?? []).some(asset => !grant.assets.includes(asset))) return no('asset_not_granted');
  for (const [param, { min = -Infinity, max = Infinity }] of Object.entries(grant.limits ?? {})) {
    const value = action.parameters?.[param];
    if (value !== undefined && (typeof value !== 'number' || value < min || value > max)) return no('limit_exceeded');
  }
  if (grant.mode === 'observe') return no('mode_observe');
  if (grant.mode === 'recommend') return no('approval_required');
  if (grant.mode === 'approve_each' && grant.approvedPlanHash !== planHash) return no('approval_mismatch');
  if (!['approve_each', 'bounded_auto'].includes(grant.mode)) return no('unknown_mode');
  return { ok: true, code: 'ok', grantId: grant.grantId };
}

export function createArbiter({ slots }) {
  const holds = new Map();      // planId -> { owner, priority, lockSet, executing, sinceUs }
  const overrides = new Map();  // asset -> operator
  const log = [];
  let investigations = 0;
  const intersects = (a, b) => a.some(x => b.includes(x));

  return {
    beginInvestigation({ owner, nowUs }) {
      const record = { investigationId: `inv-${++investigations}`, owner, locks: [], startedAtUs: nowUs };
      log.push({ event: 'investigation', ...record });
      return record;
    },

    acquire({ owner, planId, priority, lockSet, nowUs }) {
      const rank = RANK[priority];
      if (rank === undefined) return { ok: false, code: 'unknown_priority' };
      const overridden = lockSet.find(asset => overrides.has(asset));
      if (overridden) { log.push({ event: 'refused', planId, reason: 'manual_override', asset: overridden, atUs: nowUs }); return { ok: false, code: 'manual_override', asset: overridden }; }
      const conflicts = [...holds].filter(([id, h]) => id !== planId && intersects(h.lockSet, lockSet));
      const executing = conflicts.find(([, h]) => h.executing);
      if (executing) { log.push({ event: 'waiting', planId, waitFor: executing[0], atUs: nowUs }); return { ok: false, code: 'lock_busy_executing', waitFor: executing[0] }; }
      // A proposer may replace its own not-yet-executing reservation (supersession); anyone else at equal
      // or higher priority is a conflict.
      const superseded = conflicts.filter(([, h]) => h.owner === owner && h.priority === priority).map(([id]) => id);
      if (conflicts.some(([id, h]) => !superseded.includes(id) && RANK[h.priority] <= rank)) { log.push({ event: 'refused', planId, reason: 'lock_conflict', atUs: nowUs }); return { ok: false, code: 'lock_conflict' }; }
      for (const id of superseded) { holds.delete(id); log.push({ event: 'superseded', planId: id, by: planId, atUs: nowUs }); }
      const preempted = conflicts.map(([id]) => id).filter(id => !superseded.includes(id));
      if (holds.size - preempted.length >= slots) {
        // Free a slot only from a strictly lower-priority plan that has not started.
        const victim = [...holds].filter(([id, h]) => !preempted.includes(id) && !h.executing && RANK[h.priority] > rank)
          .sort(([, x], [, y]) => RANK[y.priority] - RANK[x.priority] || y.sinceUs - x.sinceUs)[0];
        if (!victim) { log.push({ event: 'refused', planId, reason: 'no_slot', atUs: nowUs }); return { ok: false, code: 'no_slot' }; }
        preempted.push(victim[0]);
      }
      for (const id of preempted) { holds.delete(id); log.push({ event: 'preempted', planId: id, by: planId, atUs: nowUs }); }
      holds.set(planId, { owner, priority, lockSet: [...lockSet], executing: false, sinceUs: nowUs });
      log.push({ event: 'granted', planId, owner, priority, lockSet: [...lockSet], atUs: nowUs });
      return { ok: true, code: 'ok', preempted, superseded };
    },

    markExecuting(planId) { const h = holds.get(planId); if (h) h.executing = true; },
    release(planId) { if (holds.delete(planId)) log.push({ event: 'released', planId }); },
    holding: planId => holds.has(planId),

    override({ operator, assets, nowUs }) {
      const cancelled = [...holds].filter(([, h]) => intersects(h.lockSet, assets)).map(([id]) => id);
      for (const id of cancelled) holds.delete(id);
      for (const asset of assets) overrides.set(asset, operator);
      log.push({ event: 'override', operator, assets: [...assets], cancelled, atUs: nowUs });
      return { cancelled };
    },
    clearOverride(asset) { overrides.delete(asset); log.push({ event: 'override_cleared', asset }); },

    trace: () => log.map(e => ({ ...e })),
  };
}
