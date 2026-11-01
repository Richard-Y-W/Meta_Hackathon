// Admission guard: authority, freshness, preconditions against the newest observation, budgets and
// transition states. Pure apart from charging the budget ledger. Model metadata is never consulted.
import { validateProposal } from './contracts.mjs';

export class RunBudgets {
  constructor(policy) {
    this.limits = {
      interventionBundles: policy.budgets.interventionBundlesPerRun,
      modelCalls: policy.budgets.modelCallsPerRun,
      incidentProbeBytes: policy.limits.incidentProbeBytes,
    };
    this.used = { interventionBundles: 0, modelCalls: 0, incidentProbeBytes: 0 };
    this.history = [];
  }

  remaining() {
    return Object.fromEntries(Object.entries(this.limits).map(([k, v]) => [k, v - this.used[k]]));
  }

  charge(kind, amount, reason) {
    if (!(kind in this.limits)) throw new Error(`unknown budget ${kind}`);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('budget charges must be non-negative');
    this.used[kind] += amount;
    this.history.push({ kind, amount, reason });
  }

  // A new incident restores only the per-incident probe allowance; run budgets never reset.
  resetIncident(incidentId) {
    this.used.incidentProbeBytes = 0;
    this.history.push({ kind: 'incidentProbeBytes', amount: 0, reason: `reset for ${incidentId}` });
  }
}

const routeLinks = (path, topology) => path.slice(1).map((node, i) => {
  const link = topology.links.find(l => (l.a === path[i] && l.b === node) || (l.b === path[i] && l.a === node));
  return { linkId: link.linkId, key: `${link.linkId}:${path[i]}>${node}` };
});

function linkStateCheck(actions, observation, topology) {
  for (const action of actions.filter(a => a.type === 'set_route')) {
    for (const path of [action.path, action.ackPath]) {
      for (const { linkId } of routeLinks(path, topology)) {
        const state = observation.links?.[linkId]?.state;
        if (state === undefined || state === null) return ['route_unavailable', 'link_state_unknown'];
        if (state !== 'up') return ['route_unavailable', 'link_down'];
      }
    }
  }
  return null;
}

function preconditionCheck(preconditions, observation) {
  for (const pre of preconditions) {
    if (pre.kind === 'link_state') {
      const state = observation.links?.[pre.linkId]?.state;
      if (state === undefined || state === null) return ['precondition_failed', 'measurement_missing'];
      if (state !== pre.state) return ['precondition_failed', 'link_state_changed'];
    } else if (pre.kind === 'service_on_time_below') {
      const value = observation.services?.[pre.flowId]?.recentOnTimeFraction;
      if (typeof value !== 'number' || !Number.isFinite(value)) return ['precondition_failed', 'measurement_missing'];
      if (value >= pre.onTimeFraction) return ['precondition_failed', 'service_recovered'];
    }
  }
  return null;
}

function ruleCapacityCheck(actions, ruleCapacity) {
  if (!ruleCapacity) return { evaluated: false };
  const added = {};
  for (const action of actions.filter(a => a.type === 'set_route')) {
    for (const node of [...action.path, ...action.ackPath]) added[node] = (added[node] ?? 0) + 1;
  }
  // Make-before-break: the old version stays installed while the new one is prepared.
  const over = Object.entries(added).filter(([node, n]) => (ruleCapacity.installed[node] ?? 0) + n > ruleCapacity.perSwitch);
  return { evaluated: true, ok: over.length === 0, over: over.map(([node]) => node) };
}

function loads(routes, rates, topology) {
  const load = {};
  for (const [flow, path] of Object.entries(routes)) {
    for (const { linkId, key } of routeLinks(path, topology)) load[key] = { linkId, bps: (load[key]?.bps ?? 0) + (rates[flow] ?? 0) };
  }
  return load;
}

