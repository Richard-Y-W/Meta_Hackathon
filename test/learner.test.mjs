import test from 'node:test';
import assert from 'node:assert/strict';
import { hypotheses, transition, INITIAL, GOALS, meets, key } from '../src/domain.mjs';
import { Learner } from '../src/learner.mjs';

function discover(learner, model, initial = INITIAL, limit = 64) {
  let state = { ...initial }, steps = 0;
  while (steps < limit) {
    const choice = learner.experiments(state)[0];
    if (!choice) return { state, steps };
    const next = transition(model, state, choice.action);
    learner.observe(state, choice.action, next);
    state = next; steps++;
  }
  throw new Error(`Discovery exceeded budget: ${model.id}`);
}

test('all 36 hidden mechanisms can be learned and every declared goal executed', () => {
  for (const model of hypotheses()) {
    const learner = new Learner();
    let { state } = discover(learner, model);
    assert.ok(learner.models.some(m => m.id === model.id), 'True mechanism must survive');
    assert.equal(learner.models.length, 1, model.id);
    for (const goal of Object.values(GOALS)) {
      const path = learner.plan(state, goal.target);
      assert.notEqual(path, null, `${model.id}: ${goal.label}`);
      for (const action of path) state = transition(model, state, action);
      assert.ok(meets(state, goal.target));
    }
  }
});

test('contradictions trigger recovery for every distinct pair of mechanisms', () => {
  for (const original of hypotheses()) for (const changed of hypotheses()) {
    if (original.id === changed.id) continue;
    const learner = new Learner();
    let { state } = discover(learner, original);
    // The verification policy sees only the learned original model.
    const covered = new Set();
    for (let i = 0; i < 96 && learner.revisions === 0; i++) {
      const path = learner.verification(state, covered);
      assert.ok(path, `${original.id} -> ${changed.id}`);
      const action = path[0]; covered.add(`${key(state)}:${action}`);
      const after = transition(changed, state, action);
      learner.observe(state, action, after); state = after;
    }
    assert.ok(learner.revisions >= 1);
    ({ state } = discover(learner, changed, state));
    assert.equal(learner.models.length, 1);
    assert.equal(learner.models[0].id, changed.id);
    const plan = learner.plan(state, GOALS.run.target);
    assert.notEqual(plan, null);
    for (const action of plan) state = transition(changed, state, action);
    assert.ok(state.motor);
  }
});

test('out-of-family observations are detected instead of silently explained', () => {
  const learner = new Learner();
  const event = learner.observe(INITIAL, 'A', { power: false, direction: false, motor: true });
  assert.ok(event.surprise); assert.equal(learner.models.length, 0);
  assert.deepEqual(learner.experiments(INITIAL), []);
});
