// Service contracts: who needs what, measured in which canonical metric, at which priority, against
// which immutable demand schedule. Measurement (P05) scores supply against these, never against plans.
import { canonicalUnit, validateEnvelope } from './contracts.mjs';

export function defineServices(records) {
  const seen = new Set();
  for (const r of records) {
    const env = validateEnvelope(r);
    if (!env.ok) return env;
    if (!canonicalUnit(r.metric)) return { ok: false, code: 'unknown_metric', serviceId: r.serviceId };
    if (!Number.isInteger(r.priorityTier) || r.priorityTier < 1) return { ok: false, code: 'invalid_priority', serviceId: r.serviceId };
    if (typeof r.demandScheduleRef !== 'string' || !r.demandScheduleRef) return { ok: false, code: 'invalid_schedule_ref', serviceId: r.serviceId };
    if (seen.has(r.serviceId)) return { ok: false, code: 'duplicate_service', serviceId: r.serviceId };
    seen.add(r.serviceId);
  }
  return { ok: true, code: 'ok', services: records.map(r => ({ ...r })) };
}
