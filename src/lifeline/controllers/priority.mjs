// Priority-aware failover reference: observed link state, operator priorities, alternate routes and
// permitted background throttling. No capacity model and no probing.
import { candidatePaths, directedLinks, effectiveRoute, pathUp } from './common.mjs';

const ON_TIME_TARGET = 0.95;
const HOLD_MS = 5000;

export function createPriorityController(inventory, policy) {
  const holdUntil = {};
  const degradedSamples = {};
  let unavailable = [];
  const upTopology = observation => ({ ...inventory.topology, links: inventory.topology.links.filter(l => observation.links?.[l.linkId]?.state === 'up') });

  return {
    name: 'priority',
    unavailable: () => unavailable,
    applied(intent, result) {
      if (result.status !== 'confirmed') return;
      for (const a of intent.actions) holdUntil[a.flowId ?? a.sourceId] = result.nowMs + HOLD_MS;
    },
    decide({ observation, rates, routes, backgroundRates, nowMs }) {
      if (observation.stale) return null;
      const up = upTopology(observation);
      unavailable = inventory.essential.filter(f => candidatePaths(up, f.from, f.to, 1).length === 0).map(f => f.flowId);
      for (const flow of inventory.essential) {
        if (unavailable.includes(flow.flowId) || (holdUntil[flow.flowId] ?? 0) > nowMs) continue;
        const route = effectiveRoute(flow, routes[flow.flowId], observation, inventory);
        if (pathUp(route.path, inventory.topology, observation) && pathUp(route.ackPath, inventory.topology, observation)) continue;
        const [path] = candidatePaths(up, flow.from, flow.to, 1);
        const down = [...directedLinks(route.path, inventory.topology), ...directedLinks(route.ackPath, inventory.topology)]
          .map(d => d.linkId).filter((id, i, all) => all.indexOf(id) === i && observation.links?.[id]?.state !== 'up');
        return {
          actions: [{ actionId: 'a1', type: 'set_route', flowId: flow.flowId, path, ackPath: [...path].reverse() }],
          preconditions: down.map(linkId => ({ kind: 'link_state', linkId, state: 'down' })),
          rationale: `failover ${flow.flowId}: ${down.join(',')} down`,
        };
      }
      // Shed background that shares a directed link with a persistently degraded essential path.
      for (const flow of inventory.essential) {
        if (unavailable.includes(flow.flowId)) continue; // shedding cannot help a flow with no path
        const fraction = rates.services?.[flow.flowId]?.recentOnTimeFraction;
        degradedSamples[flow.flowId] = typeof fraction === 'number' && fraction < ON_TIME_TARGET ? (degradedSamples[flow.flowId] ?? 0) + 1 : 0;
        if (degradedSamples[flow.flowId] < 2) continue;
        const route = effectiveRoute(flow, routes[flow.flowId], observation, inventory);
        const used = new Set(directedLinks(route.path, inventory.topology).map(d => d.key));
        const actions = inventory.background
          .filter(s => backgroundRates[s.sourceId] > s.minBps && (holdUntil[s.sourceId] ?? 0) <= nowMs)
          .filter(s => directedLinks(s.primary, inventory.topology).some(d => used.has(d.key)) || directedLinks(s.backup, inventory.topology).some(d => used.has(d.key)))
          .map((s, i) => ({ actionId: `a${i + 1}`, type: 'set_background_rate', sourceId: s.sourceId, bitsPerSecond: s.minBps }));
        if (actions.length) {
          return { actions, preconditions: [{ kind: 'service_on_time_below', flowId: flow.flowId, onTimeFraction: ON_TIME_TARGET }], rationale: `shed background for ${flow.flowId}` };
        }
      }
      return null;
    },
  };
}
