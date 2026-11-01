import { canonicalRecord } from './identity.mjs';

// ProposalV1 admission against an explicit context. Validators never mutate their inputs.
// Context: { runId, configRevision, nowMs, policy, policyId, topology, freshObservation: {seq, atMs},
//            budgets: { remainingBundles, remainingIncidentProbeBytes } }

class Reject extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; }
}
const reject = (code, detail) => { throw new Reject(code, detail); };

const PROPOSAL_FIELDS = ['version', 'proposalId', 'runId', 'policyId', 'baseConfigRevision', 'observationSeq',
  'observationAtMs', 'expiresAtMs', 'preconditions', 'actions', 'predicted', 'evidence'];
const ACTION_FIELDS = {
  set_route: ['actionId', 'type', 'flowId', 'path', 'ackPath'],
  set_background_rate: ['actionId', 'type', 'sourceId', 'bitsPerSecond'],
  probe_path: ['actionId', 'type', 'sourceId', 'destinationId', 'packetCount', 'payloadBytes', 'intervalMs', 'path'],
  retain_policy: ['actionId', 'type', 'reasonCode'],
};
const PRECONDITION_FIELDS = {
  link_state: ['kind', 'linkId', 'state'],
  service_on_time_below: ['kind', 'flowId', 'onTimeFraction'],
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_ITEMS = 64;

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const OPTIONAL_FIELDS = new Set(['path']); // probe_path may name the path it tests

function exactFields(record, allowed) {
  if (!isPlain(record)) reject('proposal_invalid', 'invalid_type');
  for (const key of Object.keys(record)) if (!allowed.includes(key)) reject('proposal_invalid', 'unknown_field');
  for (const key of allowed) if (!OPTIONAL_FIELDS.has(key) && !Object.hasOwn(record, key)) reject('proposal_invalid', 'missing_field');
}

function number(value, { integer = false, time = false } = {}) {
  if (typeof value !== 'number') reject('proposal_invalid', 'invalid_type');
  if (!Number.isFinite(value)) reject('proposal_invalid', 'nonfinite_number');
  if (integer && !Number.isInteger(value)) reject('proposal_invalid', 'invalid_type');
  if (time && value < 0) reject('proposal_invalid', 'negative_time');
  if (value < 0) reject('proposal_invalid', 'negative_value');
  return value;
}

function id(value) {
  if (typeof value !== 'string' || !ID.test(value)) reject('proposal_invalid', 'invalid_id');
  return value;
}

function list(value, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) reject('proposal_invalid', 'invalid_type');
  if (value.length < min) return null;
  return value;
}

function unique(ids) {
  if (new Set(ids).size !== ids.length) reject('proposal_invalid', 'duplicate_id');
}

// NaN/Infinity are rejected anywhere, before field-level checks can misclassify them.
function scanNumbers(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) reject('proposal_invalid', 'nonfinite_number');
  if (value && typeof value === 'object') Object.values(value).forEach(scanNumbers);
}

function topologyIndex(topology) {
  const nodes = new Set(topology.nodes);
  const links = new Map();
  for (const link of topology.links) {
    links.set(`${link.a}|${link.b}`, link.linkId);
    links.set(`${link.b}|${link.a}`, link.linkId);
  }
  return { nodes, links, linkIds: new Set(topology.links.map(l => l.linkId)), endpoints: topology.endpoints };
}

function checkPath(path, from, to, topo) {
  if (!Array.isArray(path) || path.length < 2 || path.length > topo.nodes.size) reject('route_unavailable', 'route_not_simple');
  for (const node of path) if (typeof node !== 'string' || !topo.nodes.has(node)) reject('route_unavailable', 'unknown_node');
  if (new Set(path).size !== path.length) reject('route_unavailable', 'route_not_simple');
  if (path[0] !== from || path.at(-1) !== to) reject('route_unavailable', 'bad_endpoint');
  for (let i = 1; i < path.length; i++) if (!topo.links.has(`${path[i - 1]}|${path[i]}`)) reject('route_unavailable', 'unknown_link');
}

function checkAction(action, ctx, topo) {
  if (!isPlain(action)) reject('proposal_invalid', 'invalid_type');
  const { policy } = ctx;
  if (!Object.hasOwn(ACTION_FIELDS, action.type) || !policy.allowedActions.includes(action.type)) reject('action_rejected', 'action_not_allowed');
  exactFields(action, ACTION_FIELDS[action.type]);
  id(action.actionId);
  const flows = new Map(policy.essentialFlows.map(f => [f.flowId, f]));
  const background = new Map(policy.backgroundSources.map(s => [s.sourceId, s]));
  switch (action.type) {
    case 'set_route': {
      const flow = flows.get(action.flowId) ?? reject('proposal_invalid', 'unknown_flow');
      const src = topo.endpoints[flow.source], dst = topo.endpoints[flow.destination];
      checkPath(action.path, src, dst, topo);
      checkPath(action.ackPath, dst, src, topo);
      return 0;
    }
    case 'set_background_rate': {
      if (flows.has(action.sourceId) || Object.hasOwn(topo.endpoints, action.sourceId)) reject('action_rejected', 'essential_source_throttle');
      const source = background.get(action.sourceId) ?? reject('proposal_invalid', 'unknown_source');
      const rate = number(action.bitsPerSecond, { integer: true });
      if (rate < source.minBitsPerSecond || rate > source.maxBitsPerSecond) reject('action_rejected', 'rate_out_of_bounds');
      return 0;
    }
    case 'probe_path': {
      const count = number(action.packetCount, { integer: true });
      const bytes = number(action.payloadBytes, { integer: true });
      const interval = number(action.intervalMs, { time: true });
      for (const end of [action.sourceId, action.destinationId]) {
        if (typeof end !== 'string' || !Object.hasOwn(topo.endpoints, end)) reject('route_unavailable', 'bad_endpoint');
      }
      if (action.sourceId === action.destinationId) reject('route_unavailable', 'bad_endpoint');
      if (Object.hasOwn(action, 'path')) checkPath(action.path, topo.endpoints[action.sourceId], topo.endpoints[action.destinationId], topo);
      if (count < 1 || bytes < 1 || count > policy.limits.probeMaxPackets || count * bytes > policy.limits.probeMaxBytes) reject('action_rejected', 'probe_oversized');
      if (interval < policy.limits.probeMinIntervalMs) reject('action_rejected', 'probe_interval_too_short');
      return count * bytes;
    }
    case 'retain_policy':
      id(action.reasonCode);
      return 0;
  }
}

