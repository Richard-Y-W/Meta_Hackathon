// Forecast calibration against retained packet runs. For every 2 s of each run, replay the controller-
// visible observations into beliefs, forecast the next 2 s for the routes and rates actually in effect,
// and compare with the receivers' on-time fraction for messages created in that interval.
//   node scripts/lifeline-forecast-check.mjs --runs <dir>... --out artifacts/lifeline/forecast-run-0.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CapacityBeliefs } from '../src/lifeline/beliefs.mjs';
import { forecast } from '../src/lifeline/forecast.mjs';
import { deriveRates } from '../src/lifeline/telemetry.mjs';
import { buildInventory, effectiveRoute } from '../src/lifeline/controllers/common.mjs';

const lines = p => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const HORIZON_S = 2;

export function checkRun(dir, inventory) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const events = lines(join(dir, 'events.jsonl'));
  const observations = lines(join(dir, 'controller-view.jsonl'));
  const start = manifest.trafficStartAtMs;
  // Route and rate changes in effect, from confirmed executions (commit approximated at receipt start + 0.5 s).
  const proposals = Object.fromEntries(events.filter(e => e.type === 'decision').map(e => [e.proposal.proposalId, e.proposal]));
  const changes = [];
  for (const e of events.filter(e => e.type === 'execution')) {
    for (const r of e.receipts.filter(r => r.status === 'confirmed')) {
      const action = proposals[e.proposalId]?.actions.find(a => a.actionId === r.actionId);
      if (action?.type === 'set_route') changes.push({ atMs: r.startedAtMs + 500, flowId: action.flowId, route: { version: 1, path: action.path, ackPath: action.ackPath } });
      if (action?.type === 'set_background_rate') changes.push({ atMs: r.endedAtMs, sourceId: action.sourceId, bps: action.bitsPerSecond });
    }
  }
  const beliefs = new CapacityBeliefs(inventory);
  const routes = Object.fromEntries(inventory.essential.map(f => [f.flowId, { version: 0, path: inventory.reference[f.flowId].primary, ackPath: inventory.reference[f.flowId].ackPrimary }]));
  const rates = Object.fromEntries(inventory.background.map(s => [s.sourceId, s.scheduledBps]));
  const checks = [];
  observations.forEach((o, i) => {
    const window = observations.slice(Math.max(0, i - 8), i + 1);
    beliefs.update(o, deriveRates(window));
    const tS = (o.collectedAtMs - start) / 1000;
    if (i % 4 !== 0 || tS < 0 || tS + HORIZON_S > manifest.durationMs / 1000) return;
    for (const c of changes.filter(c => c.atMs <= o.collectedAtMs && !c.applied)) {
      c.applied = true;
      if (c.flowId) routes[c.flowId] = c.route; else rates[c.sourceId] = c.bps;
    }
    const effective = Object.fromEntries(inventory.essential.map(f => [f.flowId, effectiveRoute(f, routes[f.flowId], o, inventory)]));
    const f = forecast({ inventory, beliefs, routes: effective, rates, observation: o });
    if (f.status !== 'ok') { checks.push({ tS, status: f.status }); return; }
    for (const flow of f.flows) {
      let offered = 0, onTime = 0;
      for (let s = Math.ceil(tS); s < Math.ceil(tS) + HORIZON_S; s++) {
        const bin = summary.series[flow.flowId]?.[String(s)];
        if (bin) { offered += bin.offered; onTime += bin.onTime; }
      }
      if (!offered) continue;
      const observed = onTime / offered;
      const [lo, hi] = flow.predictedOnTime;
      const assumed = f.nominalAssumed.some(k => [...flow.path].slice(1).some((n, j) => k === `${flow.path[j]}>${n}`));
      checks.push({ tS: Math.round(tS * 10) / 10, flowId: flow.flowId, predicted: [lo, hi], observed: Math.round(observed * 1000) / 1000,
        outcome: observed < lo - 1e-9 ? 'optimistic_error' : observed > hi + 1e-9 ? 'pessimistic_error' : 'covered',
        width: hi - lo, nominalAssumedOnPath: assumed, peak: flow.peakUtilization });
    }
  });
  return { run: dir.split('/').slice(-1)[0], runId: manifest.runId, controller: manifest.controller, scenario: manifest.scenario.scenarioId, checks };
}

export function summarize(results) {
  const all = results.flatMap(r => r.checks.filter(c => c.outcome));
  const count = k => all.filter(c => c.outcome === k).length;
  const misses = all.filter(c => c.outcome !== 'covered');
  return {
    intervals: all.length, covered: count('covered'), optimisticErrors: count('optimistic_error'), pessimisticErrors: count('pessimistic_error'),
    coverage: all.length ? count('covered') / all.length : null,
    meanWidth: all.length ? all.reduce((s, c) => s + c.width, 0) / all.length : null,
    uninformative: all.filter(c => c.width >= 0.99).length,
    misses: misses.map(m => ({ ...m, run: results.find(r => r.checks.includes(m)).run })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf('--out') + 1];
  const runs = argv.slice(argv.indexOf('--runs') + 1).filter((a, i, all) => !a.startsWith('--') && all.slice(0, i).every(b => !b.startsWith('--')));
  const read = p => JSON.parse(readFileSync(p, 'utf8'));
  const policy = read('fixtures/lifeline/policy-v1.json');
  const results = runs.filter(d => existsSync(join(d, 'summary.json'))).map(d => {
    const m = read(join(d, 'manifest.json'));
    return checkRun(d, buildInventory(read(m.scenario.path), policy));
  });
  const report = { version: 'lifeline.forecast-check.v1', horizonS: HORIZON_S, perRun: results.map(r => ({ run: r.run, runId: r.runId, controller: r.controller, scenario: r.scenario, ...summarize([r]), misses: undefined })), overall: summarize(results), results };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ perRun: report.perRun.map(r => [r.run, r.intervals, r.covered, r.optimisticErrors, r.pessimisticErrors]), overall: { ...report.overall, misses: report.overall.misses.length } }));
}
