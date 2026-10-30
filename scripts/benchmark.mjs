import { mkdir, writeFile } from 'node:fs/promises';
import { Learner } from '../src/learner.mjs';
import { hypotheses, INITIAL, transition, GOALS, meets } from '../src/domain.mjs';

// Reproducible pseudo-random baseline; not used to generate hidden live rules.
function random(seed) { return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }; }
function run(model, policy, rng, limit = 64) {
  const learner = new Learner(); let state = { ...INITIAL }, steps = 0;
  while (steps < limit && learner.models.length !== 1) {
    const action = policy === 'active' ? learner.experiments(state)[0]?.action : ['A', 'B', 'C'][Math.floor(rng() * 3)];
    if (!action) break;
    const after = transition(model, state, action);
    learner.observe(state, action, after); state = after; steps++;
  }
  let successes = 0;
  for (const goal of Object.values(GOALS)) {
    const path = learner.plan(state, goal.target);
    if (path === null) continue;
    for (const action of path) state = transition(model, state, action);
    if (meets(state, goal.target)) successes++;
  }
  return { mechanism: model.id, policy, steps, identified: learner.models.length === 1, taskSuccesses: successes };
}
const rows = [];
for (const [i, model] of hypotheses().entries()) {
  rows.push(run(model, 'active', random(i + 1)));
  for (let repeat = 0; repeat < 20; repeat++) rows.push({ repeat, ...run(model, 'random', random(2026 + i * 100 + repeat)) });
}
const summary = Object.fromEntries(['active', 'random'].map(policy => {
  const group = rows.filter(r => r.policy === policy);
  return [policy, { runs: group.length, identificationRate: group.filter(r => r.identified).length / group.length,
    meanActions: group.reduce((n, r) => n + r.steps, 0) / group.length,
    maxActions: Math.max(...group.map(r => r.steps)), taskSuccessRate: group.reduce((n, r) => n + r.taskSuccesses, 0) / (group.length * Object.keys(GOALS).length) }];
}));
const report = { generatedAt: new Date().toISOString(), budget: 64, randomRepeatsPerMechanism: 20,
  scope: 'Simulator, declared family of 36 fully observed deterministic mechanisms. Both policies share the same hypotheses and observations. No physical, visual, or Meta API performance is measured.', summary, rows };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/benchmark.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
