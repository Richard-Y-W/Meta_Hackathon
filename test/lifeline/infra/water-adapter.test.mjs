// P08: the typed water adapter over the real EPANET/WNTR worker. Requires the SSD water environment
// (.work/environments/water); set LIFELINE_WATER_PYTHON to use another interpreter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWaterAdapter, spawnWaterWorker } from '../../../src/lifeline/domains/water.mjs';
import { validateEnvelope } from '../../../src/lifeline/kernel/contracts.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PYTHON = process.env.LIFELINE_WATER_PYTHON ?? `${ROOT}.work/environments/water/bin/python`;
const skip = existsSync(PYTHON) ? false : `water Python not found at ${PYTHON}`;
const ANALYTIC = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/water/networks.json', import.meta.url), 'utf8')).networks.analytic;
const S = 1_000_000;
const OUTAGE = [{ faultId: 'pump-out', atUs: 600 * S, type: 'pump_outage', assetId: 'PU1' }];

const action = (actionId, capabilityId, parameters, revision) => ({
  schemaVersion: 'infra-contract-v1', runId: 'run-w', domainId: 'water', sequence: 1, tickUs: 0, kind: 'action', actionId, capabilityId, parameters,
  preconditions: [{ type: 'configuration_revision', domainId: 'water', revision }], effectDeadlineUs: 0, lockSet: ['water:links'], authorityGrant: 'grant-test', compensation: [],
});

async function session(t, faults = OUTAGE) {
  const adapter = createWaterAdapter({ worker: spawnWaterWorker({ python: PYTHON, root: ROOT }) });
  t.after(() => adapter.close());
  const init = await adapter.initialize({ runId: 'run-w', network: ANALYTIC, faults });
  assert.equal(init.ok, true, init.code);
  return adapter;
}

test('describe declares replay restart and an unqualified quality model', { skip }, async t => {
  const adapter = await session(t);
  const d = adapter.describe();
  assert.equal(d.domainId, 'water');
  assert.equal(d.operations.checkpoint, true);
  assert.ok(d.limitations.some(l => /replay/.test(l)) && d.limitations.some(l => /water-quality/.test(l)));
  for (const cap of d.capabilities) assert.equal(validateEnvelope(cap).ok, true, cap.capabilityId);
});

test('observations are admitted canonical envelopes; a frozen sensor is labeled stale by age', { skip }, async t => {
  const adapter = await session(t, [{ faultId: 'fz', atUs: 120 * S, type: 'sensor_freeze', assetId: 'lv-T1' }]);
  await adapter.advance(600 * S);
  const { observations } = await adapter.observe();
  for (const o of observations) assert.equal(validateEnvelope(o, { runId: 'run-w' }).ok, true, o.observationId);
  const level = observations.find(o => o.assetId === 'T1');
  assert.equal(level.quantity.unit, 'm');
  assert.equal(level.quality, 'stale');
  assert.equal(level.observedAtUs, 120 * S);
  const pressure = observations.find(o => o.metric === 'water.pressure');
  assert.equal(pressure.quantity.unit, 'Pa');
  assert.equal(pressure.quality, 'good');
});

test('stale and unavailable-actuator commands come back as rejected receipts', { skip }, async t => {
  const adapter = await session(t);
  await adapter.advance(660 * S); // pump outage at 600 s: revision 1, PU1 unavailable
  const stale = await adapter.execute(action('w-stale', 'water.set_link', { linkId: 'P3', open: true }, 0));
  assert.equal(stale.receipt.reason, 'stale_command');
  const unavailable = await adapter.execute(action('w-pump', 'water.set_pump', { pumpId: 'PU1', on: true }, 1));
  assert.equal(unavailable.receipt.reason, 'actuator_unavailable');
  const fresh = await adapter.execute(action('w-open', 'water.set_link', { linkId: 'P3', open: true }, 1));
  assert.equal(fresh.receipt.status, 'success');
  assert.equal(validateEnvelope(fresh.receipt, { runId: 'run-w' }).ok, true);
});

test('preview forecasts from the admitted model without mutating the plant or seeing the outage', { skip }, async t => {
  const adapter = await session(t);
  await adapter.advance(300 * S);
  const before = await adapter.checkpoint();
  const idle = await adapter.preview({ actions: [], horizonUs: 3000 * S });
  const off = await adapter.preview({ actions: [{ type: 'set_pump', params: { pumpId: 'PU1', on: false } }], horizonUs: 3000 * S });
  assert.equal(validateEnvelope(idle.forecast, { runId: 'run-w' }).ok, true);
  assert.equal(idle.forecast.outcomes.essentialUnmetM3, 0);
  assert.ok(off.forecast.outcomes.essentialUnmetM3 > 0);
  assert.equal((await adapter.checkpoint()).hash, before.hash);
});

test('restore by replay and dual-scorer measurement', { skip }, async t => {
  const adapter = await session(t);
  await adapter.advance(300 * S);
  const cp = await adapter.checkpoint();
  await adapter.advance(1800 * S);
  assert.equal((await adapter.restore(cp)).ok, true);
  await adapter.advance(2400 * S);
  const { measurements, crossCheck, summary } = await adapter.measure();
  for (const m of measurements) assert.equal(validateEnvelope(m, { runId: 'run-w' }).ok, true);
  assert.equal(crossCheck.ok, true);
  assert.ok(summary.byNode.JD.deficitM3 > 0); // pump out at 600 s; the tank empties before 2400 s
  assert.equal(summary.qualityModelQualified, false);
});