// Every intermediate state, including the last, may not push a directed link over its capacity lower
// bound unless that link was already at least as loaded before the bundle started.
function transitionCheck(actions, transition, topology) {
  if (!transition) return { evaluated: false };
  const routes = { ...transition.flowRoutes };
  const rates = { ...transition.flowRateBps };
  const initial = loads(routes, rates, topology);
  const unknown = new Set();
  for (const [step, action] of actions.entries()) {
    if (action.type === 'set_route') routes[action.flowId] = action.path;
    else if (action.type === 'set_background_rate') rates[action.sourceId] = action.bitsPerSecond;
    else continue;
    for (const [key, { linkId, bps }] of Object.entries(loads(routes, rates, topology))) {
      const capacity = transition.capacityBps[linkId];
      if (capacity === undefined) { unknown.add(linkId); continue; }
      if (bps > capacity && bps > (initial[key]?.bps ?? 0)) return { evaluated: true, ok: false, step, link: key, loadBps: bps, capacityBps: capacity };
    }
  }
  return { evaluated: true, ok: true, unknownCapacity: [...unknown].sort() };
}

// modelMeta (confidence, explanation, any override request) is accepted only so callers can pass it
// without effect; no branch reads it.
export function admitProposal(proposal, ctx, _modelMeta = undefined) {
  const { budgets, observation } = ctx;
  const checks = [];
  const decision = (code, detail) => ({
    version: 'DecisionV1', proposalId: proposal?.proposalId ?? null, admitted: code === 'ok', code, ...(detail ? { detail } : {}),
    checks, configRevision: ctx.configRevision, observationSeq: observation?.seq ?? null, decidedAtMs: ctx.nowMs,
  });

  if (budgets.remaining().interventionBundles < 1) {
    budgets.charge('interventionBundles', 0, `attempt ${proposal?.proposalId} refused: exhausted`);
    return decision('budget_exhausted', 'bundles_exhausted');
  }
  budgets.charge('interventionBundles', 1, `attempt ${proposal?.proposalId}`);

  if (observation?.runId !== ctx.runId) return decision('proposal_invalid', 'observation_run_mismatch');
  if (observation.configRevision !== ctx.configRevision) return decision('configuration_stale', 'observation_configuration_mismatch');

  const contract = validateProposal(proposal, {
    runId: ctx.runId, configRevision: ctx.configRevision, nowMs: ctx.nowMs, policy: ctx.policy, policyId: ctx.policyId,
    topology: ctx.topology, freshObservation: { seq: observation.seq, atMs: observation.collectedAtMs },
    budgets: { remainingBundles: 1, remainingIncidentProbeBytes: budgets.remaining().incidentProbeBytes }, // this attempt is already charged
  });
  checks.push({ check: 'contract', ok: contract.ok, ...(contract.ok ? {} : { code: contract.code, detail: contract.detail }) });
  if (!contract.ok) return decision(contract.code, contract.detail);

  const linkFailure = linkStateCheck(proposal.actions, observation, ctx.topology);
  checks.push({ check: 'link_state', ok: !linkFailure });
  if (linkFailure) return decision(...linkFailure);

  const preFailure = preconditionCheck(proposal.preconditions, observation);
  checks.push({ check: 'preconditions', ok: !preFailure });
  if (preFailure) return decision(...preFailure);

  const rules = ruleCapacityCheck(proposal.actions, ctx.ruleCapacity);
  checks.push({ check: 'rule_capacity', ok: rules.ok !== false, evaluated: rules.evaluated, ...(rules.over?.length ? { over: rules.over } : {}) });
  if (rules.ok === false) return decision('action_rejected', 'rule_capacity');

  const transition = transitionCheck(proposal.actions, ctx.transition, ctx.topology);
  checks.push(transition.evaluated ? { check: 'transition', ...transition } : { check: 'transition', ok: true, evaluated: false });
  if (transition.ok === false) return decision('action_rejected', 'transition_overload');

  return decision('ok');
}
