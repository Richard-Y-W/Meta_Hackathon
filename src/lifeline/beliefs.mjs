// Evidence-linked capacity beliefs per directed link. Every change cites the observations behind it,
// old revisions are retained, and contradictions are recorded rather than overwritten. A belief whose
// lower bound exceeds its upper bound is model_inconsistent and cannot certify an intervention.
import { linkBetween } from './controllers/common.mjs';

const SATURATED_BACKLOG_BYTES = 20_000;
const SUPPORT_TOLERANCE = 0.15;

export const ASSUMPTIONS = [
  'Capacity is per direction and stationary between observations.',
  'Saturation (backlog above 20 KB or queue drops) means carried throughput approximates capacity.',
  'Carried load of at least 10% of nominal is a lower bound; an idle link is unmeasured.',
  'Loss without backlog is not represented as reduced capacity.',
];

const isSaturated = m => (m.backlogBytes ?? 0) > SATURATED_BACKLOG_BYTES || (m.dropsPerS ?? 0) > 0;

export class CapacityBeliefs {
  constructor(inventory) {
    this.inventory = inventory;
    this.state = {};
    this.revision = 0;
    this.history = [];
    this.contradictions = [];
    this.updatedAtMs = null;
    for (const l of inventory.topology.links) {
      for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) {
        this.state[`${a}>${b}`] = { linkId: l.linkId, from: a, nominal: inventory.nominalCapacityBps[l.linkId], lo: 0, hi: inventory.nominalCapacityBps[l.linkId], estimate: null, measured: false, down: false, evidence: [] };
      }
    }
  }

  record(key) { const s = this.state[key]; return { ...s, evidence: [...s.evidence] }; }
  interval(key) { return [this.state[key].lo, this.state[key].hi]; }
  measured(key) { return this.state[key].measured; }
  planning(key) { const s = this.state[key]; return s.estimate ?? s.hi; }
  status() { return Object.values(this.state).some(s => s.lo > s.hi) ? 'model_inconsistent' : 'ok'; }

  #commit(changes, atMs) {
    if (!changes.length) return;
    this.revision++;
    for (const key of changes) this.history.push({ revision: this.revision, key, ...this.record(key) });
    if (atMs !== undefined) this.updatedAtMs = atMs;
  }

  update(observation, rates) {
    const id = `obs-${observation.seq}`;
    const changes = [];
    const set = (key, values) => {
      const s = this.state[key];
      if (Object.entries(values).every(([k, v]) => JSON.stringify(s[k]) === JSON.stringify(v))) return;
      Object.assign(s, values);
      changes.push(key);
    };
    for (const [key, s] of Object.entries(this.state)) {
      const up = observation.links?.[s.linkId]?.state === 'up';
      if (!up) { if (!s.down) set(key, { lo: 0, hi: 0, estimate: 0, down: true, evidence: [id] }); continue; }
      if (s.down) set(key, { lo: 0, hi: s.nominal, estimate: null, down: false, evidence: [id] });
      const m = rates.links?.[s.linkId]?.[s.from];
      if (!m || typeof m.txBps !== 'number') continue; // missing stays missing
      if (isSaturated(m)) {
        set(key, { lo: 0.9 * m.txBps, hi: Math.min(s.nominal, 1.1 * m.txBps), estimate: m.txBps, measured: true, evidence: [id] });
      } else if (m.txBps >= 0.1 * s.nominal) {
        if (s.estimate !== null && m.txBps >= 0.95 * s.hi) {
          this.contradictions.push({ key, evidence: [...s.evidence, id], previous: { lo: s.lo, hi: s.hi }, observedBps: m.txBps, revision: this.revision + 1 });
          set(key, { lo: Math.min(m.txBps, s.nominal), hi: s.nominal, estimate: null, measured: true, evidence: [id] });
        } else if (m.txBps > s.lo || !s.measured) {
          set(key, { lo: Math.max(s.lo, Math.min(m.txBps, s.hi)), measured: true, evidence: [...new Set([...s.evidence, id])].slice(-4) });
        }
      }
    }
    this.#commit(changes, observation.collectedAtMs);
  }

  // A model may narrow a belief only with cited, retained measurements that support the value.
  applyProposedUpdate({ link, hiBps, loBps, evidence }, store) {
    const s = this.state[link];
    if (!s) return { ok: false, code: 'unknown_link' };
    if (!Array.isArray(evidence) || !evidence.length || evidence.some(id => !Object.hasOwn(store, id))) return { ok: false, code: 'evidence_unknown' };
    const measured = evidence.map(id => store[id].links?.[s.linkId]?.[s.from]).filter(m => m && typeof m.txBps === 'number');
    const supportsHi = hiBps === undefined || measured.some(m => isSaturated(m) && Math.abs(m.txBps - hiBps) <= SUPPORT_TOLERANCE * hiBps);
    const supportsLo = loBps === undefined || measured.some(m => m.txBps >= (1 - SUPPORT_TOLERANCE) * loBps);
    if (!supportsHi || !supportsLo || (hiBps === undefined && loBps === undefined)) return { ok: false, code: 'evidence_unsupported' };
    const values = { evidence: [...evidence], measured: true };
    if (hiBps !== undefined) Object.assign(values, { hi: Math.min(s.nominal, hiBps), estimate: hiBps });
    if (loBps !== undefined) values.lo = loBps;
    Object.assign(s, values);
    if (s.lo > s.hi) this.contradictions.push({ key: link, evidence: [...evidence], previous: null, observedBps: null, revision: this.revision + 1, reason: 'lower bound above upper bound' });
    this.#commit([link]);
    return { ok: true, code: 'ok', revision: this.revision, status: this.status() };
  }

  snapshot(nowMs) {
    return {
      version: 'BeliefV1', revision: this.revision, status: this.status(), assumptions: [...ASSUMPTIONS],
      links: Object.fromEntries(Object.keys(this.state).map(k => [k, this.record(k)])),
      contradictions: this.contradictions.map(c => ({ ...c, evidence: [...c.evidence] })),
      ageMs: this.updatedAtMs === null ? null : nowMs - this.updatedAtMs,
    };
  }
}

export { linkBetween };
