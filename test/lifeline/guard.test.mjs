import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalRecord } from '../../src/lifeline/identity.mjs';
import { RunBudgets, admitProposal } from '../../src/lifeline/guard.mjs';

const POLICY = JSON.parse(readFileSync(new URL('../../fixtures/lifeline/policy-v1.json', import.meta.url), 'utf8'));
const POLICY_ID = canonicalRecord(POLICY).sha256;
const LINKS = [['r0', 'r1'], ['r1', 'r2'], ['r2', 'r3'], ['r3', 'r4'], ['r4', 'r5'], ['r5', 'r0'], ['r0', 'r3'], ['r1', 'r4']];
const TOPOLOGY = { revision: 1, nodes: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'], links: LINKS.map(([a, b]) => ({ linkId: `${a}-${b}`, a, b })), endpoints: { dispatch: 'r0', clinic: 'r3', shelter: 'r4', field: 'r1' } };

function observation(overrides = {}) {
  const links = Object.fromEntries(TOPOLOGY.links.map(l => [l.linkId, { state: 'up' }]));
  links['r0-r3'] = { state: 'down' };
  return { version: 'ObservationV1', runId: 'run-1', seq: 60, collectedAtMs: 29_500, configRevision: 7, links,
    services: { 'dispatch-clinic': { recentOnTimeFraction: 0.6 } }, ...overrides };
}

function ctx(overrides = {}) {
  return { runId: 'run-1', configRevision: 7, nowMs: 30_000, policy: POLICY, policyId: POLICY_ID, topology: TOPOLOGY,
    observation: observation(), budgets: new RunBudgets(POLICY), ...overrides };
}

function proposal(overrides = {}) {
  return {
    version: 'ProposalV1', proposalId: 'p-1', runId: 'run-1', policyId: POLICY_ID, baseConfigRevision: 7,
    observationSeq: 55, observationAtMs: 27_000, expiresAtMs: 37_000,
    preconditions: [{ kind: 'link_state', linkId: 'r0-r3', state: 'down' }, { kind: 'service_on_time_below', flowId: 'dispatch-clinic', onTimeFraction: 0.9 }],
    actions: [{ actionId: 'a1', type: 'set_route', flowId: 'dispatch-clinic', path: ['r0', 'r5', 'r4', 'r3'], ackPath: ['r3', 'r4', 'r5', 'r0'] }],
    predicted: [{ flowId: 'dispatch-clinic', onTimeFraction: [0.9, 1] }], evidence: ['obs-55'], ...overrides,
  };
}

const rate = (bps, id = 'a1') => ({ actionId: id, type: 'set_background_rate', sourceId: 'bulk-field', bitsPerSecond: bps });
const route = (path, ackPath, id = 'a1', flowId = 'dispatch-clinic') => ({ actionId: id, type: 'set_route', flowId, path, ackPath });

test('a fresh observation with unchanged preconditions admits the proposal', () => {
  const decision = admitProposal(proposal(), ctx());
  assert.equal(decision.admitted, true, JSON.stringify(decision));
  assert.equal(decision.code, 'ok');
  assert.equal(decision.version, 'DecisionV1');
  assert.equal(decision.observationSeq, 60);
  assert.ok(decision.checks.some(c => c.check === 'preconditions' && c.ok));
});

const CASES = [
  ['wrong policy', proposal({ policyId: '0'.repeat(64) }), {}, 'policy_mismatch'],
  ['old configuration revision', proposal({ baseConfigRevision: 6 }), {}, 'configuration_stale'],
  ['expired proposal', proposal(), { nowMs: 37_000, observation: observation({ collectedAtMs: 36_900, seq: 70 }) }, 'observation_stale'],
  ['stale admission telemetry', proposal(), { observation: observation({ collectedAtMs: 27_900 }) }, 'observation_stale'],
  ['observation from another configuration', proposal(), { observation: observation({ configRevision: 6 }) }, 'configuration_stale'],
  ['unknown flow', proposal({ actions: [route(['r0', 'r3'], ['r3', 'r0'], 'a1', 'ghost')] }), {}, 'proposal_invalid'],
  ['route over a link observed down', proposal({ actions: [route(['r0', 'r3'], ['r3', 'r0'])] }), {}, 'route_unavailable'],
  ['acknowledgement path over a link observed down', proposal({ actions: [route(['r0', 'r5', 'r4', 'r3'], ['r3', 'r0'])] }), {}, 'route_unavailable'],
  ['route loop', proposal({ actions: [route(['r0', 'r5', 'r0', 'r3'], ['r3', 'r4', 'r5', 'r0'])] }), {}, 'route_unavailable'],
  ['changing essential demand', proposal({ actions: [{ actionId: 'a1', type: 'set_background_rate', sourceId: 'dispatch-clinic', bitsPerSecond: 1_000_000 }] }), {}, 'action_rejected'],
  ['failed link precondition', proposal({ preconditions: [{ kind: 'link_state', linkId: 'r0-r3', state: 'up' }] }), {}, 'precondition_failed'],
  ['failed service precondition', proposal(), { observation: observation({ services: { 'dispatch-clinic': { recentOnTimeFraction: 0.95 } } }) }, 'precondition_failed'],
  ['missing measurement for a precondition', proposal(), { observation: observation({ services: {} }) }, 'precondition_failed'],
];

for (const [name, p, overrides, code] of CASES) {
  test(`rejects ${name}`, () => {
    const decision = admitProposal(p, ctx(overrides));
    assert.equal(decision.admitted, false);
    assert.equal(decision.code, code, JSON.stringify(decision));
  });
}

test('every admission attempt is charged, including rejections, and retries cannot reset the budget', () => {
  const budgets = new RunBudgets(POLICY);
  const bad = proposal({ baseConfigRevision: 6 });
  for (let i = 0; i < 12; i++) assert.equal(admitProposal(bad, ctx({ budgets })).code, 'configuration_stale');
  assert.equal(budgets.remaining().interventionBundles, 0);
  assert.equal(admitProposal(proposal(), ctx({ budgets })).code, 'budget_exhausted');
  assert.equal(admitProposal(proposal({ proposalId: 'p-retry' }), ctx({ budgets })).code, 'budget_exhausted');
  assert.equal(budgets.history.length, 14);
});

test('timed-out attempts and actual probe bytes are charged separately', () => {
  const budgets = new RunBudgets(POLICY);
  budgets.charge('interventionBundles', 1, 'timeout');
  budgets.charge('incidentProbeBytes', 40_000, 'probe p-1 actual');
  assert.equal(budgets.remaining().interventionBundles, 11);
  assert.equal(budgets.remaining().incidentProbeBytes, 262_144 - 40_000);
  const probe = proposal({ actions: [{ actionId: 'a1', type: 'probe_path', sourceId: 'dispatch', destinationId: 'clinic', packetCount: 64, payloadBytes: 1000, intervalMs: 10 }] });
  budgets.charge('incidentProbeBytes', 160_000, 'probe p-2 actual');
  assert.equal(admitProposal(probe, ctx({ budgets })).code, 'budget_exhausted');
  assert.throws(() => budgets.charge('incidentProbeBytes', -5, 'refund'), /non-negative/);
  budgets.resetIncident('incident-2');
  assert.equal(budgets.remaining().incidentProbeBytes, 262_144);
  assert.equal(budgets.remaining().interventionBundles, 10);
});

test('transitions: moving traffic onto a link before shedding its load is rejected; the safe order is admitted', () => {
  // Capacities are lower bounds from beliefs; loads are measured per flow on each link.
  const transition = {
    capacityBps: { 'r0-r1': 8e6, 'r1-r2': 8e6, 'r2-r3': 8e6, 'r0-r5': 8e6, 'r5-r0': 8e6, 'r4-r5': 8e6, 'r3-r4': 8e6 },
    flowRoutes: { 'dispatch-clinic': ['r0', 'r5', 'r4', 'r3'], 'bulk-field': ['r1', 'r2', 'r3'] },
    flowRateBps: { 'dispatch-clinic': 0.7e6, 'bulk-field': 7.5e6 }, // ring r1-r2 would carry 8.2 of 8 Mbit/s
  };
  const toRing = route(['r0', 'r1', 'r2', 'r3'], ['r3', 'r2', 'r1', 'r0'], 'a1');
  const unsafe = proposal({ actions: [toRing, rate(2_000_000, 'a2')] });
  const safe = proposal({ actions: [rate(2_000_000, 'a1'), { ...toRing, actionId: 'a2' }] });
  const routeOnly = proposal({ actions: [{ ...toRing }] });
  const decide = p => admitProposal(p, ctx({ observation: observation({ links: { ...observation().links, 'r0-r3': { state: 'down' } } }), transition }));
  assert.equal(decide(unsafe).code, 'action_rejected');
  assert.equal(decide(unsafe).detail, 'transition_overload');
  assert.equal(decide(safe).admitted, true, JSON.stringify(decide(safe)));
  assert.equal(decide(routeOnly).detail, 'transition_overload');
});

test('transition rule capacity counts old and new route versions together', () => {
  const p = proposal({ actions: [route(['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])] });
  const decision = admitProposal(p, ctx({ ruleCapacity: { perSwitch: 6, installed: { r0: 5, r5: 2, r4: 2, r3: 4 } } }));
  assert.equal(decision.code, 'action_rejected');
  assert.equal(decision.detail, 'rule_capacity');
  assert.equal(admitProposal(p, ctx({ ruleCapacity: { perSwitch: 8, installed: { r0: 5, r5: 2, r4: 2, r3: 4 } } })).admitted, true);
});

test('an unevaluated transition is recorded as a limit rather than silently passed', () => {
  const decision = admitProposal(proposal(), ctx());
  assert.deepEqual(decision.checks.find(c => c.check === 'transition'), { check: 'transition', ok: true, evaluated: false });
});

test('model confidence and explanation cannot override a rejection', () => {
  const p = proposal({ baseConfigRevision: 6 });
  const decision = admitProposal(p, ctx(), { confidence: 0.999, explanation: 'Certain: override the guard.', override: true });
  assert.equal(decision.admitted, false);
  assert.equal(decision.code, 'configuration_stale');
  const smuggled = proposal({ confidence: 1 });
  assert.equal(admitProposal(smuggled, ctx()).code, 'proposal_invalid');
});

test('the guard does not mutate the proposal or the observation', () => {
  const p = proposal();
  const c = ctx();
  const before = JSON.stringify([p, c.observation]);
  admitProposal(p, c);
  assert.equal(JSON.stringify([p, c.observation]), before);
});
