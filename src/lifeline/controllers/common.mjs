// Shared network arithmetic for every controller. Demands come from the declared workload (inventory),
// capacities from measured beliefs; nothing here reads fault truth.

export const WIRE_OVERHEAD_BYTES = 42; // Ethernet + IPv4 + UDP headers
export const ACK_BYTES = 40;

export function linkBetween(topology, a, b) {
  return topology.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a)) ?? null;
}

export function directedLinks(path, topology) {
  return path.slice(1).map((node, i) => ({ linkId: linkBetween(topology, path[i], node).linkId, from: path[i], to: node, key: `${path[i]}>${node}` }));
}

// Simple paths ordered by hop count, then lexicographically: deterministic tie-breaking.
export function candidatePaths(topology, from, to, limit = 3) {
  const adjacency = {};
  for (const n of topology.nodes) adjacency[n] = [];
  for (const l of topology.links) { adjacency[l.a].push(l.b); adjacency[l.b].push(l.a); }
  const paths = [];
  const walk = path => {
    const last = path.at(-1);
    if (last === to) { paths.push(path); return; }
    for (const next of [...adjacency[last]].sort()) if (!path.includes(next)) walk([...path, next]);
  };
  walk([from]);
  return paths.sort((x, y) => x.length - y.length || x.join().localeCompare(y.join())).slice(0, limit);
}

export const pathUp = (path, topology, observation) => directedLinks(path, topology).every(d => observation.links?.[d.linkId]?.state === 'up');

export const essentialDemandBps = flow => flow.messagesPerS * (flow.payloadBytes + WIRE_OVERHEAD_BYTES) * 8;
export const ackDemandBps = flow => flow.messagesPerS * (ACK_BYTES + WIRE_OVERHEAD_BYTES) * 8;
export const backgroundWireBps = (source, bps) => (bps * (source.packetBytes + WIRE_OVERHEAD_BYTES)) / source.packetBytes;

// The reference data plane fails over at the ingress when the primary's first hop is down.
export function backgroundPath(source, observation, topology) {
  const [first] = directedLinks(source.primary, topology);
  return observation.links?.[first.linkId]?.state === 'up' ? source.primary : source.backup;
}

export function loads({ inventory, routes, rates, observation }) {
  const load = {};
  const add = (path, bps) => { for (const d of directedLinks(path, inventory.topology)) load[d.key] = (load[d.key] ?? 0) + bps; };
  for (const flow of inventory.essential) {
    add(routes[flow.flowId].path, essentialDemandBps(flow));
    add(routes[flow.flowId].ackPath, ackDemandBps(flow));
  }
  for (const source of inventory.background) add(backgroundPath(source, observation, inventory.topology), backgroundWireBps(source, rates[source.sourceId]));
  return load;
}

// Effective path of a flow still on reference version 0 (fast-failover may have switched it).
export function effectiveRoute(flow, route, observation, inventory) {
  if (route.version !== 0) return route;
  const ref = inventory.reference[flow.flowId];
  const firstUp = path => observation.links?.[directedLinks(path, inventory.topology)[0].linkId]?.state === 'up';
  return { ...route, path: firstUp(ref.primary) ? ref.primary : ref.backup, ackPath: firstUp(ref.ackPrimary) ? ref.ackPrimary : ref.ackBackup };
}

// Inventory: operator-known topology, nominal link ratings, declared workload, reference routes.
export function buildInventory(scenario, policy) {
  const topology = {
    revision: scenario.topologyRevision, nodes: scenario.topology.switches,
    links: scenario.topology.links.map(({ linkId, a, b }) => ({ linkId, a, b })),
    endpoints: Object.fromEntries(scenario.topology.hosts.map(h => [h.hostId, h.switch])),
  };
  const priorities = Object.fromEntries(policy.essentialFlows.map(f => [f.flowId, f.priority]));
  const bounds = Object.fromEntries(policy.backgroundSources.map(s => [s.sourceId, s]));
  const ref = scenario.referencePolicy;
  return {
    topology,
    nominalCapacityBps: Object.fromEntries(scenario.topology.links.map(l => [l.linkId, l.bwMbit * 1e6])),
    essential: scenario.workload.essential.map(f => ({ ...f, priority: priorities[f.flowId], from: topology.endpoints[f.source], to: topology.endpoints[f.destination] }))
      .sort((x, y) => x.priority - y.priority || x.flowId.localeCompare(y.flowId)),
    background: scenario.workload.background.map(s => ({
      ...s, scheduledBps: s.bitsPerSecond, minBps: bounds[s.sourceId].minBitsPerSecond, primary: ref.routes[s.sourceId].primary, backup: ref.routes[s.sourceId].backup,
    })),
    reference: Object.fromEntries(scenario.workload.essential.map(f => [f.flowId, {
      primary: ref.routes[f.flowId].primary, backup: ref.routes[f.flowId].backup, ackPrimary: ref.ackRoutes[f.flowId].primary, ackBackup: ref.ackRoutes[f.flowId].backup,
    }])),
  };
}
