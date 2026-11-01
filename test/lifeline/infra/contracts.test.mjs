import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvelope, admitQuantity, validatePlanBinding, CONTRACT } from '../../../src/lifeline/kernel/contracts.mjs';

const envelope = (o = {}) => ({ schemaVersion: 'infra-contract-v1', runId: 'run-1', domainId: 'water', sequence: 4, tickUs: 12_000_000, kind: 'observation', ...o });
const validObservation = envelope({
  observationId: 'obs-4', assetId: 'pump-1', metric: 'water.flow', quantity: { value: 0.012, unit: 'm3/s' },
  observedAtUs: 11_900_000, receivedAtUs: 12_000_000, quality: 'good', sourceId: 'scada', configurationRevision: 3,
});

test('a canonical observation is admitted', () => {
  assert.deepEqual(validateEnvelope(validObservation), { ok: true, code: 'ok' });
});

test('a water flow supplied as electrical power is a unit mismatch', () => {
  const candidate = { ...validObservation, metric: 'water.flow', quantity: { value: 1, unit: 'W' } };
  assert.deepEqual(validateEnvelope(candidate), { ok: false, code: 'unit_mismatch' });
});

test('non-canonical but convertible units are refused inside the kernel; conversion happens at admission', () => {
  assert.equal(validateEnvelope({ ...validObservation, quantity: { value: 12, unit: 'L/s' } }).code, 'unit_not_canonical');
  assert.deepEqual(admitQuantity('water.flow', { value: 12, unit: 'L/s' }), { ok: true, quantity: { value: 0.012, unit: 'm3/s' } });
  assert.deepEqual(admitQuantity('power.active', { value: 2.5, unit: 'kW' }), { ok: true, quantity: { value: 2500, unit: 'W' } });
  assert.equal(admitQuantity('water.flow', { value: 1, unit: 'kW' }).code, 'unit_mismatch');
  assert.equal(admitQuantity('water.colour', { value: 1, unit: '1' }).code, 'unknown_metric');
});

test('negative or fractional times are rejected; clocks are integer microseconds', () => {
  assert.equal(validateEnvelope(envelope({ ...validObservation, tickUs: -1 })).code, 'negative_time');
  assert.equal(validateEnvelope({ ...validObservation, observedAtUs: 1.5 }).code, 'invalid_time');
  assert.equal(validateEnvelope({ ...validObservation, receivedAtUs: 11_000_000 }).code, 'time_order');
});

test('incompatible schema versions, unknown kinds and unknown fields are rejected', () => {
  assert.equal(validateEnvelope({ ...validObservation, schemaVersion: 'infra-contract-v2' }).code, 'unsupported_version');
  assert.equal(validateEnvelope({ ...validObservation, kind: 'gossip' }).code, 'unknown_kind');
  assert.equal(validateEnvelope({ ...validObservation, confidence: 'very high' }).code, 'unknown_field');
});

test('a missing value is null with a reason, never zero', () => {
  assert.equal(validateEnvelope({ ...validObservation, quantity: { value: null, unit: 'm3/s', missingReason: 'sensor_offline' }, quality: 'missing' }).ok, true);
  assert.equal(validateEnvelope({ ...validObservation, quantity: { value: null, unit: 'm3/s' }, quality: 'missing' }).code, 'missing_reason_required');
  assert.equal(validateEnvelope({ ...validObservation, quantity: { value: 0, unit: 'm3/s' }, quality: 'missing' }).code, 'missing_as_zero');
  assert.equal(validateEnvelope({ ...validObservation, quantity: { value: NaN, unit: 'm3/s' } }).code, 'nonfinite_number');
});

const capability = envelope({ kind: 'capability', domainId: 'communications', capabilityId: 'comms.set_route', actionType: 'set_route',
  parameters: { flowId: 'id', path: 'path', ackPath: 'path' }, assets: ['r0', 'r1'], authorityModes: ['recommend', 'bounded_auto'],
  limits: {}, expectedDurationUs: 2_000_000, reversible: true, effectChecks: ['traffic_on_new_version'] });

test('an action naming an unknown capability is refused', () => {
  const action = envelope({ kind: 'action', domainId: 'communications', actionId: 'a1', capabilityId: 'comms.reboot_switch', parameters: {}, preconditions: [], effectDeadlineUs: 20_000_000, lockSet: ['r0'], authorityGrant: 'g1', compensation: 'stop' });
  assert.equal(validateEnvelope(action, { capabilities: [capability] }).code, 'unknown_capability');
  assert.equal(validateEnvelope({ ...action, capabilityId: 'comms.set_route', parameters: { flowId: 'dispatch-clinic', path: ['r0', 'r3'], ackPath: ['r3', 'r0'] } }, { capabilities: [capability] }).ok, true);
  assert.equal(validateEnvelope({ ...action, capabilityId: 'comms.set_route', parameters: { flowId: 'x', path: ['r0'], ackPath: ['r0'], force: true } }, { capabilities: [capability] }).code, 'unknown_parameter');
});

const plan = (o = {}) => envelope({ kind: 'plan', domainId: 'coordinator', planId: 'plan-1', proposer: 'meta', sourceObservations: [{ runId: 'run-1', observationId: 'obs-4' }],
  sourceHash: 'a'.repeat(64), expectedConfigurationRevisions: { communications: 3, water: 7 }, modelVersion: 'm1', policyVersion: 'p1', expiresAtUs: 30_000_000, actions: ['a1'], budgets: {}, forecasts: [], rationale: [], ...o });

test('plans are bound to their run, evidence and configuration revisions', () => {
  const ctx = { runId: 'run-1', nowUs: 20_000_000, configurationRevisions: { communications: 3, water: 7 } };
  assert.deepEqual(validatePlanBinding(plan(), ctx), { ok: true, code: 'ok' });
  assert.equal(validatePlanBinding(plan({ sourceObservations: [{ runId: 'run-0', observationId: 'obs-4' }] }), ctx).code, 'cross_run_reference');
  assert.equal(validatePlanBinding(plan(), { ...ctx, configurationRevisions: { communications: 4, water: 7 } }).code, 'configuration_stale');
  assert.equal(validatePlanBinding(plan(), { ...ctx, nowUs: 30_000_000 }).code, 'plan_expired');
  assert.equal(validatePlanBinding(plan({ runId: 'run-2' }), ctx).code, 'cross_run_reference');
});

test('every registered metric has exactly one canonical unit', () => {
  assert.equal(CONTRACT.metrics['water.flow'], 'm3/s');
  assert.equal(new Set(Object.keys(CONTRACT.metrics)).size, Object.keys(CONTRACT.metrics).length);
});

import { defineServices } from '../../../src/lifeline/kernel/services.mjs';

const service = o => envelope({ kind: 'service', domainId: 'water', serviceId: 'clinic-water', consumer: 'clinic', metric: 'water.flow', demandScheduleRef: 'sched-1', priorityTier: 1, equationVersion: 'v1', ...o });

test('service registry: unique IDs, registered metrics and positive integer priority tiers', () => {
  assert.equal(defineServices([service(), service({ serviceId: 'shelter-water', consumer: 'shelter', priorityTier: 2 })]).ok, true);
  assert.equal(defineServices([service(), service()]).code, 'duplicate_service');
  assert.equal(defineServices([service({ metric: 'water.colour' })]).code, 'unknown_metric');
  assert.equal(defineServices([service({ priorityTier: 0 })]).code, 'invalid_priority');
  assert.equal(defineServices([service({ demandScheduleRef: '' })]).code, 'invalid_schedule_ref');
});
