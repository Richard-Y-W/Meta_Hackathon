// Threat and consequence forecasts (P10). A forecast is an infra-contract-v1 `forecast` envelope bound to
// its origin observations, configuration revisions and model version, with explicit outcome semantics:
// `event` outcomes give a probability that a named threat occurs within the horizon and a predicted time
// interval; `quantity` outcomes give an interval for a measured quantity at a time. Unsupported forecasts
// say so instead of guessing. Scoring compares forecasts to independent later observations only.
import { createHash } from 'node:crypto';
import { CONTRACT, validateEnvelope } from './contracts.mjs';

const OUTCOME_KINDS = new Set(['event', 'quantity']);
const SUPPORT = new Set(['supported', 'unsupported']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createForecast({ runId, domainId, sequence = 0, forecastId, issuedAtUs, origin, configurationRevisions, modelVersion, horizonUs, outcomes, assumptions, validity, supportStatus = 'supported', unsupportedReason }) {
  if (!SUPPORT.has(supportStatus)) throw new Error('invalid_support_status');
  if (supportStatus === 'unsupported' && !unsupportedReason) throw new Error('unsupported_reason_required');
  for (const o of outcomes) {
    if (!OUTCOME_KINDS.has(o.kind)) throw new Error('invalid_outcome_kind');
    if (o.kind === 'event' && !(o.probability >= 0 && o.probability <= 1)) throw new Error('invalid_probability');
    if (o.interval && !(Array.isArray(o.interval) && o.interval.length === 2 && o.interval[0] <= o.interval[1])) throw new Error('invalid_interval');
  }
  for (const obs of origin) if (obs.observedAtUs > issuedAtUs) throw new Error('origin_after_issue'); // no evidence from the future
  const record = {
    schemaVersion: CONTRACT.schemaVersion, runId, domainId, sequence, tickUs: issuedAtUs, kind: 'forecast',
    forecastId, originObservations: origin.map(o => o.observationId), originHash: hash(origin), configurationRevisions, modelVersion, horizonUs,
    outcomes: { issuedAtUs, items: outcomes, validity: validity ?? null, ...(unsupportedReason ? { unsupportedReason } : {}) }, assumptions, supportStatus,
  };
  const v = validateEnvelope(record, { runId });
  if (!v.ok) throw new Error(`forecast_${v.code}`);
  return record;
}

// Information boundary: every origin observation must be one the controller was admitted to see, and no
// forecast field may carry an identity or time from the hidden fault schedule.
export function checkInformationBoundary(forecast, { admittedObservationIds, hiddenFaults }) {
  const admitted = new Set(admittedObservationIds);
  const leaked = forecast.originObservations.filter(id => !admitted.has(id));
  if (leaked.length) return { ok: false, code: 'information_boundary_violation', detail: { unadmittedOrigin: leaked } };
  const text = JSON.stringify({ outcomes: forecast.outcomes, assumptions: forecast.assumptions });
  const named = hiddenFaults.filter(f => text.includes(f.faultId));
  if (named.length) return { ok: false, code: 'information_boundary_violation', detail: { hiddenFaultReferenced: named.map(f => f.faultId) } };
  return { ok: true, code: 'ok' };
}

// Lead time counts only for a warning issued strictly before the service loss it warns about.
export function leadTime(forecast, { lossAtUs }) {
  const issued = forecast.outcomes.issuedAtUs;
  if (lossAtUs === null || lossAtUs === undefined) return { advanceWarning: false, reason: 'no_loss' };
  if (issued >= lossAtUs) return { advanceWarning: false, reason: 'issued_after_loss', lateByUs: issued - lossAtUs };
  return { advanceWarning: true, leadUs: lossAtUs - issued };
}

const mean = v => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

// Event forecasts: Brier score, reliability by probability bin, hits / misses / false alarms at a decision
// threshold, lead times of hits, and timing coverage of the predicted interval.
export function scoreEventForecasts(pairs, { threshold = 0.5, bins = 5 } = {}) {
  const rows = pairs.filter(p => p.forecast.supportStatus === 'supported');
  const brier = mean(rows.map(p => (p.probability - (p.occurred ? 1 : 0)) ** 2));
  const reliability = Array.from({ length: bins }, (_, b) => {
    const inBin = rows.filter(p => Math.min(bins - 1, Math.floor(p.probability * bins)) === b);
    return { bin: [b / bins, (b + 1) / bins], n: inBin.length, meanProbability: mean(inBin.map(p => p.probability)), observedFrequency: mean(inBin.map(p => (p.occurred ? 1 : 0))) };
  });
  const warned = rows.filter(p => p.probability >= threshold);
  const hits = warned.filter(p => p.occurred && p.lead.advanceWarning);
  const lateWarnings = warned.filter(p => p.occurred && !p.lead.advanceWarning);
  const falseAlarms = warned.filter(p => !p.occurred);
  const missed = rows.filter(p => p.occurred && p.probability < threshold);
  const timed = hits.filter(p => p.interval);
  return {
    forecasts: pairs.length, supported: rows.length, unsupported: pairs.length - rows.length, brier,
    reliability, hits: hits.length, lateWarnings: lateWarnings.length, falseAlarms: falseAlarms.length, missed: missed.length,
    leadUs: { min: hits.length ? Math.min(...hits.map(p => p.lead.leadUs)) : null, mean: mean(hits.map(p => p.lead.leadUs)) },
    timingCoverage: timed.length ? timed.filter(p => p.interval[0] <= p.actualAtUs && p.actualAtUs <= p.interval[1]).length / timed.length : null,
  };
}

// Quantity intervals: coverage against the nominal level, mean width, and optimistic errors (the observed
// value fell on the bad side of the interval). Usefulness requires coverage near nominal AND intervals
// narrower than the declared reference spread: a permanently wide interval does not qualify.
export function scoreIntervals(pairs, { nominal, coverageTolerance = 0.1, referenceWidth, maxWidthFraction = 0.5, badSide = 'low' }) {
  const rows = pairs.filter(p => p.interval);
  const covered = rows.filter(p => p.interval[0] <= p.actual && p.actual <= p.interval[1]);
  const optimistic = rows.filter(p => (badSide === 'low' ? p.actual < p.interval[0] : p.actual > p.interval[1]));
  const width = mean(rows.map(p => p.interval[1] - p.interval[0]));
  const coverage = rows.length ? covered.length / rows.length : null;
  const calibrated = coverage !== null && coverage >= nominal - coverageTolerance;
  const sharp = width !== null && width <= maxWidthFraction * referenceWidth;
  return { n: rows.length, coverage, nominal, meanWidth: width, referenceWidth, optimisticErrors: optimistic.length, calibrated, sharp, useful: calibrated && sharp };
}

// Consequence ensemble: one preview per declared scenario of the uncertain parameters, against the same
// admitted model. The interval is the ensemble range; each member stays visible.
export async function ensembleConsequence({ preview, plan, scenarios, metric }) {
  const members = [];
  for (const scenario of scenarios) {
    const result = await preview({ ...plan, assume: [...(plan.assume ?? []), ...(scenario.assume ?? [])] });
    if (!result.ok) return { ok: false, code: result.code, scenario: scenario.label };
    members.push({ label: scenario.label, value: metric(result) });
  }
  const values = members.map(m => m.value).filter(v => v !== null && v !== undefined);
  return { ok: true, members, interval: values.length === members.length ? [Math.min(...values), Math.max(...values)] : null };
}

// Baseline threat forecaster: least-squares trend over recent fresh samples, extrapolated to a threshold.
// The ensemble scales the fitted slope (declared members, e.g. 0.8/1.0/1.25); the probability of crossing
// within the horizon is the fraction of members that cross, and the timing interval spans their crossings.
// With too few samples, or a trend moving away from the threshold, the answer is explicit.
export function trendCrossing({ samples, threshold, direction, nowUs, horizonUs, slopeScales = [0.8, 1, 1.25], minSamples = 3 }) {
  if (samples.length < minSamples) return { status: 'insufficient_data', probability: null, interval: null };
  const t0 = samples[0].atUs;
  const xs = samples.map(s => (s.atUs - t0) / 1e6), ys = samples.map(s => s.value);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return { status: 'insufficient_data', probability: null, interval: null };
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  const latest = samples.at(-1);
  const gap = threshold - latest.value;
  const already = direction === 'down' ? latest.value <= threshold : latest.value >= threshold;
  if (already) return { status: 'crossed', probability: 1, interval: [latest.atUs, latest.atUs], slopePerS: slope };
  const toward = direction === 'down' ? slope < 0 : slope > 0;
  if (!toward) return { status: 'no_trend_toward_threshold', probability: 0, interval: null, slopePerS: slope };
  const crossings = slopeScales.map(k => latest.atUs + Math.round((gap / (slope * k)) * 1e6));
  const within = crossings.filter(t => t <= nowUs + horizonUs).length;
  return { status: 'trend', probability: within / crossings.length, interval: [Math.min(...crossings), Math.max(...crossings)], slopePerS: slope };
}
