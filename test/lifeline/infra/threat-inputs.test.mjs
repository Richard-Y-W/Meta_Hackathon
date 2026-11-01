import test from 'node:test';
import assert from 'node:assert/strict';
import { admitThreatInput, reconcile } from '../../../src/lifeline/kernel/threat-inputs.mjs';

const S = 1_000_000;
const ctx = {
  nowUs: 1000 * S, knownAssets: ['PU1', 'T1', 'line-2-3'], maxAgeUs: { alarm: 120 * S, operator_report: 900 * S, hazard_forecast: 6 * 3600 * S, maintenance: 86400 * S },
  sources: { scada: { kind: 'telemetry', types: ['alarm'] }, crew: { kind: 'human', types: ['operator_report'] }, met: { kind: 'external', types: ['hazard_forecast'] }, cmms: { kind: 'records', types: ['maintenance'] } },
  hiddenFaults: [{ faultId: 'pu1-out', atUs: 1800 * S }],
};
const alarm = o => ({ type: 'alarm', sourceId: 'scada', issuedAtUs: 950 * S, assetId: 'PU1', condition: 'degraded', ...o });

test('admitted inputs carry provenance and age', () => {
  const r = admitThreatInput(alarm(), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.input.provenance, { sourceId: 'scada', sourceKind: 'telemetry', admittedAtUs: 1000 * S, ageUs: 50 * S });
  assert.equal(admitThreatInput({ type: 'hazard_forecast', sourceId: 'met', issuedAtUs: 0, hazard: 'wind', area: 'feeder-1', window: [3600 * S, 7200 * S], probability: 0.3 }, ctx).ok, true);
});

test('provenance, timing and schema failures are refused', () => {
  const cases = [
    [alarm({ sourceId: 'rumor' }), 'unknown_source'],
    [alarm({ sourceId: 'crew' }), 'source_not_authorized_for_type'],
    [alarm({ issuedAtUs: 1001 * S }), 'issued_in_future'],
    [alarm({ issuedAtUs: 800 * S }), 'stale_input'],
    [alarm({ assetId: 'PU9' }), 'unknown_asset'],
    [alarm({ condition: 'on fire maybe' }), 'invalid_condition'],
    [{ type: 'rumor', sourceId: 'scada', issuedAtUs: 0 }, 'unknown_input_type'],
    [{ type: 'maintenance', sourceId: 'cmms', issuedAtUs: 0, assetId: 'PU1', effect: 'unavailable' }, 'missing_field'],
  ];
  for (const [input, code] of cases) assert.equal(admitThreatInput(input, ctx).code, code, code);
});

test('no input may expose an injected fault', () => {
  assert.equal(admitThreatInput(alarm({ faultId: 'pu1-out' }), ctx).code, 'information_boundary_violation');
  assert.equal(admitThreatInput(alarm({ note: 'expect pu1-out soon' }), ctx).code, 'information_boundary_violation');
  assert.equal(admitThreatInput(alarm({ groundTruth: true }), ctx).code, 'information_boundary_violation');
});

test('contradictory reports stay side by side; agreeing reports keep the latest', () => {
  const admitted = [
    admitThreatInput(alarm({ issuedAtUs: 940 * S, condition: 'degraded' }), ctx).input,
    admitThreatInput({ type: 'operator_report', sourceId: 'crew', issuedAtUs: 960 * S, assetId: 'PU1', condition: 'operational', reporter: 'crew-2' }, ctx).input,
    admitThreatInput({ type: 'operator_report', sourceId: 'crew', issuedAtUs: 900 * S, assetId: 'T1', condition: 'at_risk', reporter: 'crew-1' }, ctx).input,
    admitThreatInput({ type: 'operator_report', sourceId: 'crew', issuedAtUs: 990 * S, assetId: 'T1', condition: 'at_risk', reporter: 'crew-3' }, ctx).input,
  ];
  const r = Object.fromEntries(reconcile(admitted, { windowUs: 300 * S }).map(x => [x.assetId, x]));
  assert.equal(r.PU1.status, 'contradictory');
  assert.equal(r.PU1.reports.length, 2);
  assert.deepEqual([r.T1.status, r.T1.condition], ['consistent', 'at_risk']);
});
