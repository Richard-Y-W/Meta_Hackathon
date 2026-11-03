// P17: generate and freeze the held-out research suite. Writes the public protocol (families, layouts,
// controller identities, estimand, rules, commitment hashes) and the evaluator-private case manifest
// (fault schedules, advisories). Refuses to freeze if a held-out case overlaps the development set,
// duplicates another held-out case, or if outcome artifacts already mention a held-out case.
//   node scripts/lifeline-infra-freeze.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitment, duplicates, overlap, selectedAfterOutcomes, signature, suiteHash } from '../src/lifeline/kernel/research-protocol.mjs';
import { canonicalRecord } from '../src/lifeline/identity.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const S = 1_000_000, MIN = 60 * S;
const PUBLIC = resolve(ROOT, 'fixtures/lifeline/infra/protocol-research-v1.json');
const PRIVATE = resolve(ROOT, 'fixtures/lifeline/infra/research-v1/private-cases.json');
const LAYOUTS = {
  A: { pumpStationBus: 'bus-7', backupPumpBus: 'bus-14', substationRouterBus: 'bus-14', split: 'development' },
  B: { pumpStationBus: 'bus-10', backupPumpBus: 'bus-13', substationRouterBus: 'bus-13', split: 'held-out' },
  C: { pumpStationBus: 'bus-5', backupPumpBus: 'bus-14', substationRouterBus: 'bus-12', split: 'held-out' },
};

function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = prng(20261103);
const grid = (lo, hi) => (lo + Math.floor(rnd() * ((hi - lo) / MIN + 1)) * MIN);
const level = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
let n = 0;
const f = (domain, type, atUs, assetId) => ({ domain, faultId: `rv1-${++n}`, atUs, type, assetId });
const pu2 = () => f('water', 'actuator_unavailable', 0, 'PU2');
const eta = (line, restoreUs) => ({ issuedAtUs: null, source: 'power crew estimate', etaScenarios: [
  { label: 'eta-nominal', assume: [{ domain: 'power', faultId: 'eta', atUs: restoreUs, type: 'line_restore', assetId: line }] },
  { label: 'eta-late-30min', assume: [{ domain: 'power', faultId: 'eta-late', atUs: restoreUs + 30 * MIN, type: 'line_restore', assetId: line }] }] });
const threat = (line, tripUs, restoreUs, issuedUs) => ({ issuedAtUs: issuedUs, source: 'weather service and crew estimate', etaScenarios: [
  { label: 'threat-nominal-repair', assume: [{ domain: 'power', faultId: 'risk', atUs: tripUs, type: 'line_trip', assetId: line }, { domain: 'power', faultId: 'eta', atUs: restoreUs, type: 'line_restore', assetId: line }] },
  { label: 'threat-late-repair', assume: [{ domain: 'power', faultId: 'risk', atUs: tripUs, type: 'line_trip', assetId: line }, { domain: 'power', faultId: 'eta-late', atUs: restoreUs + 30 * MIN, type: 'line_restore', assetId: line }] }] });

function abrupt(line, layout, extra = [], opts = {}) {
  const trip = grid(25 * MIN, 40 * MIN), restore = trip + grid(120 * MIN, 180 * MIN);
  const advisory = eta(line, restore); advisory.issuedAtUs = trip + MIN;
  return { faults: [pu2(), f('power', 'line_trip', trip, line), f('power', 'line_restore', restore, line), ...extra(trip)], advisory, tankInitialLevels: { T1: opts.low ? level(1.3, 1.8) : level(2.4, 3.4) } };
}
const none = () => [];

