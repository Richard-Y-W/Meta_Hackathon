// P18: the frozen research-v1 comparison. Verifies the suite against its commitments, then runs every group
// under every declared controller in the frozen randomized order, one episode at a time (decision latency is
// charged from wall time, so episodes never share the host). Rows are written after every episode; a rerun
// with the same --out resumes. An evaluator/worker crash is infrastructure-invalid: the whole group is rerun
// once for all controllers and the original attempts are kept. Provider failures are method outcomes.
// A derived protocol (P19 ablations: `basedOn`, `variants`) reuses the base suite's private cases and commitments.
//   node --env-file-if-exists=.env scripts/lifeline-infra-evaluate.mjs --protocol fixtures/lifeline/infra/protocol-research-v1.json --out artifacts/lifeline/infra/research-v1 [--controllers independent,hybrid,meta-complete,oracle] [--estimate-only]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hybrid, independent, rolling, runTownEpisode } from '../src/lifeline/controllers/joint.mjs';
import { metaJoint } from '../src/lifeline/controllers/meta-joint.mjs';
import { advisoryFor, variants } from '../src/lifeline/controllers/ablations.mjs';
import { callModel, PROVIDER_CONFIG } from '../src/lifeline/meta-provider.mjs';
import { commitment, suiteHash } from '../src/lifeline/kernel/research-protocol.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const protocolPath = resolve(arg('--protocol', join(ROOT, 'fixtures/lifeline/infra/protocol-research-v1.json')));
const out = resolve(arg('--out'));
if (!admitOutputPath(ROOT, out).ok) { console.error('output path not admitted'); process.exit(2); }
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
// A derived study (P19 ablations) names its base suite; cases and commitments come from the base.
const base = protocol.basedOn ? JSON.parse(readFileSync(resolve(ROOT, protocol.basedOn.path), 'utf8')) : protocol;
if (protocol.basedOn && (base.freeze.suiteSha256 !== protocol.basedOn.suiteSha256 || suiteHash(protocol) !== protocol.freeze.suiteSha256)) { console.error('derived protocol hash mismatch'); process.exit(4); }
const priv = JSON.parse(readFileSync(join(ROOT, 'fixtures/lifeline/infra/research-v1/private-cases.json'), 'utf8'));
const POLICY = JSON.parse(readFileSync(join(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json'), 'utf8'));

// The suite must be exactly what was frozen.
if (protocol.status !== 'frozen' || base.status !== 'frozen' || suiteHash(base) !== base.freeze.suiteSha256) { console.error('protocol hash mismatch'); process.exit(4); }
const cases = protocol.cases.map(pc => {
  const c = priv.cases.find(x => x.caseId === pc.caseId);
  pc = base.cases.find(x => x.caseId === pc.caseId) ?? {};
  if (!c || commitment(c) !== pc.commitmentSha256) { console.error(`commitment mismatch: ${pc.caseId}`); process.exit(4); }
  return c;
});

const meta = base.controllers['meta-complete'];
const declared = arg('--controllers', (protocol.variants ? Object.keys(protocol.variants) : ['independent', 'hybrid', 'meta-complete']).join(',')).split(',');
const LIVE = new Set(['meta-complete', 'meta-narrator', 'meta-fixed-cadence']);
const estimate = { groups: cases.length, controllers: declared, episodes: cases.length * declared.length,
  metaCallsMax: cases.length * meta.maxCallsPerEpisode * declared.filter(k => LIVE.has(k)).length,
  metaOutputTokensMax: cases.length * meta.maxCallsPerEpisode * declared.filter(k => LIVE.has(k)).length * PROVIDER_CONFIG.maxOutputTokens,
  metaInputTokensApprox: cases.length * meta.maxCallsPerEpisode * declared.filter(k => LIVE.has(k)).length * 3500,
  model: process.env.META_MODEL || 'muse-spark-1.3', frozenModel: meta.model, reasoningEffort: meta.reasoningEffort, providerCapS: meta.providerCapS,
  wallHoursApprox: +(cases.length * declared.reduce((a, k) => a + ({ independent: 10, hybrid: 200, 'meta-complete': 220, oracle: 250, 'meta-fixed-cadence': 300 }[k] ?? 230), 0) / 3600).toFixed(1),
  credentialPresent: Boolean(process.env.MODEL_API_KEY) };
console.log(JSON.stringify({ estimate }));
if (process.argv.includes('--estimate-only')) process.exit(0);
if (declared.some(k => LIVE.has(k)) && (!estimate.credentialPresent || estimate.model !== meta.model)) { console.error('provider credential missing or model differs from the frozen identity'); process.exit(3); }

const call = ({ prompt, timeoutMs }) => callModel({ apiKey: process.env.MODEL_API_KEY, prompt, timeoutMs, reasoningEffort: meta.reasoningEffort });
const ablation = variants(POLICY, { callModel: call, maxCalls: meta.maxCallsPerEpisode, providerCapS: meta.providerCapS, matchedDelayMs: protocol.matchedDelayMs });
const make = (name, c) => ({
  ...ablation,
  independent: () => independent(POLICY),
  hybrid: () => hybrid(POLICY),
  'meta-complete': () => metaJoint(POLICY, { mode: 'complete', callModel: call, maxCalls: meta.maxCallsPerEpisode, providerCapS: meta.providerCapS }),
  oracle: () => rolling(POLICY, { oracleFaults: c.faults }),
}[name]());

// Frozen order: controller order shuffled within each group by the protocol's seed.
function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = prng(protocol.order.seed);
const order = cases.map(c => { const k = protocol.variants ? Object.keys(protocol.variants) : ['independent', 'hybrid', 'meta-complete']; for (let i = k.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [k[i], k[j]] = [k[j], k[i]]; } return { caseId: c.caseId, controllers: [...k, 'oracle'] }; });

mkdirSync(out, { recursive: true });
const file = join(out, 'rows.json');
const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const rows = saved?.rows ?? [];
const save = () => writeFileSync(file, `${JSON.stringify({ schema: 'lifeline.research-rows.v1', protocolId: protocol.protocolId, suiteSha256: protocol.freeze.suiteSha256, baseSuiteSha256: base.freeze.suiteSha256, estimate, order, rows }, null, 1)}\n`);
const done = (caseId, ctrl, attempt) => rows.some(r => r.caseId === caseId && r.controller === ctrl && r.attempt === attempt);

async function episode(c, name, attempt) {
  const controller = make(name, c);
  const started = Date.now();
  const base = { caseId: c.caseId, family: c.family, layoutId: c.layoutId, controller: name, attempt, startedAtUnixMs: started };
  try {
    const r = await runTownEpisode({ root: ROOT, policy: POLICY, c, controller, advisory: advisoryFor(controller, c) });
    const step = Math.max(1, Math.floor(r.trace.length / 240));
    const row = { ...base, status: 'complete', wallSeconds: (Date.now() - started) / 1000, truth: { water: r.truth.water, power: r.truth.power, events: r.truth.events },
      trace: r.trace.filter((_, i) => i % step === 0 || i === r.trace.length - 1).map(p => ({ atUs: p.atUs, tankLevelM: p.tankLevelM, hospitalWaterFraction: p.hospitalWaterFraction, essentialPowerFraction: p.essentialPowerFraction })),
      commands: r.commands, decisions: r.decisions.map(d => ({ atUs: d.atUs, layer: d.layer, decision: d.decision, wallSeconds: d.wallSeconds, chargedUs: d.chargedUs })),
      chargedDecisionUs: r.chargedDecisionUs, fuelUsedJ: r.fuelUsedJ, waterEssentialUnmetM3: r.waterEssentialUnmetM3, powerEssentialUnservedJ: r.powerEssentialUnservedJ, waterNonessentialUnmetM3: r.waterNonessentialUnmetM3,
      metaCalls: controller.planner ? controller.planner.calls.map(({ rawText, ...x }) => x) : [] };
    return row;
  } catch (error) {
    return { ...base, status: 'infrastructure_invalid', wallSeconds: (Date.now() - started) / 1000, error: { code: error.code ?? 'error', detail: String(error.detail ?? error.message ?? error).slice(0, 300) }, truth: null, trace: [], commands: [], metaCalls: [] };
  }
}

for (const o of order) {
  const c = cases.find(x => x.caseId === o.caseId);
  const ctrls = o.controllers.filter(k => declared.includes(k));
  for (const attempt of [1, 2]) {
    if (attempt === 2 && !rows.some(r => r.caseId === c.caseId && r.attempt === 1 && r.status === 'infrastructure_invalid')) break;
    for (const name of ctrls) {
      if (done(c.caseId, name, attempt)) continue;
      const row = await episode(c, name, attempt);
      rows.push(row);
      save();
      const live = row.metaCalls.filter(x => x.code);
      console.log(JSON.stringify({ caseId: c.caseId, controller: name, attempt, status: row.status, wall: row.wallSeconds, waterM3: row.waterEssentialUnmetM3 ?? null,
        powerMJ: row.powerEssentialUnservedJ != null ? +(row.powerEssentialUnservedJ / 1e6).toFixed(1) : null, calls: live.length, codes: live.map(x => x.code + (x.parse && x.parse !== 'ok' ? `:${x.parse}` : '')) }));
    }
  }
}
save();
console.log(JSON.stringify({ finished: rows.length }));
