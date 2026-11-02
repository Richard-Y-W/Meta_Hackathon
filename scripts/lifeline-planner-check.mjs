// P12 evidence: planner decisions on the plan controls and a timed execution with a second fault.
//   node scripts/lifeline-planner-check.mjs --out artifacts/lifeline/infra/p12-run-0
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTownWorker } from '../src/lifeline/domains/town.mjs';
import { validateTimedPlan } from '../src/lifeline/kernel/plans.mjs';
import { evaluatePlan, runTimedPlan, searchPlans, templates } from '../src/lifeline/kernel/planner.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(process.argv[process.argv.indexOf('--out') + 1]);
if (!admitOutputPath(ROOT, out).ok) process.exit(2);
mkdirSync(out, { recursive: true });
const C = JSON.parse(readFileSync(join(ROOT, 'fixtures/lifeline/infra/town/plan-controls.json'), 'utf8'));
const RES = { 'gen-portable': {} };

async function decide(town) {
  const { modelId } = await town.admittedModel();
  const st = await town.state();
  const allocated = Object.fromEntries(Object.entries(st.resources).filter(([, r]) => r.allocatedTo).map(([id, r]) => [id, r.allocatedTo]));
  return searchPlans({ candidates: templates({ nowUs: st.nowUs, catalog: C.catalog, state: st }), validate: p => validateTimedPlan(p, { nowUs: st.nowUs, gridUs: C.gridUs, resources: RES, allocated }),
    evaluate: p => evaluatePlan(p, { preview: (pl, a) => town.preview(pl, modelId, a), horizonUs: C.horizonUs, scenarios: C.scenarios }), budget: C.budget });
}
const brief = r => ({ best: r.best.plan.planId, evaluated: r.evaluated, refused: r.refused, overrun: r.overrun, elapsedMs: r.elapsedMs,
  ranking: r.ranking.map(x => ({ planId: x.plan.planId, key: x.key, runs: x.runs.map(q => ({ scenario: q.scenario, water: q.outcome.waterEssentialUnmetM3, powerJ: q.outcome.powerEssentialUnservedJ, fuelJ: q.outcome.fuelUsedJ, minTankLevelM: q.outcome.minTankLevelM, receipts: q.outcome.receipts })) })) });

const report = { schema: 'lifeline.planner-check.v1', controls: 'fixtures/lifeline/infra/town/plan-controls.json', cases: {} };
for (const c of C.cases) {
  const town = spawnTownWorker({ root: ROOT });
  try {
    await town.initialize({ caseId: 't-no-fault', faults: c.faults, tankInitialLevels: c.tankInitialLevels });
    await town.advance(C.decisionAtUs);
    const level = (await town.observe()).readings.find(x => x.sensorId === 'water:lv-T1').value;
    const r = await decide(town);
    const entry = { observedTankLevelM: level, decision: brief(r) };
    if (c.caseId === 'pc-second-fault') {
      const run = await runTimedPlan({ town, plan: r.best.plan, untilUs: C.decisionAtUs + C.horizonUs, gridUs: C.gridUs, replan: async () => decide(town) });
      entry.execution = { log: run.log, expiredAtUs: run.expiredAtUs, replanned: run.replanned && brief(run.replanned), stateAfter: await town.state() };
    }
    report.cases[c.caseId] = entry;
    console.log(c.caseId, 'level', level.toFixed(2), 'best', r.best.plan.planId, entry.execution ? `expired at ${entry.execution.expiredAtUs / 1e6}s -> replan ${entry.execution.replanned?.best}` : '');
  } finally { await town.close(); }
}
writeFileSync(join(out, 'planner.json'), `${JSON.stringify(report, null, 1)}\n`);
