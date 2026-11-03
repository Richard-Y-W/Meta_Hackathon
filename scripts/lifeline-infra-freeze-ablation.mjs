// P19: freeze the ablation protocol (derived from research-v1). The frozen JSON is the record; rerunning
// this after ablation outcomes exist would be selection after outcomes.
//   node scripts/lifeline-infra-freeze-ablation.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { suiteHash } from '../src/lifeline/kernel/research-protocol.mjs';
const base = JSON.parse(readFileSync('fixtures/lifeline/infra/protocol-research-v1.json', 'utf8'));
const rows = JSON.parse(readFileSync('artifacts/lifeline/infra/research-v1/rows.json', 'utf8')).rows;
const d = rows.filter(r => r.controller === 'meta-complete').flatMap(r => r.metaCalls).filter(x => x.code === 'ok').map(x => x.durationMs).sort((a, b) => a - b);
const median = Math.round((d[(d.length - 1) >> 1] + d[d.length >> 1]) / 2);
const ids = ['rv1-02-B-developing-threat', 'rv1-03-B-abrupt', 'rv1-04-B-compound', 'rv1-05-B-delayed-dependency', 'rv1-06-B-partial-observation', 'rv1-08-B-impossible-recovery', 'rv1-11-C-delayed-dependency', 'rv1-15-C-common-cause'];
const p = {
  schemaVersion: 'lifeline.research-protocol.v1', protocolId: 'ablation-v1', status: 'frozen',
  purpose: 'P19 attribution: which mechanism caused the service differences observed in research-v1 (P18): coordination, forecast use, the Meta model content, or the latency of asking it.',
  basedOn: { protocolId: 'research-v1', path: 'fixtures/lifeline/infra/protocol-research-v1.json', suiteSha256: base.freeze.suiteSha256 },
  population: { rule: 'research-v1 groups where any P18 controller had a nonzero weighted service deficit (the groups with a difference to explain). Chosen from P18 outcomes of all controllers, before any ablation outcome.', groups: ids.length },
  matchedDelayMs: median,
  matchedDelayBasis: `median duration of the ${d.length} successful P18 Meta calls (${(d[0] / 1000).toFixed(1)}-${(d.at(-1) / 1000).toFixed(1)} s)`,
  variants: {
    hybrid: 'model off: rules in parallel with the rolling-horizon planner (rerun in this batch; also measures run-to-run variation against P18)',
    independent: 'no coupling: independent domain rules (rerun in this batch)',
    'hybrid-no-forecast': 'hybrid with the advisory withheld: isolates forecast use (the B1 mechanism)',
    'meta-narrator': 'live model called by the same gate, answer not used for planning: interface/latency without content',
    'meta-latency-matched': 'same gate and planner as meta-complete; the call is a wait of the measured median provider duration and returns no content: latency alone',
    'meta-fixed-cadence': 'live model at every decision up to the call budget instead of the opportunity-bounded gate',
  },
  notApplicable: {
    'no-active-probe': 'the town catalog has no probe action; the probe-only template has no steps',
    'fixed-model / no-memory': 'the model store is written but never read by plan ranking: identical to meta-complete by construction',
    'equal-computation conventional': 'the rolling planner already evaluates every template (10 per decision, budget 20)',
    'adaptive-estimation baseline': 'the rolling planner plans on forks of the admitted estimated state; no separate parameter-identification baseline exists (limitation)',
  },
  contrasts: {
    latency: 'meta-latency-matched minus hybrid (same batch)',
    modelContent: 'research-v1 meta-complete minus meta-latency-matched (cross-batch; read with the hybrid run-to-run variation)',
    narration: 'meta-narrator minus meta-latency-matched',
    forecast: 'hybrid minus hybrid-no-forecast',
    coordination: 'hybrid minus independent',
    cadence: 'meta-fixed-cadence minus research-v1 meta-complete (cross-batch)',
    runToRun: 'hybrid (this batch) minus research-v1 hybrid',
  },
  inference: 'paired S differences per group with the research-v1 family-cluster bootstrap; 8 groups: descriptive attribution, not a new claim test',
  order: { seed: 20261105, rule: 'variant order randomized within each group' },
  budget: { metaCallsMax: ids.length * 6 * 2, metaOutputTokensMax: ids.length * 6 * 2 * 6000, wallHoursEstimate: 2.6 },
  invalidRun: base.invalidRun, stopRule: base.stopRule,
  cases: ids.map(id => ({ caseId: id })),
};
p.freeze = { frozenAtUnixMs: Date.now(), frozenAtCommit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim() };
p.freeze.suiteSha256 = suiteHash(p);
writeFileSync('fixtures/lifeline/infra/protocol-ablation-v1.json', `${JSON.stringify(p, null, 1)}\n`);
console.log(JSON.stringify({ matchedDelayMs: median, n: d.length, suite: p.freeze.suiteSha256 }));
