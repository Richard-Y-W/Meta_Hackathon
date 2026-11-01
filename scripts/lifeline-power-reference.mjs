// P06 evidence: one CIGRE MV reference run through the typed power adapter and the pandapower worker.
// A line trip de-energizes part of feeder 1; the conventional tie closure restores it after a fixed delay.
// Measurements come from the worker's private ledger and are scored by the Python and Node scorers.
//   node scripts/lifeline-power-reference.mjs --out artifacts/lifeline/infra/p06-run-0/reference [--python PATH]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPowerAdapter, spawnPowerWorker } from '../src/lifeline/domains/power.mjs';
import { recoveryTime } from '../src/lifeline/kernel/measurement.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const out = resolve(arg('--out', join(ROOT, 'artifacts/lifeline/infra/p06-run-0/reference')));
const python = arg('--python', process.env.LIFELINE_INFRA_PYTHON ?? join(ROOT, '.work/environments/infra/bin/python'));
const admitted = admitOutputPath(ROOT, out);
if (!admitted.ok) { console.error(JSON.stringify(admitted)); process.exit(2); }
mkdirSync(out, { recursive: true });

const fixturePath = join(ROOT, 'fixtures/lifeline/infra/power/reference.json');
const fixtureText = readFileSync(fixturePath, 'utf8');
const { scenario, ...network } = JSON.parse(fixtureText);
const S = 1_000_000;
const runId = 'p06-reference-0';

const adapter = createPowerAdapter({ worker: spawnPowerWorker({ python, root: ROOT }) });
const trace = [];
const snapshot = async label => {
  const o = await adapter.observe();
  if (!o.ok) throw new Error(`observe failed: ${o.code}`);
  const row = { label, atUs: o.observations[0].observedAtUs, configurationRevision: o.configurationRevision, solveStatus: o.solveStatus,
    readings: Object.fromEntries(o.observations.map(x => [x.sourceId.replace(/^sensor:/, ''), x.quantity.value])) };
  trace.push(row);
  return row;
};
const started = Date.now();
try {
  const init = await adapter.initialize({ runId, network, faults: scenario.faults });
  if (!init.ok) throw new Error(`initialize failed: ${init.code} ${init.detail ?? ''}`);
  await snapshot('initial');
  await adapter.advance(55 * S); await snapshot('pre-fault');
  await adapter.advance(65 * S); await snapshot('post-trip');
  const restoreAt = scenario.conventionalRestoration.atUs;
  await adapter.advance(restoreAt);
  const before = await snapshot('before-restoration');
  const plan = { actions: [{ type: 'set_switch', params: scenario.conventionalRestoration.parameters }], horizonUs: 60 * S };
  const forecastTie = await adapter.preview(plan);
  const forecastIdle = await adapter.preview({ actions: [], horizonUs: 60 * S });
  const action = {
    schemaVersion: 'infra-contract-v1', runId, domainId: 'power', sequence: 1, tickUs: restoreAt, kind: 'action', actionId: 'conventional-tie-s1',
    capabilityId: scenario.conventionalRestoration.capabilityId, parameters: scenario.conventionalRestoration.parameters,
    preconditions: [{ type: 'configuration_revision', domainId: 'power', revision: before.configurationRevision }], effectDeadlineUs: restoreAt + S,
    lockSet: ['power:sw-S1'], authorityGrant: 'conventional-baseline', compensation: [],
  };
  const executed = await adapter.execute(action);
  await adapter.advance(restoreAt + 5 * S); await snapshot('after-restoration');
  await adapter.advance(scenario.durationUs); await snapshot('end');
  const measured = await adapter.measure();
  if (!measured.ok) throw new Error(`measure failed: ${measured.code}`);

  const tripAt = scenario.faults[0].atUs;
  const recovery = Object.fromEntries(measured.essential.map(loadId => {
    const c = measured.cases[loadId];
    const series = c.supply.map((s, i) => ({ atUs: s.atUs, fraction: s.value === null ? 0 : s.value / c.demand[i].value }));
    return [loadId, recoveryTime({ threshold: 0.99, sustainUs: 30 * S, incidentAtUs: tripAt, series, endUs: c.toUs })];
  }));
  const essential = measured.essential.map(id => measured.summary.byLoad[id]);
  const summary = {
    schema: 'lifeline.power-reference-run.v1', runId, fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'), modelVersion: init.modelVersion,
    provenance: network.provenance, durationUs: scenario.durationUs, faults: scenario.faults, conventionalRestoration: scenario.conventionalRestoration,
    receipt: executed.receipt, forecasts: { tieClosure: forecastTie.forecast, idle: forecastIdle.forecast },
    essentialDemandJ: measured.summary.essentialDemandJ, essentialUnservedJ: measured.summary.essentialUnservedJ,
    essentialServedFraction: essential.reduce((s, r) => s + r.servedJ, 0) / measured.summary.essentialDemandJ,
    recovery, crossCheck: measured.crossCheck, status: measured.summary.status, wallSeconds: (Date.now() - started) / 1000,
  };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(out, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  writeFileSync(join(out, 'measurements.json'), `${JSON.stringify(measured.measurements, null, 2)}\n`);
  writeFileSync(join(out, 'service-cases.private.json'), `${JSON.stringify({ cases: measured.cases, pythonSummary: measured.summary }, null, 2)}\n`);
  console.log(JSON.stringify({ status: summary.status, essentialUnservedJ: summary.essentialUnservedJ, essentialServedFraction: summary.essentialServedFraction,
    receipt: summary.receipt.status, crossCheck: summary.crossCheck.ok, recovery: Object.fromEntries(Object.entries(recovery).map(([k, v]) => [k, v.recovered ? v.durationUs / S : 'censored'])),
    forecastUnservedJ: { tie: forecastTie.forecast.outcomes.essentialUnservedJ, idle: forecastIdle.forecast.outcomes.essentialUnservedJ } }));
} finally {
  await adapter.close();
}
