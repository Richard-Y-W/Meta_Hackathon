// Versioned infrastructure contract (infra-contract-v1). Every record is a strict envelope with integer
// microsecond clocks and canonical-unit quantities; a missing value is null with a reason, never zero.
// Unit conversion happens only at adapter admission (admitQuantity); the kernel accepts canonical units.
import { readFileSync } from 'node:fs';

export const CONTRACT = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/contract-v1.json', import.meta.url), 'utf8'));

const ENVELOPE = ['schemaVersion', 'runId', 'domainId', 'sequence', 'tickUs', 'kind'];
const KIND_FIELDS = {
  observation: { required: ['observationId', 'assetId', 'metric', 'quantity', 'observedAtUs', 'receivedAtUs', 'quality', 'sourceId', 'configurationRevision'] },
  service: { required: ['serviceId', 'consumer', 'metric', 'demandScheduleRef', 'priorityTier', 'equationVersion'], optional: ['deadlineUs', 'qualityThreshold', 'reserveModel'] },
  capability: { required: ['capabilityId', 'actionType', 'parameters', 'assets', 'authorityModes', 'limits', 'expectedDurationUs', 'reversible', 'effectChecks'] },
  forecast: { required: ['forecastId', 'originObservations', 'originHash', 'configurationRevisions', 'modelVersion', 'horizonUs', 'outcomes', 'assumptions', 'supportStatus'] },
  plan: { required: ['planId', 'proposer', 'sourceObservations', 'sourceHash', 'expectedConfigurationRevisions', 'modelVersion', 'policyVersion', 'expiresAtUs', 'actions', 'budgets', 'forecasts', 'rationale'] },
  action: { required: ['actionId', 'capabilityId', 'parameters', 'preconditions', 'effectDeadlineUs', 'lockSet', 'authorityGrant', 'compensation'] },
  receipt: { required: ['actionId', 'requestedAtUs', 'startedAtUs', 'completedAtUs', 'actualSettings', 'observedEffects', 'status', 'reason'] },
  measurement: { required: ['measurementId', 'serviceId', 'workloadRef', 'demanded', 'supplied', 'fromUs', 'toUs', 'missingStatus', 'provenance'] },
};
const QUALITY = new Set(['good', 'stale', 'suspect', 'missing']);
const RECEIPT_STATUS = new Set(['success', 'partial', 'rejected', 'unknown']);
const AUTHORITY = new Set(['observe', 'recommend', 'approve_each', 'bounded_auto']);

class Invalid extends Error {}
const invalid = code => { throw new Invalid(code); };
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(v);

function scanFinite(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) invalid('nonfinite_number');
  if (value && typeof value === 'object') Object.values(value).forEach(scanFinite);
}

