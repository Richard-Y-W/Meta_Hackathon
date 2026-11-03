// P19 attribution variants. Each removes or replaces exactly one mechanism of the Meta-assisted controller
// and keeps the rest: the priority rule layer, the plan template catalog, the admitted observations and the
// executor. `withholdAdvisory` is honored by the evaluator (the variant sees no forecast at all).
import { hybrid, independent } from './joint.mjs';
import { metaJoint } from './meta-joint.mjs';

// Matched latency: the same gate and planner as Meta-assisted control, but the "call" is a wait of the
// measured provider duration and returns no content. Isolates the latency of asking from the answer.
export function latencyStub(delayMs, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  return async ({ timeoutMs }) => {
    const wait = Math.min(delayMs, timeoutMs);
    await sleep(wait);
    return wait < delayMs ? { code: 'provider_timeout', reason: 'timeout', durationMs: wait, stub: true } : { code: 'latency_only', durationMs: wait, stub: true };
  };
}

export function variants(policy, { callModel, maxCalls, providerCapS, matchedDelayMs, sleep }) {
  const named = (c, name, extra = {}) => Object.assign(c, { name, ...extra });
  return {
    hybrid: () => hybrid(policy),
    independent: () => independent(policy),
    'hybrid-no-forecast': () => named(hybrid(policy), 'hybrid-no-forecast', { withholdAdvisory: true }),
    'meta-narrator': () => metaJoint(policy, { mode: 'narrator', callModel, maxCalls, providerCapS }),
    'meta-latency-matched': () => named(metaJoint(policy, { mode: 'complete', callModel: latencyStub(matchedDelayMs, sleep), maxCalls, providerCapS }), 'meta-latency-matched'),
    'meta-fixed-cadence': () => named(metaJoint(policy, { mode: 'complete', callModel, maxCalls, providerCapS, cadence: 'fixed' }), 'meta-fixed-cadence'),
  };
}

// What a controller is shown as forecast: nothing for the no-forecast variant, the case's advisory otherwise.
export const advisoryFor = (controller, c) => (controller.withholdAdvisory ? null : c.advisory ?? null);