const SPEC = [
  ['B', 'stable', () => ({ faults: [pu2()], advisory: null, tankInitialLevels: { T1: level(1.3, 1.8) } })],
  ['B', 'developing-threat', () => { const trip = grid(55 * MIN, 70 * MIN), restore = trip + grid(120 * MIN, 150 * MIN);
    return { faults: [pu2(), f('power', 'line_trip', trip, 'line-8-9'), f('power', 'line_restore', restore, 'line-8-9')], advisory: threat('line-8-9', trip, restore, trip - 45 * MIN), tankInitialLevels: { T1: level(2.4, 3.4) } }; }],
  ['B', 'abrupt', () => abrupt('line-8-9', 'B', none)],
  ['B', 'compound', () => abrupt('line-8-9', 'B', trip => [f('power', 'line_trip', trip + grid(20 * MIN, 40 * MIN), 'line-2-3')])],
  ['B', 'delayed-dependency', () => abrupt('line-8-9', 'B', trip => [f('power', 'actuator_unavailable', trip, 'sw-S3')], { low: true })],
  ['B', 'partial-observation', () => abrupt('line-8-9', 'B', trip => [f('water', 'sensor_freeze', trip - 2 * MIN, 'lv-T1'), f('power', 'sensor_freeze', trip - 2 * MIN, 'v-bus-10')])],
  ['B', 'false-alarm', () => { const trip = grid(55 * MIN, 70 * MIN); return { faults: [pu2()], advisory: threat('line-8-9', trip, trip + 150 * MIN, trip - 45 * MIN), tankInitialLevels: { T1: level(2.4, 3.4) } }; }],
  ['B', 'impossible-recovery', () => { const t = grid(25 * MIN, 40 * MIN); return { faults: [pu2(), f('power', 'source_loss', t, 'grid-hv')], advisory: null, tankInitialLevels: { T1: level(1.3, 1.8) } }; }],
  ['C', 'abrupt', () => abrupt('line-4-5', 'C', none)],
  ['C', 'compound', () => abrupt('line-3-4', 'C', trip => [f('power', 'actuator_unavailable', trip + grid(10 * MIN, 20 * MIN), 'sw-S2')])],
  ['C', 'delayed-dependency', () => abrupt('line-4-5', 'C', trip => [f('power', 'actuator_unavailable', trip, 'sw-S2')], { low: true })],
  ['C', 'partial-observation', () => abrupt('line-3-4', 'C', trip => [f('water', 'sensor_freeze', trip - 2 * MIN, 'lv-T1')])],
  ['C', 'false-alarm', () => { const trip = grid(55 * MIN, 70 * MIN); return { faults: [pu2()], advisory: threat('line-4-5', trip, trip + 150 * MIN, trip - 45 * MIN), tankInitialLevels: { T1: level(2.4, 3.4) } }; }],
  ['C', 'no-useful-coupling', () => abrupt('line-12-13', 'C', none)],
  ['C', 'common-cause', () => abrupt('line-3-4', 'C', trip => [f('communications', 'router_fail', trip, 'rt-sub')])],
  ['C', 'developing-threat', () => { const trip = grid(55 * MIN, 70 * MIN), restore = trip + grid(120 * MIN, 150 * MIN);
    return { faults: [pu2(), f('power', 'actuator_unavailable', 0, 'sw-S3'), f('power', 'line_trip', trip, 'line-3-4'), f('power', 'line_restore', restore, 'line-3-4')], advisory: threat('line-3-4', trip, restore, trip - 45 * MIN), tankInitialLevels: { T1: level(2.4, 3.4) } }; }],
];

export function buildSuite() {
  return SPEC.map(([layout, family, make], i) => {
    const c = make();
    return { caseId: `rv1-${String(i + 1).padStart(2, '0')}-${layout}-${family}`, family, layoutId: layout, layout: (({ split, ...l }) => l)(LAYOUTS[layout]), ...c };
  });
}

