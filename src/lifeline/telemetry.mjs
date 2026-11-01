// Supervisor-side observation admission and the controller-view information audit.

const FORBIDDEN_KEYS = new Set(['fault', 'faults', 'kind', 'bwMbit', 'queuePackets', 'schedule', 'atMs', 'hidden']);
const FORBIDDEN_VALUES = /\b(link_down|link_up|link_rate|link_loss|counter_loss|telemetry_hold|fault)\b/;

export function admitObservation(observation, { runId, nowMs, lastSeq, maxAgeMs }) {
  if (observation?.version !== 'ObservationV1') return { ok: false, code: 'unsupported_version' };
  if (observation.runId !== runId) return { ok: false, code: 'run_mismatch' };
  if (!Number.isInteger(observation.seq) || observation.seq <= lastSeq) return { ok: false, code: 'non_monotonic_sequence' };
  if (!Number.isFinite(observation.collectedAtMs) || observation.collectedAtMs > nowMs) return { ok: false, code: 'future_observation' };
  const ageMs = Math.round((nowMs - observation.collectedAtMs) * 1000) / 1000;
  return { ok: true, code: 'ok', observation: { ...observation, ageMs, stale: ageMs > maxAgeMs } };
}

// Walk everything a controller saw. Any administrative key, fault label or hidden schedule value is a finding.
export function auditControllerView(observations, hiddenFaults) {
  const findings = [];
  const hiddenNumbers = new Set(hiddenFaults.flatMap(f => (f.kind === 'link_rate' ? [`${f.linkId}:${f.bwMbit}`] : [])));
  const walk = (value, path, linkId) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`, linkId));
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) findings.push({ path: `${path}.${key}`, key });
        walk(child, `${path}.${key}`, /^r\d-r\d$/.test(key) ? key : linkId);
      }
      return;
    }
    if (typeof value === 'string' && FORBIDDEN_VALUES.test(value)) findings.push({ path, value: value.match(FORBIDDEN_VALUES)[0] });
    if (typeof value === 'number' && linkId && hiddenNumbers.has(`${linkId}:${value}`) && /capacity|bw|rate/i.test(path)) findings.push({ path, value });
  };
  observations.forEach((o, i) => walk(o, `$[${i}]`, null));
  return findings;
}

const delta = (cur, prev) => (typeof cur === 'number' && typeof prev === 'number' && cur >= prev ? cur - prev : null);

function at(history, targetMs) {
  let best = null;
  for (const o of history) if (o.collectedAtMs <= targetMs && (!best || o.collectedAtMs > best.collectedAtMs)) best = o;
  return best;
}

// Rates from admitted observations (oldest first). Link rates use the last two samples. The recent
// on-time fraction uses the sender's resolved counters (messages past their deadline), so in-flight
// messages are neither successes nor failures; with nothing resolved in the window it is null.
export function deriveRates(history, { windowMs = 2000 } = {}) {
  const cur = history.at(-1);
  const prev = history.length > 1 ? history.at(-2) : null;
  const dtS = prev ? (cur.collectedAtMs - prev.collectedAtMs) / 1000 : 0;
  const links = {};
  for (const [linkId, link] of Object.entries(cur.links ?? {})) {
    links[linkId] = {};
    for (const end of Object.keys(link.txBytes ?? {})) {
      const before = prev?.links?.[linkId];
      const tx = before && dtS > 0 ? delta(link.txBytes[end], before.txBytes?.[end]) : null;
      const drops = before && dtS > 0 ? delta(link.queueDrops?.[end], before.queueDrops?.[end]) : null;
      links[linkId][end] = {
        txBps: tx === null ? null : (tx * 8) / dtS, dropsPerS: drops === null ? null : drops / dtS,
        backlogBytes: link.backlogBytes?.[end] ?? null, state: link.state,
      };
    }
  }
  const services = {};
  const t = cur.collectedAtMs;
  const start = at(history, t - windowMs);
  for (const flowId of Object.keys(cur.services ?? {})) {
    const onTime = start ? delta(cur.services[flowId]?.resolvedOnTime, start.services?.[flowId]?.resolvedOnTime) : null;
    const offered = start ? delta(cur.services[flowId]?.resolvedOffered, start.services?.[flowId]?.resolvedOffered) : null;
    const sent = prev && dtS > 0 ? delta(cur.services[flowId]?.transmissions, prev.services?.[flowId]?.transmissions) : null;
    const created = prev && dtS > 0 ? delta(cur.services[flowId]?.offered, prev.services?.[flowId]?.offered) : null;
    services[flowId] = {
      recentOnTimeFraction: onTime !== null && offered ? Math.min(1, onTime / offered) : null,
      retransmissionRatio: sent !== null && created ? sent / created : null,
    };
  }
  return { atMs: t, links, services };
}