function timeUs(value, { nullable = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid('invalid_time');
  if (value < 0) invalid('negative_time');
}

export function canonicalUnit(metric) { return CONTRACT.metrics[metric] ?? null; }

function quantity(metric, q, quality) {
  const canonical = canonicalUnit(metric) ?? invalid('unknown_metric');
  if (!isPlain(q) || !('value' in q) || typeof q.unit !== 'string') invalid('invalid_quantity');
  for (const key of Object.keys(q)) if (!['value', 'unit', 'missingReason'].includes(key)) invalid('unknown_field');
  if (q.unit !== canonical) invalid(CONTRACT.conversions[`${q.unit}->${canonical}`] !== undefined ? 'unit_not_canonical' : 'unit_mismatch');
  if (q.value === null) { if (typeof q.missingReason !== 'string' || !q.missingReason) invalid('missing_reason_required'); return; }
  if (typeof q.value !== 'number') invalid('invalid_quantity');
  if (quality === 'missing') invalid(q.value === 0 ? 'missing_as_zero' : 'missing_with_value');
}

export function validateEnvelope(record, context = {}) {
  try {
    if (!isPlain(record)) invalid('invalid_record');
    if (record.schemaVersion !== CONTRACT.schemaVersion) invalid('unsupported_version');
    const spec = KIND_FIELDS[record.kind] ?? invalid('unknown_kind');
    const allowed = [...ENVELOPE, ...spec.required, ...(spec.optional ?? [])];
    for (const key of Object.keys(record)) if (!allowed.includes(key)) invalid('unknown_field');
    for (const key of [...ENVELOPE, ...spec.required]) if (!Object.hasOwn(record, key)) invalid('missing_field');
    scanFinite(record);
    if (!isId(record.runId) || !isId(record.domainId)) invalid('invalid_id');
    if (!Number.isInteger(record.sequence) || record.sequence < 0) invalid('invalid_sequence');
    timeUs(record.tickUs);
    if (context.runId && record.runId !== context.runId) invalid('cross_run_reference');
    switch (record.kind) {
      case 'observation':
        timeUs(record.observedAtUs); timeUs(record.receivedAtUs);
        if (record.receivedAtUs < record.observedAtUs) invalid('time_order');
        if (!QUALITY.has(record.quality)) invalid('invalid_quality');
        quantity(record.metric, record.quantity, record.quality);
        break;
      case 'measurement':
        timeUs(record.fromUs); timeUs(record.toUs);
        if (record.toUs < record.fromUs) invalid('time_order');
        break;
      case 'capability':
        if (!isPlain(record.parameters) || !Array.isArray(record.authorityModes) || record.authorityModes.some(m => !AUTHORITY.has(m))) invalid('invalid_capability');
        timeUs(record.expectedDurationUs);
        break;
      case 'action': {
        timeUs(record.effectDeadlineUs);
        if (context.capabilities) {
          const cap = context.capabilities.find(c => c.capabilityId === record.capabilityId) ?? invalid('unknown_capability');
          if (!isPlain(record.parameters)) invalid('invalid_parameters');
          for (const key of Object.keys(record.parameters)) if (!Object.hasOwn(cap.parameters, key)) invalid('unknown_parameter');
          for (const key of Object.keys(cap.parameters)) if (!Object.hasOwn(record.parameters, key)) invalid('missing_parameter');
        }
        break;
      }
      case 'receipt':
        timeUs(record.requestedAtUs); timeUs(record.startedAtUs, { nullable: true }); timeUs(record.completedAtUs, { nullable: true });
        if (!RECEIPT_STATUS.has(record.status)) invalid('invalid_status');
        break;
      case 'plan':
        timeUs(record.expiresAtUs);
        break;
      case 'forecast':
        timeUs(record.horizonUs);
        break;
    }
    return { ok: true, code: 'ok' };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, code: error.message };
    throw error;
  }
}

// Explicit conversion at adapter admission into the metric's canonical unit.
export function admitQuantity(metric, q) {
  const canonical = canonicalUnit(metric);
  if (!canonical) return { ok: false, code: 'unknown_metric' };
  if (!isPlain(q) || typeof q.unit !== 'string') return { ok: false, code: 'invalid_quantity' };
  if (q.value !== null && (typeof q.value !== 'number' || !Number.isFinite(q.value))) return { ok: false, code: 'nonfinite_number' };
  if (q.unit === canonical) return { ok: true, quantity: { ...q } };
  const factor = CONTRACT.conversions[`${q.unit}->${canonical}`];
  if (factor === undefined) return { ok: false, code: 'unit_mismatch' };
  const value = q.value === null ? null : Number((q.value * factor).toPrecision(12));
  return { ok: true, quantity: { ...q, value, unit: canonical } };
}

// A plan may act only on the run, evidence and configuration revisions it was built from, before expiry.
export function validatePlanBinding(plan, { runId, nowUs, configurationRevisions }) {
  if (plan.runId !== runId || plan.sourceObservations.some(o => o.runId !== runId)) return { ok: false, code: 'cross_run_reference' };
  for (const [domain, revision] of Object.entries(plan.expectedConfigurationRevisions)) {
    const current = configurationRevisions[domain];
    if (current === undefined) return { ok: false, code: 'unknown_domain' };
    if (current > revision) return { ok: false, code: 'configuration_stale' };
    if (current < revision) return { ok: false, code: 'future_revision' };
  }
  if (nowUs >= plan.expiresAtUs) return { ok: false, code: 'plan_expired' };
  return { ok: true, code: 'ok' };
}
