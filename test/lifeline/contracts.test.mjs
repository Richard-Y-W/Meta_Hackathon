import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalRecord } from '../../src/lifeline/identity.mjs';
import { validateProposal } from '../../src/lifeline/contracts.mjs';

const POLICY = JSON.parse(readFileSync(new URL('../../fixtures/lifeline/policy-v1.json', import.meta.url), 'utf8'));
const POLICY_ID = canonicalRecord(POLICY).sha256;

// The registered development topology from the design: ring r0..r5, direct r0-r3, cross-link r1-r4.
const TOPOLOGY = {
  revision: 1,
  nodes: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'],
  links: [['r0', 'r1'], ['r1', 'r2'], ['r2', 'r3'], ['r3', 'r4'], ['r4', 'r5'], ['r5', 'r0'], ['r0', 'r3'], ['r1', 'r4']]
    .map(([a, b]) => ({ linkId: `${a}-${b}`, a, b })),
  endpoints: { dispatch: 'r0', clinic: 'r3', shelter: 'r4', field: 'r1' },
};

function context(overrides = {}) {
  return {
    runId: 'run-1', configRevision: 7, nowMs: 30_000, policy: POLICY, policyId: POLICY_ID, topology: TOPOLOGY,
    freshObservation: { seq: 60, atMs: 29_500 },
    budgets: { remainingBundles: 12, remainingIncidentProbeBytes: 262_144 },
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    version: 'ProposalV1', proposalId: 'p-1', runId: 'run-1', policyId: POLICY_ID, baseConfigRevision: 7,
    observationSeq: 55, observationAtMs: 27_000, expiresAtMs: 37_000,
    preconditions: [{ kind: 'link_state', linkId: 'r0-r3', state: 'down' }],
    actions: [
      { actionId: 'a1', type: 'set_route', flowId: 'dispatch-clinic', path: ['r0', 'r1', 'r2', 'r3'], ackPath: ['r3', 'r2', 'r1', 'r0'] },
      { actionId: 'a2', type: 'set_background_rate', sourceId: 'bulk-shelter', bitsPerSecond: 2_000_000 },
    ],
    predicted: [{ flowId: 'dispatch-clinic', onTimeFraction: [0.9, 1] }],
    evidence: ['obs-55', 'obs-54'],
    ...overrides,
  };
}

const withAction = action => proposal({ actions: [{ actionId: 'a1', ...action }] });

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test('identity: a record round-trips through its canonical JSON', () => {
  const record = proposal();
  const { json, sha256 } = canonicalRecord(record);
  assert.deepEqual(JSON.parse(json), record);
  assert.match(sha256, /^[0-9a-f]{64}$/);
});

test('identity: object key order does not change identity, array order does', () => {
  assert.equal(canonicalRecord({ b: 1, a: [2, { d: null, c: 'x' }] }).json, '{"a":[2,{"c":"x","d":null}],"b":1}');
  assert.equal(canonicalRecord({ a: 1, b: 2 }).sha256, canonicalRecord({ b: 2, a: 1 }).sha256);
  assert.notEqual(canonicalRecord({ a: [1, 2] }).sha256, canonicalRecord({ a: [2, 1] }).sha256);
});

test('identity: unsupported JavaScript values are rejected, not coerced', () => {
  for (const bad of [{ x: NaN }, { x: Infinity }, { x: undefined }, { x: () => 1 }, { x: 1n }, { x: new Date(0) }, { x: new Map() }, { x: Symbol('s') }, [1, , 3]]) {
    assert.throws(() => canonicalRecord(bad), /record_invalid/);
  }
});

test('identity: every authority field changes the proposal identity', () => {
  const base = canonicalRecord(proposal()).sha256;
  const changes = {
    runId: 'run-2', policyId: 'f'.repeat(64), baseConfigRevision: 8, observationSeq: 56, expiresAtMs: 36_000,
    preconditions: [{ kind: 'link_state', linkId: 'r0-r3', state: 'up' }],
    actions: [{ actionId: 'a1', type: 'retain_policy', reasonCode: 'insufficient_evidence' }],
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(canonicalRecord(proposal({ [field]: value })).sha256, base, field);
  }
});

test('contracts: a valid proposal is admitted and neither input is mutated', () => {
  const p = deepFreeze(proposal());
  const c = deepFreeze(context());
  const before = canonicalRecord(p).json;
  assert.deepEqual(validateProposal(p, c), { ok: true, code: 'ok' });
  assert.equal(canonicalRecord(p).json, before);
});

