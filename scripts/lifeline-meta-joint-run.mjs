// P14 live runs: Meta-assisted joint planning on town development cases, beside the conventional hybrid.
//   node --env-file-if-exists=.env scripts/lifeline-meta-joint-run.mjs --out DIR --cases b-second-fault --modes complete --max-calls 4
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTownEpisode } from '../src/lifeline/controllers/joint.mjs';
import { metaJoint } from '../src/lifeline/controllers/meta-joint.mjs';
import { callModel, PROVIDER_CONFIG } from '../src/lifeline/meta-provider.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const out = resolve(arg('--out'));
if (!admitOutputPath(ROOT, out).ok) process.exit(2);
mkdirSync(out, { recursive: true });
const POLICY = JSON.parse(readFileSync(join(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json'), 'utf8'));
const cases = arg('--cases').split(','), modes = arg('--modes').split(','), maxCalls = Number(arg('--max-calls', '10'));
const estimate = { episodes: cases.length * modes.length, maxCallsPerEpisode: maxCalls, maxCalls: cases.length * modes.length * maxCalls,
  maxOutputTokens: cases.length * modes.length * maxCalls * PROVIDER_CONFIG.maxOutputTokens, model: process.env.META_MODEL || 'muse-spark-1.3', credentialPresent: Boolean(process.env.MODEL_API_KEY) };
console.log(JSON.stringify({ estimate }));
if (!estimate.credentialPresent) { console.error('MODEL_API_KEY missing'); process.exit(3); }
const effort = arg('--effort', PROVIDER_CONFIG.reasoningEffort), capS = Number(arg('--cap-s', '18'));
estimate.reasoningEffort = effort; estimate.providerCapS = capS;
const call = ({ prompt, timeoutMs }) => callModel({ apiKey: process.env.MODEL_API_KEY, prompt, timeoutMs, reasoningEffort: effort });
const rows = [];
for (const id of cases) {
  const c = POLICY.cases.find(x => x.caseId === id);
  const advisory = c.faults.some(f => f.type === 'line_trip') ? POLICY.advisory : null;
  for (const mode of modes) {
    const controller = metaJoint(POLICY, { mode, callModel: call, maxCalls, providerCapS: capS });
    const started = Date.now();
    const r = await runTownEpisode({ root: ROOT, policy: POLICY, c, controller, advisory });
    r.wallSeconds = (Date.now() - started) / 1000;
    r.metaCalls = controller.planner.calls;
    rows.push(r);
    const live = r.metaCalls.filter(x => x.code);
    console.log(JSON.stringify({ caseId: id, mode, water: r.waterEssentialUnmetM3, nonessential: r.waterNonessentialUnmetM3, powerMJ: r.powerEssentialUnservedJ / 1e6, fuelMJ: r.fuelUsedJ / 1e6, calls: live.length,
      ok: live.filter(x => x.parse === 'ok').length, participated: live.filter(x => x.participated).length, codes: live.map(x => x.code + (x.parse && x.parse !== 'ok' ? `:${x.parse}` : '')) }));
    writeFileSync(join(out, 'meta-joint.json'), `${JSON.stringify({ schema: 'lifeline.meta-joint-run.v1', estimate, rows }, null, 1)}\n`);
  }
}
