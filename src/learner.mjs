import { ACTIONS, hypotheses, transition, partition, entropy, same, key, meets } from './domain.mjs';

export class Learner {
  constructor() {
    this.models = hypotheses();
    this.history = [];
    this.revisions = 0;
    this.epochSteps = 0;
  }

  observe(before, action, after, decision = {}) {
    const prior = this.models.length;
    let remaining = this.models.filter(m => same(transition(m, before, action), after));
    const surprise = remaining.length === 0;
    if (surprise) {
      this.revisions++;
      this.epochSteps = 0;
      remaining = hypotheses().filter(m => same(transition(m, before, action), after));
    }
    this.models = remaining;
    this.epochSteps++;
    const event = { step: this.history.length + 1, revision: this.revisions, before, action, after,
      prior, remaining: remaining.length, surprise, ...decision };
    this.history.push(event);
    return event;
  }

  // Search only paths on which ALL surviving hypotheses agree. A proposed test
  // is scored by entropy of predicted outcomes, penalized for navigation cost.
  experiments(state) {
    if (!this.models.length) return [];
    const queue = [{ state, path: [] }], seen = new Set([key(state)]), choices = [];
    while (queue.length) {
      const node = queue.shift();
      for (const action of ACTIONS) {
        const groups = partition(this.models, node.state, action);
        if (groups.length > 1) {
          const information = entropy(groups, this.models.length);
          choices.push({ action: node.path[0] ?? action, testAction: action,
            path: [...node.path, action], information, score: information / (node.path.length + 1),
            outcomes: groups.map(g => ({ state: g.state, count: g.models.length })) });
        } else {
          const next = groups[0].state;
          if (!seen.has(key(next))) { seen.add(key(next)); queue.push({ state: next, path: [...node.path, action] }); }
        }
      }
    }
    return choices.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.action.localeCompare(b.action));
  }

  plan(state, target) {
    const queue = [{ state, path: [] }], seen = new Set([key(state)]);
    while (queue.length) {
      const node = queue.shift();
      if (meets(node.state, target)) return node.path;
      for (const action of ACTIONS) {
        const groups = partition(this.models, node.state, action);
        if (groups.length !== 1) continue;
        const next = groups[0].state;
        if (!seen.has(key(next))) { seen.add(key(next)); queue.push({ state: next, path: [...node.path, action] }); }
      }
    }
    return null;
  }

  verification(state, covered) {
    if (!this.models.length) return null;
    const queue = [{ state, path: [] }], seen = new Set([key(state)]);
    while (queue.length) {
      const node = queue.shift();
      for (const action of ACTIONS) {
        if (!covered.has(`${key(node.state)}:${action}`)) return [...node.path, action];
        const groups = partition(this.models, node.state, action);
        if (groups.length === 1 && !seen.has(key(groups[0].state))) {
          seen.add(key(groups[0].state));
          queue.push({ state: groups[0].state, path: [...node.path, action] });
        }
      }
    }
    return null;
  }

  summary(state) {
    const candidates = this.experiments(state);
    return { hypotheses: this.models.length, identified: this.models.length === 1,
      settled: this.models.length > 0 && candidates.length === 0,
      revisions: this.revisions, experiments: this.history.length, epochSteps: this.epochSteps,
      candidates: candidates.slice(0, 5), models: this.models.slice(0, 36) };
  }
}
