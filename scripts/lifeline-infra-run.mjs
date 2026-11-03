// P16: one coupled-town run retained as a verifiable bundle.
//   node scripts/lifeline-infra-run.mjs --case b-second-fault --controller hybrid --out artifacts/lifeline/infra/town-release-run-0/hybrid-b-second-fault
// Bundle: manifest.json (workload and fixture hashes, clock mapping, code, ledger summary), receipts.jsonl
// (hash-chained commands and decisions), trace.json, case.json, score.json (bound to the manifest hash).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hybrid, independent, priority, runTownEpisode } from '../src/lifeline/controllers/joint.mjs';
import { metaJoint } from '../src/lifeline/controllers/meta-joint.mjs';
import { canonicalRecord } from '../src/lifeline/identity.mjs';
import { Ledger } from '../src/lifeline/ledger.mjs';
import { callModel } from '../src/lifeline/meta-provider.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const FIXTURES = ['fixtures/lifeline/infra/town/baseline-policy.json', 'fixtures/lifeline/infra/town/development.json', 'fixtures/lifeline/infra/town/dependencies.json',
  'fixtures/lifeline/infra/water/town.inp', 'fixtures/lifeline/infra/power/reference.json', 'fixtures/lifeline/infra/power/development.json'];
export const sha = path => canonicalRecord(readFileSync(resolve(ROOT, path), 'utf8')).sha256;
export const caseHash = c => canonicalRecord({ caseId: c.caseId, faults: c.faults, tankInitialLevels: c.tankInitialLevels ?? null }).sha256;

export function controllerFor(name, policy) {
  if (name === 'independent') return independent(policy);
  if (name === 'priority') return priority(policy);
  if (name === 'hybrid') return hybrid(policy);
  if (name === 'meta-complete') return metaJoint(policy, { mode: 'complete', maxCalls: 4, providerCapS: 30, callModel: ({ prompt, timeoutMs }) => callModel({ apiKey: process.env.MODEL_API_KEY, prompt, timeoutMs, reasoningEffort: 'low' }) });
  if (name === 'meta-provider-interrupted') return metaJoint(policy, { mode: 'complete', providerCapS: 30, callModel: async () => ({ code: 'provider_unavailable', reason: 'interrupted_by_protocol', durationMs: 0 }) });
  throw new Error(`unknown controller ${name}`);
}

export async function runBundle({ caseId, controller: name, out, extraFaults = [] }) {
  const policy = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json'), 'utf8'));
  const base = policy.cases.find(c => c.caseId === caseId);
  if (!base) throw new Error(`unknown case ${caseId}`);
  const c = { ...base, faults: [...base.faults, ...extraFaults] };
  if (!admitOutputPath(ROOT, out).ok) throw new Error('output not admitted');
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(out, { recursive: true });
  const advisory = c.faults.some(f => f.type === 'line_trip') ? policy.advisory : null;
  const controller = controllerFor(name, policy);
  const runId = `town-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${name}-${caseId}`;
  const r = await runTownEpisode({ root: ROOT, policy, c, controller, advisory });
  const ledger = new Ledger(join(out, 'receipts.jsonl'));
  const entries = [...r.decisions.map(d => ({ type: 'decision', atUs: d.atUs, data: d })), ...r.commands.map(q => ({ type: 'command', atUs: q.atUs, data: q }))]
    .sort((a, b) => a.atUs - b.atUs || (a.type === 'decision' ? -1 : 1));
  for (const e of entries) ledger.append(e.type, e.data);
  writeFileSync(join(out, 'case.json'), `${JSON.stringify(c, null, 1)}\n`);
  writeFileSync(join(out, 'trace.json'), `${JSON.stringify({ clock: r.clock, trace: r.trace })}\n`);
  const manifest = {
    schema: 'lifeline.town-run.v1', runId, caseId, controller: name, label: r.label, oracle: r.oracle,
    workload: { caseSha256: caseHash(c), fixtures: Object.fromEntries(FIXTURES.map(f => [f, sha(f)])) },
    clock: r.clock, durationUs: policy.durationUs, gridUs: policy.gridUs, advisory: advisory ? { issuedAtUs: advisory.issuedAtUs, etaScenarios: advisory.etaScenarios.map(s => s.label) } : null,
    code: { commit: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim(), dirty: execFileSync('git', ['-C', ROOT, 'status', '--porcelain']).toString().trim().split('\n').filter(Boolean).length },
    provider: controller.planner ? { calls: controller.planner.calls.filter(x => x.code).map(x => ({ atUs: x.atUs, code: x.code, parse: x.parse ?? null, durationMs: x.durationMs ?? 0, usage: x.usage ?? null, participated: x.participated ?? false })) } : null,
    ledger: ledger.finalize(),
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  const score = { schema: 'lifeline.town-score.v1', runId, manifestSha256: canonicalRecord(manifest).sha256,
    waterEssentialUnmetM3: r.waterEssentialUnmetM3, waterNonessentialUnmetM3: r.waterNonessentialUnmetM3, powerEssentialUnservedJ: r.powerEssentialUnservedJ, fuelUsedJ: r.fuelUsedJ };
  writeFileSync(join(out, 'score.json'), `${JSON.stringify(score, null, 1)}\n`);
  return { manifest, score };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = n => process.argv[process.argv.indexOf(n) + 1];
  const { score } = await runBundle({ caseId: arg('--case'), controller: arg('--controller'), out: resolve(arg('--out')) });
  console.log(JSON.stringify(score));
}