const REJECTIONS = [
  ['unknown authority field', proposal({ priorityOverride: true }), 'proposal_invalid', 'unknown_field'],
  ['unknown action field', withAction({ type: 'retain_policy', reasonCode: 'x', force: true }), 'proposal_invalid', 'unknown_field'],
  ['unsupported version', proposal({ version: 'ProposalV2' }), 'proposal_invalid', 'unsupported_version'],
  ['NaN value', withAction({ type: 'set_background_rate', sourceId: 'bulk-shelter', bitsPerSecond: NaN }), 'proposal_invalid', 'nonfinite_number'],
  ['Infinity value', proposal({ expiresAtMs: Infinity }), 'proposal_invalid', 'nonfinite_number'],
  ['negative time', proposal({ observationAtMs: -1 }), 'proposal_invalid', 'negative_time'],
  ['duplicate action IDs', proposal({ actions: [{ actionId: 'a1', type: 'retain_policy', reasonCode: 'x' }, { actionId: 'a1', type: 'retain_policy', reasonCode: 'y' }] }), 'proposal_invalid', 'duplicate_id'],
  ['duplicate evidence IDs', proposal({ evidence: ['obs-1', 'obs-1'] }), 'proposal_invalid', 'duplicate_id'],
  ['no evidence', proposal({ evidence: [] }), 'proposal_invalid', 'evidence_missing'],
  ['no actions', proposal({ actions: [] }), 'proposal_invalid', 'actions_missing'],
  ['unknown action type', withAction({ type: 'reboot_switch', node: 'r1' }), 'action_rejected', 'action_not_allowed'],
  ['unknown flow', withAction({ type: 'set_route', flowId: 'nope', path: ['r0', 'r3'], ackPath: ['r3', 'r0'] }), 'proposal_invalid', 'unknown_flow'],
  ['route cycle', withAction({ type: 'set_route', flowId: 'dispatch-clinic', path: ['r0', 'r1', 'r0', 'r3'], ackPath: ['r3', 'r0'] }), 'route_unavailable', 'route_not_simple'],
  ['bad route endpoint', withAction({ type: 'set_route', flowId: 'dispatch-clinic', path: ['r1', 'r2', 'r3'], ackPath: ['r3', 'r2', 'r1'] }), 'route_unavailable', 'bad_endpoint'],
  ['bad acknowledgement endpoint', withAction({ type: 'set_route', flowId: 'dispatch-clinic', path: ['r0', 'r3'], ackPath: ['r3', 'r4'] }), 'route_unavailable', 'bad_endpoint'],
  ['unknown link', withAction({ type: 'set_route', flowId: 'dispatch-clinic', path: ['r0', 'r2', 'r3'], ackPath: ['r3', 'r0'] }), 'route_unavailable', 'unknown_link'],
  ['unregistered node', withAction({ type: 'set_route', flowId: 'dispatch-clinic', path: ['r0', 'r9', 'r3'], ackPath: ['r3', 'r0'] }), 'route_unavailable', 'unknown_node'],
  ['essential source throttling', withAction({ type: 'set_background_rate', sourceId: 'dispatch-clinic', bitsPerSecond: 1_000_000 }), 'action_rejected', 'essential_source_throttle'],
  ['unregistered background source', withAction({ type: 'set_background_rate', sourceId: 'bulk-other', bitsPerSecond: 1_000_000 }), 'proposal_invalid', 'unknown_source'],
  ['rate outside policy bounds', withAction({ type: 'set_background_rate', sourceId: 'bulk-shelter', bitsPerSecond: 100 }), 'action_rejected', 'rate_out_of_bounds'],
  ['oversized probe bytes', withAction({ type: 'probe_path', sourceId: 'dispatch', destinationId: 'clinic', packetCount: 64, payloadBytes: 1500, intervalMs: 10 }), 'action_rejected', 'probe_oversized'],
  ['too many probe packets', withAction({ type: 'probe_path', sourceId: 'dispatch', destinationId: 'clinic', packetCount: 65, payloadBytes: 100, intervalMs: 10 }), 'action_rejected', 'probe_oversized'],
  ['probe interval too short', withAction({ type: 'probe_path', sourceId: 'dispatch', destinationId: 'clinic', packetCount: 8, payloadBytes: 100, intervalMs: 1 }), 'action_rejected', 'probe_interval_too_short'],
  ['probe to unregistered endpoint', withAction({ type: 'probe_path', sourceId: 'dispatch', destinationId: 'hospital', packetCount: 8, payloadBytes: 100, intervalMs: 10 }), 'route_unavailable', 'bad_endpoint'],
  ['probe to an inherited property name', withAction({ type: 'probe_path', sourceId: 'dispatch', destinationId: 'constructor', packetCount: 8, payloadBytes: 100, intervalMs: 10 }), 'route_unavailable', 'bad_endpoint'],
  ['fractional packet count', withAction({ type: 'probe_path', sourceId: 'dispatch', destinationId: 'clinic', packetCount: 2.5, payloadBytes: 100, intervalMs: 10 }), 'proposal_invalid', 'invalid_type'],
  ['too many actions', proposal({ actions: Array.from({ length: 5 }, (_, i) => ({ actionId: `a${i}`, type: 'retain_policy', reasonCode: 'x' })) }), 'action_rejected', 'bundle_too_large'],
  ['unknown precondition kind', proposal({ preconditions: [{ kind: 'trust_me' }] }), 'proposal_invalid', 'unknown_precondition'],
  ['precondition on unknown link', proposal({ preconditions: [{ kind: 'link_state', linkId: 'r0-r2', state: 'down' }] }), 'route_unavailable', 'unknown_link'],
  ['prediction outside [0,1]', proposal({ predicted: [{ flowId: 'dispatch-clinic', onTimeFraction: [0.9, 1.2] }] }), 'proposal_invalid', 'invalid_prediction'],
];

