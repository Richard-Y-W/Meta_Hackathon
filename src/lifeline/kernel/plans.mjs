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

// Timed joint plans (P12): steps carry a time on the coupling grid, a duration, declared resource use and
// preconditions. Static validation refuses what can be refused without simulation; joint feasibility
// (individually feasible steps that conflict together) is judged by simulation in planner.mjs.
export function validateTimedPlan(plan, { nowUs, gridUs, resources = {}, allocated = {} }) {
  const fail = (code, stepId, detail) => ({ ok: false, code, ...(stepId ? { stepId } : {}), ...(detail ? { detail } : {}) });
  const steps = plan.steps ?? [];
  const order = orderActions({ actions: steps.map(s => ({ actionId: s.id, dependsOn: s.dependsOn ?? [] })) });
  if (!order.ok) return fail(order.code);
  const byId = Object.fromEntries(steps.map(s => [s.id, s]));
  for (const s of steps) {
    if (!Number.isInteger(s.atUs) || s.atUs % gridUs) return fail('off_grid_step', s.id);
    if (s.atUs < nowUs) return fail('late_command', s.id, 'scheduled before now');
    if (s.deadlineUs !== undefined && s.atUs + (s.durationUs ?? 0) > s.deadlineUs) return fail('late_command', s.id, 'effect after its deadline');
    for (const d of s.dependsOn ?? []) if (s.atUs < byId[d].atUs + (byId[d].durationUs ?? 0)) return fail('dependency_not_complete', s.id, d);
    for (const p of s.preconditions ?? []) {
      if (p.kind !== 'supply_available') return fail('unknown_precondition', s.id, p.kind);
      const provider = byId[p.providedBy];
      if (!provider) return fail('precondition_unmet', s.id, `no step provides ${p.asset}`);
      if (s.atUs < provider.atUs + (provider.durationUs ?? 0)) return fail('precondition_unmet', s.id, `${p.asset} not available until ${provider.atUs + (provider.durationUs ?? 0)}`);
    }
  }
  const holder = { ...allocated };
  for (const s of [...steps].sort((a, b) => a.atUs - b.atUs || (a.order ?? 0) - (b.order ?? 0))) {
    for (const r of s.resources ?? []) {
      if (!(r.id in resources)) return fail('unknown_resource', s.id, r.id);
      if (r.use === 'allocate') {
        if (holder[r.id]) return fail('resource_double_allocation', s.id, `${r.id} already allocated to ${holder[r.id]}`);
        holder[r.id] = r.site ?? s.id;
      } else if (r.use === 'release') delete holder[r.id];
    }
  }
  return { ok: true, code: 'ok', order: order.order };
}
