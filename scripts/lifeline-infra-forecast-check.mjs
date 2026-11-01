// P10 evidence: forecast-only controls on the qualified power and water plants. Forecasts are issued
// periodically from admitted observations and admitted threat inputs only; afterwards they are scored
// against independent later observations (the plants' private service ledgers and later sensor readings).
// No forecast drives an action here, so acting on a warning cannot erase the evidence needed to score it.
//   node scripts/lifeline-infra-forecast-check.mjs --manifest fixtures/lifeline/infra/forecast-controls.json --out artifacts/lifeline/infra/forecast-run-0
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPowerAdapter, spawnPowerWorker } from '../src/lifeline/domains/power.mjs';
import { createWaterAdapter, spawnWaterWorker } from '../src/lifeline/domains/water.mjs';
import { checkInformationBoundary, createForecast, leadTime, scoreEventForecasts, scoreIntervals, trendCrossing } from '../src/lifeline/kernel/forecast.mjs';
import { admitThreatInput } from '../src/lifeline/kernel/threat-inputs.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const out = resolve(arg('--out', join(ROOT, 'artifacts/lifeline/infra/forecast-run-0')));
const admittedOut = admitOutputPath(ROOT, out);
if (!admittedOut.ok) { console.error(JSON.stringify(admittedOut)); process.exit(2); }
mkdirSync(out, { recursive: true });
const manifestPath = resolve(arg('--manifest', join(ROOT, 'fixtures/lifeline/infra/forecast-controls.json')));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const FIX = join(ROOT, 'fixtures/lifeline/infra');
const read = p => JSON.parse(readFileSync(join(FIX, p), 'utf8'));
const S = 1_000_000;

const waterDev = read(manifest.water.development);
const powerDev = read(manifest.power.development);
const powerSpec = (() => { const { scenario, ...base } = read(`power/${powerDev.network.base}`); return { ...base, ...powerDev.network.overrides }; })();
const powerCases = Object.fromEntries(powerDev.cases.map(c => [c.caseId, c]));

function open(c) {
  if (c.domain === 'water') {
    const adapter = createWaterAdapter({ worker: spawnWaterWorker({ python: join(ROOT, '.work/environments/water/bin/python'), root: ROOT }) });
    return { adapter, network: waterDev.network, faults: c.faults };
  }
  const network = structuredClone(powerSpec);
  for (const [id, o] of Object.entries(c.storage ?? {})) network.storageState[id] = { ...network.storageState[id], ...o };
  const adapter = createPowerAdapter({ worker: spawnPowerWorker({ python: join(ROOT, '.work/environments/infra/bin/python'), root: ROOT }) });
  return { adapter, network, faults: powerCases[c.powerCase].faults };
}

const actionEnvelope = (runId, domain, n, cmd, revision) => ({
  schemaVersion: 'infra-contract-v1', runId, domainId: domain, sequence: n, tickUs: 0, kind: 'action', actionId: `cmd-${n}`, capabilityId: `${domain}.${cmd.type}`,
  parameters: cmd.params, preconditions: [{ type: 'configuration_revision', domainId: domain, revision }], effectDeadlineUs: 0, lockSet: [], authorityGrant: 'forecast-control-setup', compensation: [],
});

