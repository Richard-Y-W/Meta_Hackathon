// P06: the typed power adapter over the real pandapower worker. Requires the SSD infrastructure
// environment (runtime/infra/requirements.lock); set LIFELINE_INFRA_PYTHON to use another interpreter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPowerAdapter, spawnPowerWorker } from '../../../src/lifeline/domains/power.mjs';
import { validateEnvelope } from '../../../src/lifeline/kernel/contracts.mjs';
import { scoreService } from '../../../src/lifeline/kernel/measurement.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PYTHON = process.env.LIFELINE_INFRA_PYTHON ?? `${ROOT}.work/environments/infra/bin/python`;
const skip = existsSync(PYTHON) ? false : `infrastructure Python not found at ${PYTHON}`;
const FEEDER = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/power/analytic.json', import.meta.url), 'utf8')).networks.feeder;
const S = 1_000_000;
const TRIP = [{ faultId: 'trip', atUs: 20 * S, type: 'line_trip', assetId: 'L2' }];

const action = (actionId, capabilityId, parameters, revision) => ({
  schemaVersion: 'infra-contract-v1', runId: 'run-p', domainId: 'power', sequence: 1, tickUs: 0, kind: 'action', actionId, capabilityId, parameters,
  preconditions: [{ type: 'configuration_revision', domainId: 'power', revision }], effectDeadlineUs: 0, lockSet: ['power:switches'], authorityGrant: 'grant-test', compensation: [],
});

async function session(t, faults = TRIP) {
  const worker = spawnPowerWorker({ python: PYTHON, root: ROOT });
  const adapter = createPowerAdapter({ worker });
  t.after(() => adapter.close());
  const init = await adapter.initialize({ runId: 'run-p', network: FEEDER, faults });
  assert.equal(init.ok, true);
  return adapter;
}

test('describe declares supported operations, units and exact limitations', { skip }, async t => {
  const adapter = await session(t);
  const d = adapter.describe();
  assert.equal(d.domainId, 'power');
  for (const op of ['checkpoint', 'restore', 'advance', 'preview']) assert.equal(d.operations[op], true);
  assert.ok(d.limitations.some(l => /transient/.test(l)));
  for (const cap of d.capabilities) assert.equal(validateEnvelope(cap).ok, true, cap.capabilityId);
});

test('observations are admitted envelopes in canonical units from declared sensors only', { skip }, async t => {
  const adapter = await session(t);
  await adapter.advance(5 * S);
  const { observations, configurationRevision } = await adapter.observe();
  assert.equal(configurationRevision, 0);
  assert.deepEqual(observations.map(o => o.assetId).sort(), FEEDER.sensors.map(s => s.assetId).sort());
  for (const o of observations) assert.equal(validateEnvelope(o, { runId: 'run-p' }).ok, true, o.observationId);
  const v = observations.find(o => o.assetId === 'hosp');
  assert.equal(v.quantity.unit, 'V');
  assert.ok(v.quantity.value > 0.95 * 12470 && v.observedAtUs === 5 * S);
  assert.doesNotMatch(JSON.stringify(observations), /fault|trip/);
});

test('a stale action is rejected with a receipt and changes nothing', { skip }, async t => {
  const adapter = await session(t);
  await adapter.advance(25 * S); // the trip at 20 s moved the configuration to revision 1
  const stale = await adapter.execute(action('a-stale', 'power.set_switch', { switchId: 'sw-tie', closed: true }, 0));
  assert.equal(stale.ok, false);
  assert.equal(stale.receipt.status, 'rejected');
  assert.equal(stale.receipt.reason, 'stale_command');
  assert.equal(validateEnvelope(stale.receipt, { runId: 'run-p' }).ok, true);
  const tie = (await adapter.observe()).observations.find(o => o.assetId === 'sw-tie');
  assert.equal(tie.quantity.value, 0);
  const fresh = await adapter.execute(action('a-fresh', 'power.set_switch', { switchId: 'sw-tie', closed: true }, 1));
  assert.equal(fresh.receipt.status, 'success');
  assert.deepEqual(await adapter.readback('a-fresh'), { ok: true, receipt: fresh.receipt });
  const dup = await adapter.execute(action('a-fresh', 'power.set_switch', { switchId: 'sw-tie', closed: true }, 1));
  assert.equal(dup.duplicate, true);
});

test('an action without a revision precondition or with an unknown parameter is refused before the worker', { skip }, async t => {
  const adapter = await session(t);
  const bare = { ...action('a1', 'power.set_switch', { switchId: 'sw-tie', closed: true }, 0), preconditions: [] };
  assert.equal((await adapter.validate(bare)).code, 'missing_revision_precondition');
  assert.equal((await adapter.validate(action('a2', 'power.set_switch', { switchId: 'sw-tie', closed: true, force: true }, 0))).code, 'unknown_parameter');
});

test('preview forecasts from the admitted model without mutating the live plant or seeing hidden faults', { skip }, async t => {
  const adapter = await session(t);
  await adapter.advance(5 * S);
  const before = await adapter.checkpoint();
  const open = await adapter.preview({ actions: [{ type: 'set_switch', params: { switchId: 'sw-main', closed: false } }], horizonUs: 60 * S });
  assert.equal(open.ok, true);
  assert.equal(open.forecast.kind, 'forecast');
  assert.equal(validateEnvelope(open.forecast, { runId: 'run-p' }).ok, true);
  assert.ok(open.forecast.outcomes.essentialUnservedJ > 0);
  const idle = await adapter.preview({ actions: [], horizonUs: 60 * S });
  assert.equal(idle.forecast.outcomes.essentialUnservedJ, 0); // the trip at 20 s is not in the admitted model
  const after = await adapter.checkpoint();
  assert.equal(after.hash, before.hash);
  assert.deepEqual(Object.keys(before).sort(), ['atUs', 'checkpointId', 'hash', 'ok']);
});

test('restore returns to the checkpoint and the evaluator measurement is cross-checked independently', { skip }, async t => {
  const adapter = await session(t);
  await adapter.advance(10 * S);
  const cp = await adapter.checkpoint();
  await adapter.advance(30 * S);
  assert.equal((await adapter.restore(cp)).ok, true);
  await adapter.advance(40 * S);
  const { measurements, crossCheck, cases } = await adapter.measure();
  for (const m of measurements) assert.equal(validateEnvelope(m, { runId: 'run-p' }).ok, true);
  const hospital = measurements.find(m => m.serviceId === 'hospital');
  assert.equal(hospital.demanded.value, 400000 * 40);
  assert.equal(hospital.supplied.value, 400000 * 20);
  assert.equal(crossCheck.ok, true);
  assert.equal(scoreService(cases.hospital).deficitIntegral, 400000 * 20);
});

test('a closed adapter refuses work and unsupported worker failures surface as codes', { skip }, async t => {
  const adapter = await session(t);
  assert.equal((await adapter.restore({ checkpointId: 'cp-404' })).code, 'unknown_checkpoint');
  await adapter.close();
  assert.equal((await adapter.observe()).code, 'adapter_closed');
});
