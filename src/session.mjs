import { randomUUID } from 'node:crypto';
import { Learner } from './learner.mjs';
import { GOALS, describe, meets, partition, key } from './domain.mjs';
import { chooseWithMuse } from './meta.mjs';

export class Session {
  constructor(device, kind = 'simulation') {
    this.id = randomUUID(); this.device = device; this.kind = kind;
    this.learner = new Learner(); this.state = null; this.audit = []; this.tasks = [];
    this.covered = new Set(); this.busy = false;
  }
  async init() {
    const observation = await this.device.observe();
    this.state = observation.observation;
    this.audit.push({ type: 'session', at: new Date().toISOString(), commitment: observation.commitment, kind: this.kind });
    return this;
  }
  view() {
    return { id: this.id, kind: this.kind, state: this.state, ...this.learner.summary(this.state),
      history: this.learner.history, tasks: this.tasks, goals: GOALS,
      metaConfigured: !!process.env.MODEL_API_KEY, busy: this.busy };
  }
  async exclusive(fn) {
    if (this.busy) throw new Error('An operation is already in progress');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async act(action, decision) {
    const before = { ...this.state };
    const predictions = partition(this.learner.models, before, action).map(g => ({ state: g.state, count: g.models.length }));
    const result = await this.device.press(action);
    this.state = result.observation;
    const event = this.learner.observe(before, action, this.state, { ...decision, predictions, at: new Date().toISOString() });
    if (event.surprise) this.covered.clear();
    this.audit.push({ type: 'experiment', ...event });
    if (!this.learner.models.length) throw new Error('Observation is outside the supported hypothesis family. Stop and expand the model family.');
    return event;
  }
  async step({ provider = 'local', verify = false, newSweep = false } = {}) {
    return this.exclusive(async () => {
      if (!['local', 'meta'].includes(provider)) throw new Error('Unknown planner');
      if (verify && newSweep) this.covered.clear();
      const candidates = this.learner.experiments(this.state);
      let choice;
      if (candidates.length) {
        choice = provider === 'meta' ? await chooseWithMuse({ observation: this.state, hypotheses: this.learner.models, recentEvidence: this.learner.history.slice(-12) }, candidates.slice(0, 8)) : {
          ...candidates[0], provider: 'Local active learning',
          reason: candidates[0].path.length > 1
            ? `Navigate via ${candidates[0].path.join(' → ')} to a test that separates the remaining hypotheses (${candidates[0].information.toFixed(2)} bits).`
            : `Press ${candidates[0].action}: predicted outcomes split the remaining hypotheses (${candidates[0].information.toFixed(2)} bits).`
        };
      } else if (verify) {
        let path = this.learner.verification(this.state, this.covered);
        if (!path) return { done: true, message: 'Every reachable state-action prediction passed the verification sweep.' };
        const action = path[0];
        this.covered.add(`${key(this.state)}:${action}`);
        choice = { action, provider: 'Verification sweep', information: 0,
          reason: `Check the learned prediction for ${action} from ${describe(this.state)}.` };
      } else return { done: true, message: 'No distinguishing experiment remains in reachable states.' };
      const event = await this.act(choice.action, { provider: choice.provider, reason: choice.reason, information: choice.information, model: choice.model, responseId: choice.responseId });
      return { done: false, event };
    });
  }
  async task(goalId) {
    if (!GOALS[goalId]) throw new Error('Unknown task');
    return this.exclusive(async () => {
      const goal = GOALS[goalId], start = this.learner.history.length;
      const record = { goalId, label: goal.label, target: goal.target, at: new Date().toISOString(), status: 'incomplete', actions: [] };
      for (let budget = 0; budget < 16; budget++) {
        // Success requires a fresh observation, including zero-action tasks.
        this.state = (await this.device.observe()).observation;
        if (meets(this.state, goal.target)) { record.status = 'verified'; break; }
        const path = this.learner.plan(this.state, goal.target);
        if (!path?.length) { record.status = 'needs-learning'; break; }
        const event = await this.act(path[0], { provider: 'Learned task planner', reason: `Execute ${goal.label}; verify the observation after each action.` });
        record.actions.push(event.action);
        if (event.surprise) { record.status = 'model-changed'; break; }
      }
      record.observation = { ...this.state };
      record.steps = this.learner.history.length - start;
      this.tasks.push(record); this.audit.push({ type: 'task', ...record });
      return record;
    });
  }
  async mutate() {
    return this.exclusive(async () => {
      const result = await this.device.mutate();
      // Administrator-only evidence: no learner reset and no rule-change signal.
      this.audit.push({ type: 'operator-rule-change', at: new Date().toISOString(), commitment: result.commitment, afterExperiment: this.learner.history.length });
      return { changed: true };
    });
  }
  export() {
    return { schema: 'blackbox-apprentice/evidence-v1', id: this.id, exportedAt: new Date().toISOString(),
      limitations: ['Bounded family of 36 deterministic, fully observed state machines.', 'Simulation is not evidence of physical operation.', 'Commitments record rule continuity; they are not independent attestation.', 'Meta requests occur only when Meta mode is selected and configured.'],
      ...this.view(), audit: this.audit };
  }
  close() { this.device.close(); }
}