function checkPrecondition(pre, ctx, topo) {
  if (!isPlain(pre) || !Object.hasOwn(PRECONDITION_FIELDS, pre.kind)) reject('proposal_invalid', 'unknown_precondition');
  exactFields(pre, PRECONDITION_FIELDS[pre.kind]);
  if (pre.kind === 'link_state') {
    if (!topo.linkIds.has(pre.linkId)) reject('route_unavailable', 'unknown_link');
    if (pre.state !== 'up' && pre.state !== 'down') reject('proposal_invalid', 'invalid_type');
  } else {
    if (!ctx.policy.essentialFlows.some(f => f.flowId === pre.flowId)) reject('proposal_invalid', 'unknown_flow');
    if (number(pre.onTimeFraction) > 1) reject('proposal_invalid', 'invalid_type');
  }
}

function checkPrediction(prediction, ctx) {
  if (!isPlain(prediction)) reject('proposal_invalid', 'invalid_prediction');
  exactFields(prediction, ['flowId', 'onTimeFraction']);
  if (!ctx.policy.essentialFlows.some(f => f.flowId === prediction.flowId)) reject('proposal_invalid', 'unknown_flow');
  const range = prediction.onTimeFraction;
  if (!Array.isArray(range) || range.length !== 2 || range.some(v => typeof v !== 'number' || v < 0 || v > 1) || range[0] > range[1]) {
    reject('proposal_invalid', 'invalid_prediction');
  }
}

function admit(p, ctx) {
  if (!isPlain(p)) reject('proposal_invalid', 'invalid_type');
  if (p.version !== 'ProposalV1') reject('proposal_invalid', 'unsupported_version');
  exactFields(p, PROPOSAL_FIELDS);
  scanNumbers(p);
  canonicalRecord(p); // rejects any non-JSON value that survived the field checks
  id(p.proposalId); id(p.runId);
  if (typeof p.policyId !== 'string') reject('proposal_invalid', 'invalid_type');
  for (const field of ['observationAtMs', 'expiresAtMs']) number(p[field], { time: true });
  number(p.baseConfigRevision, { integer: true }); number(p.observationSeq, { integer: true });
  const actions = list(p.actions, { min: 1 }) ?? reject('proposal_invalid', 'actions_missing');
  const evidence = list(p.evidence, { min: 1 }) ?? reject('proposal_invalid', 'evidence_missing');
  evidence.forEach(id);
  unique(evidence);
  unique(actions.map(a => (isPlain(a) ? a.actionId : undefined)));

  if (p.runId !== ctx.runId) reject('proposal_invalid', 'run_mismatch');
  if (p.policyId !== ctx.policyId || canonicalRecord(ctx.policy).sha256 !== ctx.policyId) reject('policy_mismatch', 'policy_mismatch');
  if (p.baseConfigRevision > ctx.configRevision) reject('proposal_invalid', 'future_revision');
  if (p.baseConfigRevision < ctx.configRevision) reject('configuration_stale', 'configuration_stale');

  const { limits } = ctx.policy;
  if (p.observationSeq > ctx.freshObservation.seq || p.observationAtMs > ctx.nowMs) reject('proposal_invalid', 'future_observation');
  if (p.expiresAtMs - p.observationAtMs > limits.proposalLifetimeMs) reject('proposal_invalid', 'lifetime_exceeds_policy');
  if (ctx.nowMs >= p.expiresAtMs) reject('observation_stale', 'proposal_expired');
  if (ctx.nowMs - ctx.freshObservation.atMs > limits.maxObservationAgeMs) reject('observation_stale', 'admission_observation_stale');

  const topo = topologyIndex(ctx.topology);
  list(p.preconditions).forEach(pre => checkPrecondition(pre, ctx, topo));
  list(p.predicted).forEach(prediction => checkPrediction(prediction, ctx));
  if (actions.length > limits.maxActionsPerBundle) reject('action_rejected', 'bundle_too_large');
  const probeBytes = actions.reduce((sum, action) => sum + checkAction(action, ctx, topo), 0);

  if (ctx.budgets.remainingBundles < 1) reject('budget_exhausted', 'bundles_exhausted');
  if (probeBytes > ctx.budgets.remainingIncidentProbeBytes) reject('budget_exhausted', 'probe_bytes_exhausted');
}

export function validateProposal(proposal, context) {
  try {
    admit(proposal, context);
    return { ok: true, code: 'ok' };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, code: error.code, detail: error.detail };
    if (error?.code === 'record_invalid') return { ok: false, code: 'proposal_invalid', detail: 'record_invalid' };
    throw error;
  }
}
