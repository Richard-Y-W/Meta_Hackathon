// Supervisor-side observation admission and the controller-view information audit.

const FORBIDDEN_KEYS = new Set(['fault', 'faults', 'kind', 'bwMbit', 'queuePackets', 'schedule', 'atMs', 'hidden']);
const FORBIDDEN_VALUES = /\b(link_down|link_up|link_rate|fault)\b/;

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
