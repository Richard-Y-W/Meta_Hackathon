// Independent service accounting. Demand comes from an immutable schedule; supply from raw observed
// samples (value, and a usability quality value where the service has one). Nothing a controller says
// about its own success is read. Missing supply is reported as missing, never as delivered or lost.
import { scoreMessages } from '../metrics.mjs';

const finiteNonNegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Integrals are in the canonical unit times seconds (W -> J; m3/s -> m3).
export function scoreService({ demand, supply, fromUs, toUs, quality }) {
  if (!Number.isInteger(fromUs) || !Number.isInteger(toUs) || toUs < fromUs) throw new Error('invalid_schedule');
  for (const d of demand) if (!(Number.isInteger(d.fromUs) && Number.isInteger(d.toUs) && d.toUs > d.fromUs && finiteNonNegative(d.value))) throw new Error('invalid_schedule');
  const samples = supply.map(s => ({ atUs: s.atUs, value: s.value, qualityValue: s.qualityValue })).sort((a, b) => a.atUs - b.atUs);
  for (const s of samples) {
    if (!Number.isInteger(s.atUs) || (s.value !== null && !finiteNonNegative(s.value))) throw new Error('invalid_supply');
    if (s.qualityValue !== undefined && s.qualityValue !== null && !Number.isFinite(s.qualityValue)) throw new Error('invalid_supply');
  }
  const cuts = new Set([fromUs, toUs]);
  for (const d of demand) for (const t of [d.fromUs, d.toUs]) if (t > fromUs && t < toUs) cuts.add(t);
  for (const s of samples) if (s.atUs > fromUs && s.atUs < toUs) cuts.add(s.atUs);
  const points = [...cuts].sort((a, b) => a - b);
  let demanded = 0, served = 0, missing = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], dt = (points[i + 1] - a) / 1e6;
    const rate = demand.find(d => d.fromUs <= a && a < d.toUs)?.value ?? 0;
    if (rate === 0) continue;
    demanded += rate * dt;
    const sample = samples.filter(s => s.atUs <= a).at(-1);
    const qualityKnown = !quality || (sample && sample.qualityValue !== undefined && sample.qualityValue !== null);
    if (!sample || sample.value === null || !qualityKnown) { missing += rate * dt; continue; }
    const usable = !quality || sample.qualityValue >= quality.min;
    served += Math.min(usable ? sample.value : 0, rate) * dt;
  }
  if (missing > 0) {
    return { demandIntegral: demanded, servedIntegral: served, missingIntegral: missing, deficitIntegral: null, servedBounds: [served, served + missing], score: null, status: 'capture_incomplete' };
  }
  return { demandIntegral: demanded, servedIntegral: served, missingIntegral: 0, deficitIntegral: demanded - served, servedBounds: [served, served], score: demanded > 0 ? served / demanded : null, status: 'scored' };
}

// First time after the incident that the served fraction stays at or above threshold for sustainUs;
// otherwise censored at the end of observation. Unrecovered episodes are censored, not dropped.
export function recoveryTime({ threshold, sustainUs, incidentAtUs, series, endUs }) {
  const points = [...series].filter(p => p.atUs >= incidentAtUs).sort((a, b) => a.atUs - b.atUs);
  for (let i = 0; i < points.length; i++) {
    if (points[i].fraction < threshold) continue;
    const stop = points.slice(i + 1).find(p => p.fraction < threshold)?.atUs ?? endUs;
    if (stop - points[i].atUs >= sustainUs) return { recovered: true, recoveredAtUs: points[i].atUs, durationUs: points[i].atUs - incidentAtUs };
  }
  return { recovered: false, censoredAtUs: endUs };
}

// A composite never replaces its components: both are reported so a service cannot be counted twice.
export function facilityScore({ facilityId, components, weights }) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-9 || Object.keys(weights).some(k => !(k in components))) throw new Error('weights_must_sum_to_one');
  const scores = Object.fromEntries(Object.entries(components).map(([k, v]) => [k, v.score]));
  const anyNull = Object.values(scores).some(s => s === null);
  return {
    facilityId, components,
    weightedScore: anyNull ? null : Object.entries(weights).reduce((sum, [k, w]) => sum + w * scores[k], 0),
    minimumScore: anyNull ? null : Math.min(...Object.values(scores)),
  };
}

// Communications keeps the V1 receipt scorer: unique on-time receipts over a fixed offered denominator.
export const scoreCommunications = scoreMessages;
