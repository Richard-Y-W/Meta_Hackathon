// P13 evidence: every town development case under every conventional comparator, plus the oracle ceiling.
//   node scripts/lifeline-town-baselines.mjs --out artifacts/lifeline/infra/p13-run-0
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hybrid, independent, priority, rolling, runTownEpisode } from '../src/lifeline/controllers/joint.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(process.argv[process.argv.indexOf('--out') + 1]);
if (!admitOutputPath(ROOT, out).ok) process.exit(2);
mkdirSync(out, { recursive: true });
const POLICY = JSON.parse(readFileSync(join(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json'), 'utf8'));
const rows = [];
for (const c of POLICY.cases) {
  const advisory = c.faults.some(f => f.type === 'line_trip') ? POLICY.advisory : null;
  const only = process.argv.includes('--controllers') ? process.argv[process.argv.indexOf('--controllers') + 1].split(',') : null;
  for (const controller of [independent(POLICY), priority(POLICY), rolling(POLICY), hybrid(POLICY), rolling(POLICY, { oracleFaults: c.faults })].filter(x => !only || only.includes(x.name))) {
    const started = Date.now();
    const r = await runTownEpisode({ root: ROOT, policy: POLICY, c, controller, advisory });
    r.wallSeconds = (Date.now() - started) / 1000;
    rows.push(r);
    console.log(JSON.stringify({ caseId: r.caseId, controller: r.controller, water: +r.waterEssentialUnmetM3.toFixed(3), powerMJ: +(r.powerEssentialUnservedJ / 1e6).toFixed(1), fuelMJ: +(r.fuelUsedJ / 1e6).toFixed(1), commands: r.commands.filter(x => x.status === 'delivered').length, wall: r.wallSeconds }));
    writeFileSync(join(out, 'comparison.json'), `${JSON.stringify({ schema: 'lifeline.town-baselines.v1', policyId: POLICY.policyId, rows }, null, 1)}\n`);
  }
}
