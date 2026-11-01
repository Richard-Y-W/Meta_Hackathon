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

import { deriveRates } from '../../src/lifeline/telemetry.mjs';

const sample = (atMs, txR1, drops, offered, onTime, backlog = 0) => obs({
  seq: atMs, collectedAtMs: atMs,
  links: { 'r1-r2': { state: 'up', txBytes: { r1: txR1, r2: 0 }, queueDrops: { r1: drops, r2: 0 }, backlogBytes: { r1: backlog, r2: 0 } } },
  services: { 'dispatch-clinic': { offered, transmissions: offered, acked: onTime, ackedWithinDeadline: onTime } },
});

test('rates: link throughput, drop rate and backlog per directed link end from consecutive samples', () => {
  const history = [sample(1000, 0, 0, 0, 0), sample(2000, 1_000_000, 50, 80, 80, 12_000)];
  const derived = deriveRates(history);
  assert.equal(derived.links['r1-r2'].r1.txBps, 8_000_000);
  assert.equal(derived.links['r1-r2'].r1.dropsPerS, 50);
  assert.equal(derived.links['r1-r2'].r1.backlogBytes, 12_000);
});

test('rates: recent on-time fraction uses only messages whose deadline has passed', () => {
  const at = (t, resolvedOffered, resolvedOnTime) => ({ ...sample(t, 0, 0, resolvedOffered + 40, resolvedOnTime), services: { 'dispatch-clinic': { offered: resolvedOffered + 40, transmissions: resolvedOffered + 40, acked: resolvedOnTime, ackedWithinDeadline: resolvedOnTime, resolvedOffered, resolvedOnTime } } });
  const history = [at(1000, 0, 0), at(2000, 80, 80), at(3000, 160, 140)];
  assert.equal(deriveRates(history, { windowMs: 1000 }).services['dispatch-clinic'].recentOnTimeFraction, 60 / 80);
  assert.equal(deriveRates(history, { windowMs: 2000 }).services['dispatch-clinic'].recentOnTimeFraction, 140 / 160);
  // After traffic stops nothing new resolves: the fraction is unknown, not a failure.
  const stopped = [...history, at(4000, 160, 140)];
  assert.equal(deriveRates(stopped, { windowMs: 1000 }).services['dispatch-clinic'].recentOnTimeFraction, null);
});

test('rates: missing or reset counters yield null rates, never zero or negative', () => {
  const reset = [sample(1000, 5_000_000, 10, 100, 100), sample(2000, 1_000, 2, 180, 180)];
  assert.equal(deriveRates(reset).links['r1-r2'].r1.txBps, null);
  const missing = [sample(1000, null, null, 0, 0), sample(2000, 100, 1, 80, 80)];
  assert.equal(deriveRates(missing).links['r1-r2'].r1.txBps, null);
  assert.equal(deriveRates([sample(1000, 0, 0, 0, 0)]).links['r1-r2'].r1.txBps, null);
});
