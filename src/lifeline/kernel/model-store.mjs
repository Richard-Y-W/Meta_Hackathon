// Structured parameter and dependency hypotheses (P14). Every entry cites admitted evidence, carries a
// version and an expiry, and is checked against current entries for contradiction. A parameter with no live
// entry, an expired entry, or contradictory entries reads as unknown: nothing is filled in by default.
export function createModelStore({ evidenceIds = () => new Set() } = {}) {
  const entries = new Map(); // key -> [entry]
  let version = 0;
  const live = (key, nowUs) => (entries.get(key) ?? []).filter(e => e.expiresAtUs > nowUs && !e.retracted);

  function add({ key, value, unit, evidence, source, nowUs, ttlUs }) {
    if (typeof key !== 'string' || !key) return { ok: false, code: 'invalid_key' };
    if (!Array.isArray(evidence) || !evidence.length) return { ok: false, code: 'evidence_required' };
    const known = evidenceIds();
    const unknown = evidence.filter(id => !known.has(id));
    if (unknown.length) return { ok: false, code: 'evidence_unknown', detail: unknown };
    if (value !== null && !(typeof value === 'number' && Number.isFinite(value)) && typeof value !== 'boolean' && typeof value !== 'string') return { ok: false, code: 'invalid_value' };
    if (!(Number.isInteger(ttlUs) && ttlUs > 0)) return { ok: false, code: 'expiry_required' };
    const current = live(key, nowUs);
    const conflicting = current.filter(e => e.value !== value || e.unit !== unit);
    const entry = { key, value, unit, evidence: [...evidence], source, version: ++version, addedAtUs: nowUs, expiresAtUs: nowUs + ttlUs, retracted: false };
    entries.set(key, [...(entries.get(key) ?? []), entry]);
    return { ok: true, code: conflicting.length ? 'contradiction' : 'ok', version: entry.version, contradicts: conflicting.map(e => e.version) };
  }

  function read(key, nowUs) {
    const current = live(key, nowUs);
    if (!current.length) return { status: 'unknown', value: null };
    const values = new Set(current.map(e => JSON.stringify([e.value, e.unit])));
    if (values.size > 1) return { status: 'contradictory', value: null, versions: current.map(e => e.version) };
    const latest = current.at(-1);
    if (latest.value === null) return { status: 'unknown', value: null, versions: [latest.version] };
    return { status: 'supported', value: latest.value, unit: latest.unit, versions: current.map(e => e.version), evidence: [...new Set(current.flatMap(e => e.evidence))] };
  }

  function retract(versionId, reason) {
    for (const list of entries.values()) for (const e of list) if (e.version === versionId) { e.retracted = true; e.retractedReason = reason; return { ok: true }; }
    return { ok: false, code: 'unknown_version' };
  }

  return { add, read, retract, snapshot: () => [...entries.values()].flat().map(e => ({ ...e })), get version() { return version; } };
}