for (const [name, p, code, detail] of REJECTIONS) {
  test(`contracts: rejects ${name}`, () => {
    const result = validateProposal(p, context());
    assert.equal(result.ok, false);
    assert.equal(result.code, code, JSON.stringify(result));
    assert.equal(result.detail, detail);
  });
}

test('contracts: run, policy and configuration bindings are exact', () => {
  assert.deepEqual(pick(validateProposal(proposal({ runId: 'run-0' }), context())), ['proposal_invalid', 'run_mismatch']);
  assert.deepEqual(pick(validateProposal(proposal({ policyId: 'f'.repeat(64) }), context())), ['policy_mismatch', 'policy_mismatch']);
  assert.deepEqual(pick(validateProposal(proposal({ baseConfigRevision: 6 }), context())), ['configuration_stale', 'configuration_stale']);
  assert.deepEqual(pick(validateProposal(proposal({ baseConfigRevision: 8 }), context())), ['proposal_invalid', 'future_revision']);
});

test('contracts: staleness is decided by the explicit age policy, not by a well-formed reference', () => {
  // The originating observation may be older than the admission limit; the fresh admission sample may not.
  assert.equal(validateProposal(proposal(), context()).ok, true);
  assert.deepEqual(pick(validateProposal(proposal(), context({ freshObservation: { seq: 60, atMs: 27_900 } }))), ['observation_stale', 'admission_observation_stale']);
  assert.deepEqual(pick(validateProposal(proposal(), context({ nowMs: 37_000, freshObservation: { seq: 70, atMs: 36_800 } }))), ['observation_stale', 'proposal_expired']);
  assert.deepEqual(pick(validateProposal(proposal({ expiresAtMs: 37_001 }), context())), ['proposal_invalid', 'lifetime_exceeds_policy']);
  assert.deepEqual(pick(validateProposal(proposal({ observationSeq: 61 }), context())), ['proposal_invalid', 'future_observation']);
});

test('contracts: remaining budgets bound the bundle and its probe bytes', () => {
  assert.deepEqual(pick(validateProposal(proposal(), context({ budgets: { remainingBundles: 0, remainingIncidentProbeBytes: 262_144 } }))), ['budget_exhausted', 'bundles_exhausted']);
  const probe = withAction({ type: 'probe_path', sourceId: 'dispatch', destinationId: 'clinic', packetCount: 64, payloadBytes: 1000, intervalMs: 10 });
  assert.equal(validateProposal(probe, context()).ok, true);
  assert.deepEqual(pick(validateProposal(probe, context({ budgets: { remainingBundles: 12, remainingIncidentProbeBytes: 63_999 } }))), ['budget_exhausted', 'probe_bytes_exhausted']);
});

test('contracts: the reviewed development policy fixture is pinned', () => {
  // Changing the policy requires a new reviewed identity; it is outside model authority.
  assert.equal(POLICY.version, 'ServicePolicyV1');
  assert.equal(POLICY_ID, PINNED_POLICY_SHA256);
});

const pick = result => [result.code, result.detail];
const PINNED_POLICY_SHA256 = 'f7baa4fa7e3c82e2d226d1e923b7b55d0f6e170c1ef70abe2f24f4a96498dd25';

test('contracts: a probe may name a registered simple path between its endpoints', () => {
  const probe = path => withAction({ type: 'probe_path', sourceId: 'dispatch', destinationId: 'clinic', packetCount: 8, payloadBytes: 200, intervalMs: 10, ...(path ? { path } : {}) });
  assert.equal(validateProposal(probe(['r0', 'r5', 'r4', 'r3']), context()).ok, true);
  assert.equal(validateProposal(probe(null), context()).ok, true);
  assert.deepEqual(pick(validateProposal(probe(['r1', 'r2', 'r3']), context())), ['route_unavailable', 'bad_endpoint']);
  assert.deepEqual(pick(validateProposal(probe(['r0', 'r2', 'r3']), context())), ['route_unavailable', 'unknown_link']);
  assert.deepEqual(pick(validateProposal(probe(['r0', 'r1', 'r0', 'r3']), context())), ['route_unavailable', 'route_not_simple']);
});
