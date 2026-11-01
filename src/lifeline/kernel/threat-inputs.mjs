// External threat inputs (P10): alarms, maintenance records, operator reports and hazard forecasts enter
// only through provenance and age checks. An input never carries the identity or schedule of an injected
// fault; contradictory reports are kept side by side and marked, never silently resolved.
const TYPES = {
  alarm: ['assetId', 'condition'],
  maintenance: ['assetId', 'window', 'effect'],
  operator_report: ['assetId', 'condition', 'reporter'],
  hazard_forecast: ['hazard', 'area', 'window', 'probability'],
};
const FORBIDDEN_FIELDS = ['faultId', 'faultSchedule', 'injected', 'groundTruth'];
const CONDITIONS = new Set(['failed', 'degraded', 'operational', 'at_risk']);

export function admitThreatInput(input, { nowUs, sources, knownAssets, maxAgeUs, hiddenFaults = [] }) {
  const reject = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });
  if (!input || typeof input !== 'object') return reject('invalid_input');
  const required = TYPES[input.type];
  if (!required) return reject('unknown_input_type', input.type);
  const source = sources[input.sourceId];
  if (!source) return reject('unknown_source', input.sourceId);
  if (!source.types.includes(input.type)) return reject('source_not_authorized_for_type', `${input.sourceId}:${input.type}`);
  if (!Number.isInteger(input.issuedAtUs) || input.issuedAtUs < 0) return reject('invalid_time');
  if (input.issuedAtUs > nowUs) return reject('issued_in_future');
  const limit = maxAgeUs[input.type];
  if (limit !== undefined && nowUs - input.issuedAtUs > limit) return reject('stale_input', `${nowUs - input.issuedAtUs} us old`);
  for (const key of required) if (!(key in input)) return reject('missing_field', key);
  for (const key of FORBIDDEN_FIELDS) if (key in input) return reject('information_boundary_violation', `field ${key}`);
  const text = JSON.stringify(input);
  const named = hiddenFaults.filter(f => text.includes(f.faultId));
  if (named.length) return reject('information_boundary_violation', `references ${named.map(f => f.faultId).join(',')}`);
  if ('assetId' in input && !knownAssets.includes(input.assetId)) return reject('unknown_asset', input.assetId);
  if ('condition' in input && !CONDITIONS.has(input.condition)) return reject('invalid_condition', input.condition);
  if ('probability' in input && !(input.probability >= 0 && input.probability <= 1)) return reject('invalid_probability');
  if ('window' in input && !(Array.isArray(input.window) && input.window[0] <= input.window[1])) return reject('invalid_window');
  return { ok: true, input: { ...input, provenance: { sourceId: input.sourceId, sourceKind: source.kind, admittedAtUs: nowUs, ageUs: nowUs - input.issuedAtUs } } };
}

// Reports about the same asset whose conditions conflict (one says it works, another that it failed or is
// degraded) within the reconciliation window are grouped as contradictory. Agreement keeps the latest.
export function reconcile(admitted, { windowUs }) {
  const byAsset = new Map();
  for (const r of admitted.filter(r => 'assetId' in r && 'condition' in r)) {
    if (!byAsset.has(r.assetId)) byAsset.set(r.assetId, []);
    byAsset.get(r.assetId).push(r);
  }
  const out = [];
  for (const [assetId, reports] of byAsset) {
    reports.sort((a, b) => a.issuedAtUs - b.issuedAtUs);
    const latest = reports.at(-1);
    const recent = reports.filter(r => latest.issuedAtUs - r.issuedAtUs <= windowUs);
    const healthy = recent.filter(r => r.condition === 'operational');
    const unhealthy = recent.filter(r => r.condition !== 'operational');
    out.push(healthy.length && unhealthy.length
      ? { assetId, status: 'contradictory', reports: recent.map(r => ({ sourceId: r.sourceId, condition: r.condition, issuedAtUs: r.issuedAtUs })) }
      : { assetId, status: 'consistent', condition: latest.condition, reports: recent.length });
  }
  return out;
}