async function runCase(c) {
  const runId = `fc-${c.caseId}`;
  const { adapter, network, faults } = open(c);
  const records = [];
  try {
    const init = await adapter.initialize({ runId, network, faults });
    if (!init.ok) throw new Error(`${c.caseId}: initialize ${init.code} ${init.detail ?? ''}`);
    let n = 0;
    for (const cmd of c.commands ?? []) {
      const o = await adapter.observe();
      const r = await adapter.execute(actionEnvelope(runId, c.domain, ++n, cmd, o.configurationRevision));
      if (!r.ok) throw new Error(`${c.caseId}: setup command ${r.receipt.reason}`);
    }
    const history = {}, admittedIds = [], inputs = [];
    const exhaustion = { atUs: null };
    for (let t = 0; t <= c.durationUs; t += c.issuePeriodUs) {
      if (t > 0) { const a = await adapter.advance(t); if (!a.ok) throw new Error(`${c.caseId}: advance ${a.code}`); }
      const obs = await adapter.observe();
      for (const o of obs.observations) {
        if (o.quality !== 'good') continue;
        const id = o.sourceId.replace(/^sensor:/, '');
        admittedIds.push(o.observationId);
        (history[id] ??= []).push({ atUs: o.observedAtUs, value: o.quantity.value, observationId: o.observationId });
      }
      for (const input of c.inputs ?? []) {
        if (input.issuedAtUs > t || inputs.some(i => i.raw === input)) continue;
        const { events, ...wire } = input; // modeled hazard consequences travel separately from the wire record
        const r = admitThreatInput(wire, { nowUs: t, sources: manifest.sources, knownAssets: [], maxAgeUs: manifest.maxAgeUs, hiddenFaults: faults });
        inputs.push({ raw: input, admitted: r.ok, code: r.code, events });
      }
      const f = c.forecaster;
      if (c.target === 'storage_exhaustion' && exhaustion.atUs === null) {
        const latest = history[f.sensor]?.at(-1);
        if (latest && latest.value <= f.threshold + 1e-6) exhaustion.atUs = latest.atUs; // independent later observation
      }
      let outcome, origin, support = 'supported', reason, modelVersion;
      if (f.kind === 'trend') {
        const samples = (history[f.sensor] ?? []).filter(s => s.atUs <= t).slice(-(f.window ?? 4));
        const r = trendCrossing({ samples, threshold: f.threshold, direction: f.direction, nowUs: t, horizonUs: c.horizonUs });
        origin = samples;
        modelVersion = 'trend-ensemble-v1 (slope x 0.8/1.0/1.25)';
        if (r.probability === null) { support = 'unsupported'; reason = r.status; outcome = []; }
        else {
          const delay = f.consequenceDelayUs ?? 0; // service is lost this long after the threshold crossing
          outcome = [{ kind: 'event', threat: c.target, sensor: f.sensor, probability: r.probability, interval: r.interval && r.interval.map(x => x + delay), basis: r.status, consequenceDelayUs: delay }];
        }
      } else if (f.kind === 'consequence') {
        // Ensemble of admitted-model previews over declared demand scenarios; admitted hazard inputs add
        // members with their modeled events, weighted by the input's stated probability.
        origin = obs.observations.filter(o => o.quality === 'good').map(o => ({ observationId: o.observationId, observedAtUs: o.observedAtUs }));
        modelVersion = 'consequence-ensemble-v1 (water preview)';
        const next = t + 60 * S;
        const scaled = k => network.consumers.map(node => ({ faultId: `scn-${k}-${node}`, atUs: next, type: 'demand_change', assetId: node, scale: k }));
        const lossShare = async extra => {
          let lost = 0;
          for (const k of f.demandScales) {
            const p = await adapter.preview({ actions: [], horizonUs: c.horizonUs, assume: [...scaled(k), ...extra] });
            if (!p.ok) throw new Error(`${c.caseId}: preview ${p.code}`);
            if (p.forecast.outcomes.essentialUnmetM3 > 1e-9) lost++;
          }
          return lost / f.demandScales.length;
        };
        let probability = await lossShare([]);
        for (const h of inputs.filter(i => i.admitted && i.raw.window[1] >= t && i.raw.window[0] <= t + c.horizonUs)) {
          const events = h.events.map(e => ({ ...e, faultId: `hazard-${e.faultId}`, atUs: Math.max(e.atUs, next) }));
          probability = (1 - h.raw.probability) * probability + h.raw.probability * (await lossShare(events));
        }
        outcome = [{ kind: 'event', threat: c.target, probability }];
      } else {
        origin = obs.observations.filter(o => o.quality === 'good').map(o => ({ observationId: o.observationId, observedAtUs: o.observedAtUs }));
        modelVersion = 'action-conditional-v1';
        const asset = f.action.params.pumpId ?? f.action.params.linkId;
        if ((obs.unavailableActuators ?? []).includes(asset)) { support = 'unsupported'; reason = `remote control of ${asset} unavailable: the action's effect cannot be forecast`; outcome = []; }
        else outcome = [{ kind: 'event', threat: c.target, probability: 0 }];
      }
      const forecast = createForecast({ runId, domainId: c.domain, sequence: records.length + 1, forecastId: `${c.caseId}-${t / S}`, issuedAtUs: t,
        origin: origin.map(o => ({ observationId: o.observationId, observedAtUs: o.atUs ?? o.observedAtUs })), configurationRevisions: { [c.domain]: obs.configurationRevision },
        modelVersion, horizonUs: c.horizonUs, outcomes: outcome, assumptions: ['forecast-only control: no action is taken on this forecast'], supportStatus: support, unsupportedReason: reason });
      const boundary = checkInformationBoundary(forecast, { admittedObservationIds: admittedIds, hiddenFaults: faults });
      records.push({ forecast, boundary });
    }
    const measured = await adapter.measure();
    if (!measured.ok) throw new Error(`${c.caseId}: measure ${measured.code}`);
    let lossAtUs = null;
    if (c.target === 'essential_loss') {
      for (const id of measured.essential) {
        const cs = measured.cases[id];
        cs.supply.forEach((s, i) => { if (cs.demand[i].value > 0 && s.value !== null && s.value < 0.99 * cs.demand[i].value && (lossAtUs === null || s.atUs < lossAtUs)) lossAtUs = s.atUs; });
      }
    } else lossAtUs = exhaustion.atUs;
    const pairs = records.map(({ forecast }) => {
      const item = forecast.outcomes.items[0];
      const issued = forecast.outcomes.issuedAtUs;
      const occurred = lossAtUs !== null && lossAtUs > issued && lossAtUs <= issued + c.horizonUs;
      const alreadyLost = lossAtUs !== null && lossAtUs <= issued;
      return { forecast, probability: item?.probability ?? 0, occurred: occurred || alreadyLost, alreadyLost, lead: leadTime(forecast, { lossAtUs: occurred || alreadyLost ? lossAtUs : null }),
        interval: item?.interval ?? null, actualAtUs: lossAtUs };
    });
    const scorable = pairs.filter(p => !p.alreadyLost);
    const firstWarning = scorable.find(p => p.forecast.supportStatus === 'supported' && p.probability >= manifest.scoring.eventThreshold);
    return {
      caseId: c.caseId, domain: c.domain, category: c.category, lossAtUs, forecasts: records.length,
      boundaryViolations: records.filter(r => !r.boundary.ok).length, unsupported: records.filter(r => r.forecast.supportStatus === 'unsupported').length,
      inputs: inputs.map(i => ({ type: i.raw.type, admitted: i.admitted, code: i.code })),
      // First warning: lead to the actual loss even when that loss lies beyond the forecast's own horizon.
      firstWarning: firstWarning ? { issuedAtUs: firstWarning.forecast.outcomes.issuedAtUs, probability: firstWarning.probability, ...leadTime(firstWarning.forecast, { lossAtUs }),
        lossWithinHorizon: firstWarning.occurred } : null,
      events: scoreEventForecasts(scorable, { threshold: manifest.scoring.eventThreshold }),
      timing: scoreIntervals(scorable.filter(p => p.occurred && p.interval).map(p => ({ interval: p.interval, actual: p.actualAtUs })),
        { nominal: manifest.scoring.intervalNominal, referenceWidth: c.horizonUs, badSide: 'low' }),
      postLossForecasts: pairs.length - scorable.length,
      records: records.map(r => r.forecast),
    };
  } finally {
    await adapter.close();
  }
}

const started = Date.now();
const results = [];
for (const c of manifest.cases) {
  const r = await runCase(c);
  results.push(r);
  const { records, ...brief } = r;
  console.log(JSON.stringify({ caseId: brief.caseId, lossAtS: brief.lossAtUs === null ? null : brief.lossAtUs / S, firstWarning: brief.firstWarning && { atS: brief.firstWarning.issuedAtUs / S, leadS: brief.firstWarning.leadUs === null ? null : brief.firstWarning.leadUs / S },
    hits: brief.events.hits, falseAlarms: brief.events.falseAlarms, missed: brief.events.missed, brier: brief.events.brier, unsupported: brief.unsupported, boundary: brief.boundaryViolations, timingCoverage: brief.events.timingCoverage }));
}
const all = results.flatMap(r => r.records.map(f => ({ caseId: r.caseId, f })));
writeFileSync(join(out, 'forecasts.json'), `${JSON.stringify(all.map(x => x.f), null, 1)}\n`);
writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ schema: 'lifeline.forecast-check.v1', manifest: manifestPath.slice(ROOT.length), wallSeconds: (Date.now() - started) / 1000,
  cases: results.map(({ records, ...r }) => r) }, null, 2)}\n`);