export function developmentSet() {
  const policy = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json'), 'utf8'));
  const plan = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/lifeline/infra/town/plan-controls.json'), 'utf8'));
  const A = (({ split, ...l }) => l)(LAYOUTS.A);
  return [...policy.cases.map(c => ({ case: { ...c, advisory: c.faults.some(x => x.type === 'line_trip') ? policy.advisory : null }, layout: A })),
    ...plan.cases.map(c => ({ case: { ...c, advisory: { etaScenarios: plan.scenarios } }, layout: A }))];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cases = buildSuite();
  const held = cases.map(c => ({ case: c, layout: c.layout }));
  const over = overlap(held, developmentSet()), dup = duplicates(held);
  if (over.length || dup.length) { console.error(JSON.stringify({ refused: 'leakage', overlap: over, duplicates: dup })); process.exit(2); }
  const policy = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json'), 'utf8'));
  const protocol = {
    schemaVersion: 'lifeline.research-protocol.v1', protocolId: 'research-v1', status: 'frozen',
    purpose: 'Held-out comparison of independent, coordinated conventional and Meta-assisted control on the coupled development town (P18), the substrate for B1, B2 and B5 within this scope.',
    split: { development: 'layout A (pump station bus 7) and every case in baseline-policy.json and plan-controls.json', heldOut: 'layouts B (bus 10) and C (bus 5), with fault locations, remedies and families not used in development; no case is structurally isomorphic to a development case (role signature)' },
    layouts: LAYOUTS,
    families: [...new Set(cases.map(c => c.family))],
    estimand: {
      primary: 'paired difference in the service score S per scenario group (one run per controller per group)',
      S: 'S = 1 - sum(w_s * D_s) / sum(w_s); D_s = unmet / requested over the 4 h episode',
      weights: { 'water:JH (hospital)': 1, 'water:JF (fire station)': 1, 'power:essential (CI3, CI7, CI9)': 1, 'water:JR (residential, non-essential)': 0.2 },
      reported: ['each service D_s', 'worst family', 'non-essential harm', 'generator fuel', 'commands and refusals', 'provider calls, timeouts and tokens'],
    },
    controllers: {
      independent: 'independent domain rules (comparator revision 3: layout-independent dead-bus detection)',
      hybrid: 'coordinated rules in parallel with the rolling-horizon planner (comparator revision 2; locked in P13/P14)',
      'meta-complete': { mode: 'complete', model: process.env.META_MODEL || 'muse-spark-1.3', reasoningEffort: 'low', providerCapS: 30, maxCallsPerEpisode: 6, promptVersion: 'lifeline-joint-v1',
        promptSha256: canonicalRecord(readFileSync(resolve(ROOT, 'fixtures/lifeline/infra/meta-prompt-v1.txt'), 'utf8')).sha256 },
      oracle: 'private perfect-information ceiling (headroom only; not a comparator)',
    },
    comparisons: {
      B2: { method: 'meta-complete', comparators: ['independent', 'hybrid'], rule: 'supported only if, against EACH comparator: 95% cluster-bootstrap interval of the mean paired S difference excludes zero, the mean gain is >= 0.5 pp, the relative essential-deficit reduction is >= 10%, and no service group regresses by more than 0.5 pp on average' },
      B1: { method: 'hybrid (forecast-guided)', comparator: 'independent (reactive)', population: 'families with an observable threat: developing-threat', rule: 'same thresholds on the anticipatory population; warning must precede loss by more than the execution time', note: 'two anticipatory groups only: at most exploratory' },
      B5: { scope: 'no-fault and disturbance strata of this suite', rule: 'per-critical-group S regression lower bound above -0.5 pp for meta-complete vs hybrid; local control continues; no stale action executes' },
    },
    inference: { unit: 'scenario group', bootstrap: { reps: 5000, seed: 20261103, clusters: 'family' }, multiplicity: 'B2 is primary; B1 and B5 are secondary and reported separately' },
    precision: { developmentPairedSdPp: 2.0, groups: cases.length, ci95HalfWidthPp: 1.0, mdePp80: 1.4, statement: 'Development paired S differences (hybrid - independent, 5 cases) have SD 2.0 pp. With 16 groups the 95% half-width is about 1.0 pp and the 80%-power minimum detectable effect about 1.4 pp: a true effect between 0.5 and 1.4 pp would likely be inconclusive.' },
    order: { seed: 20261104, rule: 'controller order randomized within each group' },
    budget: { metaCallsMax: cases.length * 6, metaOutputTokensMax: cases.length * 6 * 6000, wallHoursEstimate: 4 },
    invalidRun: 'Only an evaluator/worker crash with retained evidence is infrastructure-invalid; the whole group is rerun once for all controllers and the original attempts are kept. Provider timeouts, invalid model output, refused actions and unrecovered service are method outcomes.',
    stopRule: 'fixed batch of all groups; no early stopping; if resources run out the study is marked incomplete and the partial batch reported',
    cases: cases.map(c => ({ caseId: c.caseId, family: c.family, layoutId: c.layoutId, commitmentSha256: commitment(c), signature: signature(c, c.layout) })),
  };
  const prior = selectedAfterOutcomes({ cases: protocol.cases, freeze: { frozenAtUnixMs: Date.now() } }, resolve(ROOT, 'artifacts'));
  if (prior.length) { console.error(JSON.stringify({ refused: 'selected_after_outcomes', prior })); process.exit(3); }
  protocol.freeze = { frozenAtUnixMs: Date.now(), frozenAtCommit: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim(), baselineFixtureSha256: canonicalRecord(policy).sha256 };
  protocol.freeze.suiteSha256 = suiteHash(protocol);
  mkdirSync(dirname(PRIVATE), { recursive: true });
  writeFileSync(PRIVATE, `${JSON.stringify({ schemaVersion: 'lifeline.research-private.v1', protocolId: 'research-v1', note: 'Evaluator-private: fault schedules and advisories. Controllers receive only admitted observations and advisories at their issue time.', cases }, null, 1)}\n`);
  writeFileSync(PUBLIC, `${JSON.stringify(protocol, null, 1)}\n`);
  console.log(JSON.stringify({ frozen: protocol.freeze, cases: cases.length }));
}
