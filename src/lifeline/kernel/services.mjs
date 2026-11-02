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

// Dependency catalog (P11): every coupling edge declares mechanism, units, delay, uncertainty, evidence and
// fallback, so a cascade can be traced to equations rather than to an incident label.
const EDGE_KINDS = { physical_supply: ['mechanism', 'units', 'uncertainty', 'evidence', 'fallback'], physical_load: ['mechanism', 'units', 'efficiency', 'uncertainty', 'evidence', 'fallback'],
  control_path: ['mechanism', 'units', 'latencyUs', 'uncertainty', 'evidence', 'fallback'], shared_resource: ['mechanism', 'units', 'capacity', 'uncertainty', 'evidence', 'fallback'],
  common_hazard: ['mechanism', 'uncertainty', 'evidence'] };
const DOMAINS = new Set(['power', 'water', 'communications', 'transport', 'facility']);
const EDGE_UNITS = new Set(['state', 'W', 'J', 'm3', 'm3/s', 'us']);

export function defineDependencies(catalog) {
  const seen = new Set();
  for (const e of catalog.edges ?? []) {
    const fail = code => ({ ok: false, code, edgeId: e.id });
    if (typeof e.id !== 'string' || !e.id) return fail('invalid_edge_id');
    if (seen.has(e.id)) return fail('duplicate_edge');
    seen.add(e.id);
    const required = EDGE_KINDS[e.kind];
    if (!required) return fail('unknown_edge_kind');
    for (const key of required) if (!(key in e)) return fail(`missing_${key}`);
    for (const end of ['source', 'destination']) if (!e[end] || !DOMAINS.has(e[end].domain) || !e[end].asset) return fail(`invalid_${end}`);
    if (e.kind !== 'common_hazard' && e.source.domain === e.destination.domain) return fail('not_cross_domain');
    if ('units' in e && !EDGE_UNITS.has(e.units)) return fail('unit_not_canonical');
    if (e.kind === 'physical_load' && !(e.efficiency > 0 && e.efficiency <= 1)) return fail('invalid_efficiency');
    if (!Array.isArray(e.evidence) || !e.evidence.length) return fail('missing_evidence');
  }
  return { ok: true, code: 'ok', edges: catalog.edges.length };
}

// A facility's services stay separate components (e.g. hospital power and hospital water); a composite
// score is reported beside them, never instead of them (see measurement.facilityScore).
export function facilities(services) {
  const byConsumer = new Map();
  for (const s of services) byConsumer.set(s.consumer, [...(byConsumer.get(s.consumer) ?? []), s.serviceId]);
  return Object.fromEntries([...byConsumer].map(([consumer, ids]) => [consumer, ids.sort()]));
}
