import test from 'node:test';
import assert from 'node:assert/strict';
import { admitObservation, auditControllerView } from '../../src/lifeline/telemetry.mjs';

const obs = (o = {}) => ({
  version: 'ObservationV1', runId: 'run-1', seq: 5, sampleIntervalMs: 500, collectedAtMs: 1000, ageMs: 3,
  topologyRevision: 1, configRevision: 1,
  links: { 'r0-r3': { state: 'down', txBytes: { r0: 10, r3: null } } },
  services: { 'dispatch-clinic': { offered: 80, transmissions: 90, acked: 70, ackedWithinDeadline: 60 } },
  ...o,
});

test('an observation is admitted with age recomputed on the supervisor clock', () => {
  const result = admitObservation(obs(), { runId: 'run-1', nowMs: 1600, lastSeq: 4, maxAgeMs: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.observation.ageMs, 600);
  assert.equal(result.observation.stale, false);
  assert.equal(admitObservation(obs(), { runId: 'run-1', nowMs: 3001, lastSeq: 4, maxAgeMs: 2000 }).observation.stale, true);
});

test('wrong run, version, repeated sequence and future collection are rejected', () => {
  const ctx = { runId: 'run-1', nowMs: 1600, lastSeq: 4, maxAgeMs: 2000 };
  assert.equal(admitObservation(obs({ runId: 'run-2' }), ctx).code, 'run_mismatch');
  assert.equal(admitObservation(obs({ version: 'ObservationV0' }), ctx).code, 'unsupported_version');
  assert.equal(admitObservation(obs({ seq: 4 }), ctx).code, 'non_monotonic_sequence');
  assert.equal(admitObservation(obs({ collectedAtMs: 1700 }), ctx).code, 'future_observation');
});

test('missing counters remain null instead of becoming zero', () => {
  const { observation } = admitObservation(obs(), { runId: 'run-1', nowMs: 1600, lastSeq: 0, maxAgeMs: 2000 });
  assert.equal(observation.links['r0-r3'].txBytes.r3, null);
});

test('the controller-view audit finds fault labels, schedules and configured capacity', () => {
  assert.deepEqual(auditControllerView([obs()], [{ atMs: 65000, kind: 'link_rate', linkId: 'r1-r2', bwMbit: 3 }]), []);
  const leaked = obs({ links: { 'r1-r2': { state: 'up', bwMbit: 3 } }, faults: [{ kind: 'link_down' }] });
  const findings = auditControllerView([leaked], [{ atMs: 65000, kind: 'link_rate', linkId: 'r1-r2', bwMbit: 3 }]);
  assert.ok(findings.some(f => f.key === 'bwMbit'));
  assert.ok(findings.some(f => f.key === 'faults'));
  assert.ok(auditControllerView([obs({ note: 'link_rate at 65000' })], []).some(f => f.value === 'link_rate'));
});
