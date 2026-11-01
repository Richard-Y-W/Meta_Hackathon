// Plans are content-addressed action graphs. An approval or a binding refers to the exact hash, so any
// change to actions, parameters, bindings or expiry makes it a different plan.
import { canonicalRecord } from '../identity.mjs';

export const planHash = plan => canonicalRecord(plan).sha256;

// Deterministic topological order over declared dependencies (Kahn), refusing cycles and dangling refs.
export function orderActions(plan) {
  const ids = plan.actions.map(a => a.actionId);
  if (new Set(ids).size !== ids.length) return { ok: false, code: 'duplicate_action' };
  const deps = new Map(plan.actions.map(a => [a.actionId, new Set(a.dependsOn ?? [])]));
  for (const set of deps.values()) for (const d of set) if (!deps.has(d)) return { ok: false, code: 'unknown_dependency', dependency: d };
  const order = [];
  const done = new Set();
  while (order.length < ids.length) {
    const next = ids.find(id => !done.has(id) && [...deps.get(id)].every(d => done.has(d)));
    if (!next) return { ok: false, code: 'dependency_cycle' };
    order.push(next);
    done.add(next);
  }
  return { ok: true, code: 'ok', order };
}
