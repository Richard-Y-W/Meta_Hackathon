// Adaptive conventional supervisor: measured capacity beliefs, bounded probes of unmeasured candidates,
// exhaustive route x background-rate search over a small candidate set, hysteresis, shared guard/executor.
import { candidatePaths, directedLinks, effectiveRoute, loads, pathUp } from './common.mjs';
import { CapacityBeliefs } from '../beliefs.mjs';

export { CapacityBeliefs };

const LIMIT = 0.95;
const DEGRADED = 0.9; // on-time fraction below which a flow counts as degraded
const PERSIST = 3;    // consecutive degraded samples before the unexplained-degradation rule acts
const HOLD_MS = 5000;
const PROBE = { packetCount: 16, payloadBytes: 1000, intervalMs: 10 };

export function createAdaptiveController(inventory, policy) {
  const beliefs = new CapacityBeliefs(inventory);
  const holdUntil = {};
  const probed = {}; // path key -> {ok, atMs}
  let pendingProbe = null;
  let lastBest = null;
  const degraded = {};
  let unavailable = [];

  function evaluate(routes, rates, observation) {
    const load = loads({ inventory, routes, rates, observation });
    let weighted = 0, peak = 0;
    for (const flow of inventory.essential) {
      const keys = [...directedLinks(routes[flow.flowId].path, inventory.topology), ...directedLinks(routes[flow.flowId].ackPath, inventory.topology)].map(d => d.key);
      const util = keys.map(k => (load[k] ?? 0) / Math.max(1, beliefs.planning(k)));
      if (util.every(u => u <= LIMIT)) weighted += 10 ** (3 - flow.priority);
      peak = Math.max(peak, ...util);
    }
    return { weighted, background: Object.values(rates).reduce((a, b) => a + b, 0), peak: Math.round(peak * 100) / 100 };
  }

  function plan(observation, rates, routes, backgroundRates) {
    const up = { ...inventory.topology, links: inventory.topology.links.filter(l => observation.links?.[l.linkId]?.state === 'up') };
    const current = Object.fromEntries(inventory.essential.map(f => [f.flowId, effectiveRoute(f, routes[f.flowId], observation, inventory)]));
    const options = inventory.essential.map(f => {
      const paths = candidatePaths(up, f.from, f.to);
      const cur = current[f.flowId].path;
      if (pathUp(cur, inventory.topology, observation) && !paths.some(p => p.join() === cur.join())) paths.push(cur);
      return paths.length ? paths : [cur];
    });
    const grids = inventory.background.map(s => [...new Set([s.scheduledBps, s.scheduledBps / 2, s.scheduledBps / 4, s.minBps, backgroundRates[s.sourceId]])].map(Math.round));
    let best = null, combos = 0;
    const better = (x, y) => {
      const kx = [x.score[0], x.score[1], -x.score[2], -x.score[3], -x.score[4]], ky = [y.score[0], y.score[1], -y.score[2], -y.score[3], -y.score[4]];
      for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return kx[i] > ky[i];
      return false;
    };
    const walk = (i, chosen, order) => {
      if (i < options.length) { options[i].forEach((p, j) => walk(i + 1, { ...chosen, [inventory.essential[i].flowId]: { path: p, ackPath: [...p].reverse() } }, order + j)); return; }
      const rateWalk = (k, rates) => {
        if (k < grids.length) { for (const r of grids[k]) rateWalk(k + 1, { ...rates, [inventory.background[k].sourceId]: r }); return; }
        combos++;
        const e = evaluate(chosen, rates, observation);
        const changes = inventory.essential.filter(f => chosen[f.flowId].path.join() !== current[f.flowId].path.join()).length;
        const candidate = { score: [e.weighted, e.background, e.peak, changes, order], routes: chosen, rates };
        if (!best || better(candidate, best)) best = candidate;
      };
      rateWalk(0, {});
    };
    walk(0, {}, 0);
    return { ...best, current, combos, exhaustive: true };
  }

  // Conventional rule for degradation the capacity model cannot explain (e.g. loss on a switch that
  // stopped reporting): probe the best alternative path, and move only if the probe is clean.
  function unexplained(observation, routes, backgroundRates, nowMs, remaining, current, up) {
    const flow = inventory.essential.find(f => degraded[f.flowId] >= PERSIST && !unavailable.includes(f.flowId) && (holdUntil[f.flowId] ?? 0) <= nowMs);
    if (!flow) return null;
    const here = current[flow.flowId].path.join();
    const fresh = key => probed[key] && nowMs - probed[key].atMs < 20_000;
    const options = candidatePaths(up, flow.from, flow.to)
      .filter(p => p.join() !== here && !(fresh(p.join()) && !probed[p.join()].ok))
      .map(p => ({ p, e: evaluate({ ...current, [flow.flowId]: { path: p, ackPath: [...p].reverse() } }, backgroundRates, observation) }))
      .sort((x, y) => y.e.weighted - x.e.weighted || x.e.peak - y.e.peak);
    if (!options.length) return null;
    const { p } = options[0];
    if (fresh(p.join()) && probed[p.join()].ok) {
      degraded[flow.flowId] = 0;
      return {
        actions: [{ actionId: 'a1', type: 'set_route', flowId: flow.flowId, path: p, ackPath: [...p].reverse() }],
        preconditions: [{ kind: 'service_on_time_below', flowId: flow.flowId, onTimeFraction: DEGRADED }],
        rationale: `unexplained degradation of ${flow.flowId}; clean probe of ${p.join('-')}`,
      };
    }
    if (remaining.incidentProbeBytes < PROBE.packetCount * PROBE.payloadBytes) return null;
    pendingProbe = { atMs: nowMs };
    return { actions: [{ actionId: 'a1', type: 'probe_path', sourceId: flow.source, destinationId: flow.destination, ...PROBE, path: p }], preconditions: [], rationale: `unexplained degradation of ${flow.flowId}: probe ${p.join('-')}` };
  }

  return {
    name: 'adaptive',
    beliefs,
    plan,
    unavailable: () => unavailable,
    applied(intent, result) {
      if (intent.actions[0]?.type === 'probe_path') {
        const m = result.receipts?.[0]?.measurement;
        probed[intent.actions[0].path.join()] = { ok: Boolean(m) && m.lossFraction <= 0.05, atMs: result.nowMs };
        pendingProbe = null;
        return;
      }
      if (result.status !== 'confirmed') return;
      for (const a of intent.actions) holdUntil[a.flowId ?? a.sourceId] = result.nowMs + HOLD_MS;
      lastBest = null;
    },
    decide({ observation, rates, routes, backgroundRates, nowMs, remaining }) {
      if (observation.stale) return null;
      beliefs.update(observation, rates);
      for (const f of inventory.essential) {
        const fraction = rates.services?.[f.flowId]?.recentOnTimeFraction;
        degraded[f.flowId] = typeof fraction === 'number' && fraction < DEGRADED ? (degraded[f.flowId] ?? 0) + 1 : 0;
      }
      const up = { ...inventory.topology, links: inventory.topology.links.filter(l => observation.links?.[l.linkId]?.state === 'up') };
      unavailable = inventory.essential.filter(f => candidatePaths(up, f.from, f.to, 1).length === 0).map(f => f.flowId);
      if (pendingProbe && nowMs - pendingProbe.atMs < 3000) return null;
      pendingProbe = null;
      const best = plan(observation, rates, routes, backgroundRates);
      const changed = inventory.essential.filter(f => !unavailable.includes(f.flowId) && best.routes[f.flowId].path.join() !== best.current[f.flowId].path.join() && (holdUntil[f.flowId] ?? 0) <= nowMs);
      const rateChanges = inventory.background.filter(s => best.rates[s.sourceId] !== backgroundRates[s.sourceId] && (holdUntil[s.sourceId] ?? 0) <= nowMs);
      const now = evaluate(Object.fromEntries(inventory.essential.map(f => [f.flowId, best.current[f.flowId]])), backgroundRates, observation);
      // Act for essential feasibility or to restore background; headroom only ranks plans once acting.
      const improves = best.score[0] > now.weighted || (best.score[0] === now.weighted && best.score[1] > now.background * 1.1);
      if ((!changed.length && !rateChanges.length) || !improves) { lastBest = null; return unexplained(observation, routes, backgroundRates, nowMs, remaining, best.current, up); }
      const outage = changed.some(f => !pathUp(best.current[f.flowId].path, inventory.topology, observation) || !pathUp(best.current[f.flowId].ackPath, inventory.topology, observation));
      const signature = JSON.stringify([changed.map(f => best.routes[f.flowId].path), rateChanges.map(s => best.rates[s.sourceId])]);
      if (!outage && lastBest !== signature) { lastBest = signature; return null; } // persistence: the same plan twice
      // Probe an unmeasured target path before moving essential traffic onto it (not during outages).
      if (!outage) {
        for (const f of changed) {
          const path = best.routes[f.flowId].path;
          const unmeasured = directedLinks(path, inventory.topology).some(d => !beliefs.measured(d.key));
          const known = probed[path.join()];
          if (known && !known.ok && nowMs - known.atMs < 20_000) return null;
          if (unmeasured && !(known?.ok && nowMs - known.atMs < 20_000) && remaining.incidentProbeBytes >= PROBE.packetCount * PROBE.payloadBytes) {
            pendingProbe = { atMs: nowMs };
            return { actions: [{ actionId: 'a1', type: 'probe_path', sourceId: f.source, destinationId: f.destination, ...PROBE, path }], preconditions: [], rationale: `probe ${path.join('-')} before moving ${f.flowId}` };
          }
        }
      }
      const actions = [];
      const push = a => actions.push({ actionId: `a${actions.length + 1}`, ...a });
      for (const s of rateChanges.filter(s => best.rates[s.sourceId] < backgroundRates[s.sourceId])) push({ type: 'set_background_rate', sourceId: s.sourceId, bitsPerSecond: best.rates[s.sourceId] });
      for (const f of changed) push({ type: 'set_route', flowId: f.flowId, path: best.routes[f.flowId].path, ackPath: best.routes[f.flowId].ackPath });
      for (const s of rateChanges.filter(s => best.rates[s.sourceId] > backgroundRates[s.sourceId])) push({ type: 'set_background_rate', sourceId: s.sourceId, bitsPerSecond: best.rates[s.sourceId] });
      const down = changed.flatMap(f => [...directedLinks(best.current[f.flowId].path, inventory.topology), ...directedLinks(best.current[f.flowId].ackPath, inventory.topology)])
        .map(d => d.linkId).filter((id, i, all) => all.indexOf(id) === i && observation.links?.[id]?.state !== 'up');
      lastBest = null;
      return {
        actions: actions.slice(0, policy.limits.maxActionsPerBundle),
        preconditions: down.map(linkId => ({ kind: 'link_state', linkId, state: 'down' })),
        rationale: `plan score ${best.score.join('/')} vs ${now.weighted}/${now.background}/${now.peak}`,
        transition: { capacityBps: Object.fromEntries(inventory.topology.links.map(l => [l.linkId, Math.min(beliefs.planning(`${l.a}>${l.b}`), beliefs.planning(`${l.b}>${l.a}`))])) },
      };
    },
  };
}
