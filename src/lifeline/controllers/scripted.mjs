// Diagnostic controller: replays a fixed action script at stated times. It qualifies the guard and
// executor on real traffic; it is not a comparator and makes no decisions from observations.
export function createScriptedController(script) {
  const pending = script.steps.map((step, i) => ({ ...step, index: i, done: false }));
  return {
    name: 'scripted',
    decide({ trafficMs }) {
      const step = pending.find(s => !s.done && trafficMs >= s.atMs);
      if (!step) return null;
      step.done = true;
      return { proposalId: `script-${step.index + 1}`, actions: step.actions, preconditions: step.preconditions ?? [] };
    },
  };
}
