// Bounded counterfactual forecast for a route/rate configuration under current capacity beliefs.
// It predicts an interval for each essential flow's on-time fraction; it is advisory evidence, not a
// safety guarantee, and it never reads the emulator's configured or impaired capacities.
import { canonicalRecord } from './identity.mjs';
import { directedLinks, loads } from './controllers/common.mjs';
import { ASSUMPTIONS } from './beliefs.mjs';

export const FORECAST_VERSION = 'forecast-v1';

// Peak utilization on a flow's data or acknowledgement path -> on-time fraction interval. Development
// calibration: see docs/trials/lifeline-forecast-run-0.md. Monotone non-increasing in utilization.
export function onTimeInterval(utilization) {
  if (utilization <= 0.95) return [0.95, 1];
  if (utilization <= 1.1) return [0.3, 1];
  if (utilization <= 1.5) return [0, 0.6];
  return [0, 0.1];
}

export function forecast({ inventory, beliefs, routes, rates, observation }) {
  const forecastId = canonicalRecord({
    version: FORECAST_VERSION, beliefRevision: beliefs.revision, observationSeq: observation.seq,
    routes: Object.fromEntries(Object.entries(routes).map(([k, r]) => [k, { path: r.path, ackPath: r.ackPath }])), rates,
  }).sha256;
  const assumptions = [...ASSUMPTIONS, 'Links without carried-load evidence are assumed at nominal capacity.', 'No priority queueing: flows sharing a link share its delay and loss.'];
  if (beliefs.status() === 'model_inconsistent') return { version: FORECAST_VERSION, forecastId, status: 'model_inconsistent', assumptions };

  const load = loads({ inventory, routes, rates, observation });
  const nominalAssumed = new Set();
  const flows = inventory.essential.map(flow => {
    const keys = [...directedLinks(routes[flow.flowId].path, inventory.topology), ...directedLinks(routes[flow.flowId].ackPath, inventory.topology)];
    if (keys.some(d => observation.links?.[d.linkId]?.state !== 'up')) {
      return { flowId: flow.flowId, priority: flow.priority, path: routes[flow.flowId].path, predictedOnTime: [0, 0], reason: 'link_down' };
    }
    let optimistic = 0, pessimistic = 0;
    for (const d of keys) {
      const s = beliefs.record(d.key);
      if (!s.measured) nominalAssumed.add(d.key);
      const bps = load[d.key] ?? 0;
      optimistic = Math.max(optimistic, bps / Math.max(1, s.hi));
      pessimistic = Math.max(pessimistic, bps / Math.max(1, s.estimate !== null ? 0.9 * s.estimate : s.hi));
    }
    return {
      flowId: flow.flowId, priority: flow.priority, path: routes[flow.flowId].path,
      peakUtilization: { optimistic: Math.round(optimistic * 1000) / 1000, pessimistic: Math.round(pessimistic * 1000) / 1000 },
      predictedOnTime: [onTimeInterval(pessimistic)[0], onTimeInterval(optimistic)[1]],
    };
  });
  return { version: FORECAST_VERSION, forecastId, status: 'ok', flows, loads: load, nominalAssumed: [...nominalAssumed].sort(), beliefRevision: beliefs.revision, assumptions };
}
