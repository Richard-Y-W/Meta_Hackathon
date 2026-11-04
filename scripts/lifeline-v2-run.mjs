// LIFELINE v2 storylines: each storyline under independent control, the conventional hybrid and LIFELINE
// (brain + verified planner + armed reflexes), with the same faults, clock and executor.
//   node --env-file-if-exists=.env scripts/lifeline-v2-run.mjs --out artifacts/lifeline/v2/run-0 [--storylines a,b] [--controllers independent,hybrid,lifeline] [--brain live|stub]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hybrid, independent, runTownEpisode } from '../src/lifeline/controllers/joint.mjs';
import { lifeline } from '../src/lifeline/brain/lifeline.mjs';
import { stubBrain } from '../src/lifeline/brain/stub.mjs';
import { callModel } from '../src/lifeline/meta-provider.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';
import { stayAwake } from '../src/lifeline/kernel/awake.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const out = resolve(arg('--out'));
if (!admitOutputPath(ROOT, out).ok) process.exit(2);
mkdirSync(out, { recursive: true });
const POLICY = JSON.parse(readFileSync(join(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json'), 'utf8'));
const { storylines } = JSON.parse(readFileSync(join(ROOT, 'fixtures/lifeline/infra/town/storylines.json'), 'utf8'));
const pick = arg('--storylines') ? arg('--storylines').split(',') : storylines.map(s => s.id);
const controllers = arg('--controllers', 'independent,hybrid,lifeline').split(',');
const mode = arg('--brain', 'live');
if (mode === 'live' && !process.env.MODEL_API_KEY) { console.error('MODEL_API_KEY missing'); process.exit(3); }
const live = ({ prompt, timeoutMs }) => callModel({ apiKey: process.env.MODEL_API_KEY, prompt, timeoutMs, reasoningEffort: arg('--effort', 'low') });
console.log(JSON.stringify({ storylines: pick, controllers, brain: mode, maxBrainCalls: pick.length * 3, awake: stayAwake() }));

const rows = [];
for (const id of pick) {
  const c = storylines.find(s => s.id === id);
  for (const name of controllers) {
    const controller = name === 'independent' ? independent(POLICY) : name === 'hybrid' ? hybrid(POLICY)
      : lifeline(POLICY, { callModel: mode === 'live' ? live : stubBrain(c), reports: c.reports });
    const started = Date.now();
    const r = await runTownEpisode({ root: ROOT, policy: POLICY, c: { caseId: c.id, faults: c.faults, tankInitialLevels: c.tankInitialLevels }, controller, advisory: null });
    const row = { storyline: id, controller: name, wallSeconds: (Date.now() - started) / 1000, waterEssentialUnmetM3: r.waterEssentialUnmetM3, powerEssentialUnservedJ: r.powerEssentialUnservedJ,
      waterNonessentialUnmetM3: r.waterNonessentialUnmetM3, fuelUsedJ: r.fuelUsedJ, commands: r.commands, decisions: r.decisions.map(d => ({ atUs: d.atUs, layer: d.layer, decision: d.decision, chargedUs: d.chargedUs })),
      trace: r.trace.map(p => ({ atUs: p.atUs, tankLevelM: p.tankLevelM, hospitalWaterFraction: p.hospitalWaterFraction, essentialPowerFraction: p.essentialPowerFraction })),
      lifeline: controller.shared ? { log: controller.shared.log, calls: controller.shared.calls, threats: controller.shared.threats } : null };
    rows.push(row);
    writeFileSync(join(out, 'storylines.json'), `${JSON.stringify({ schema: 'lifeline.v2-storylines.v1', brain: mode, rows }, null, 1)}\n`);
    console.log(JSON.stringify({ storyline: id, controller: name, waterM3: +r.waterEssentialUnmetM3.toFixed(2), powerMJ: +(r.powerEssentialUnservedJ / 1e6).toFixed(0), residentialM3: +r.waterNonessentialUnmetM3.toFixed(1),
      fuelMJ: +(r.fuelUsedJ / 1e6).toFixed(0), wall: row.wallSeconds, brainCalls: controller.shared?.calls.map(x => x.code + (x.parse && x.parse !== 'ok' ? `:${x.parse}` : '')) ?? [] }));
  }
}
