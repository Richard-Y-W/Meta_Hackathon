import test from 'node:test';
import assert from 'node:assert/strict';
import { createForecast, checkInformationBoundary, leadTime, scoreEventForecasts, scoreIntervals, ensembleConsequence } from '../../../src/lifeline/kernel/forecast.mjs';
import { validateEnvelope } from '../../../src/lifeline/kernel/contracts.mjs';

const S = 1_000_000;
const origin = [{ observationId: 'obs-1', observedAtUs: 100 * S, value: 3.2 }, { observationId: 'obs-2', observedAtUs: 160 * S, value: 3.0 }];
const base = (o = {}) => createForecast({
  runId: 'run-f', domainId: 'water', forecastId: 'fc-1', issuedAtUs: 160 * S, origin, configurationRevisions: { water: 2 }, modelVersion: 'trend-v1',
  horizonUs: 3600 * S, outcomes: [{ kind: 'event', threat: 'tank_depletion', assetId: 'T1', probability: 0.8, interval: [1300 * S, 1500 * S] }],
  assumptions: ['net draw constant over the horizon'], validity: { levelM: [0.5, 5] }, ...o,
});

test('a forecast is a valid envelope bound to its origin, revisions and model', () => {
  const f = base();
  assert.equal(validateEnvelope(f, { runId: 'run-f' }).ok, true);
  assert.deepEqual(f.originObservations, ['obs-1', 'obs-2']);
  assert.equal(f.outcomes.issuedAtUs, 160 * S);
  assert.match(f.originHash, /^[0-9a-f]{64}$/);
});

test('a forecast cannot cite evidence observed after it was issued', () => {
  assert.throws(() => base({ issuedAtUs: 150 * S }), /origin_after_issue/);
});

test('an unsupported forecast must say why and carries no probability claim', () => {
  assert.throws(() => base({ supportStatus: 'unsupported' }), /unsupported_reason_required/);
  const f = base({ supportStatus: 'unsupported', unsupportedReason: 'remote control unavailable: effect of the action cannot be predicted', outcomes: [] });
  assert.equal(f.supportStatus, 'unsupported');
  const score = scoreEventForecasts([{ forecast: f, probability: 0, occurred: true, lead: { advanceWarning: false } }]);
  assert.equal(score.unsupported, 1);
  assert.equal(score.supported, 0);
  assert.equal(score.missed, 0);
});

test('RED: a forecast issued at or after the service loss is not an advance warning', () => {
  const f = base();
  assert.deepEqual(leadTime(f, { lossAtUs: 1400 * S }), { advanceWarning: true, leadUs: 1240 * S });
  assert.equal(leadTime(f, { lossAtUs: 160 * S }).advanceWarning, false);
  const late = leadTime(f, { lossAtUs: 120 * S });
  assert.equal(late.advanceWarning, false);
  assert.equal(late.reason, 'issued_after_loss');
});

test('RED: a forecast built from hidden future fault data fails the information boundary', () => {
  const hiddenFaults = [{ faultId: 'pump-out', atUs: 1800 * S }];
  assert.equal(checkInformationBoundary(base(), { admittedObservationIds: ['obs-1', 'obs-2'], hiddenFaults }).ok, true);
  const peeked = base({ assumptions: ['pump-out happens at 1800 s'] });
  assert.equal(checkInformationBoundary(peeked, { admittedObservationIds: ['obs-1', 'obs-2'], hiddenFaults }).code, 'information_boundary_violation');
  assert.equal(checkInformationBoundary(base(), { admittedObservationIds: ['obs-1'], hiddenFaults }).code, 'information_boundary_violation');
});

test('event scoring counts hits, late warnings, false alarms and misses separately', () => {
  const f = base();
  const pairs = [
    { forecast: f, probability: 0.9, occurred: true, lead: { advanceWarning: true, leadUs: 600 * S }, interval: [1000 * S, 1200 * S], actualAtUs: 1100 * S },
    { forecast: f, probability: 0.8, occurred: true, lead: { advanceWarning: false, reason: 'issued_after_loss' } },
    { forecast: f, probability: 0.7, occurred: false, lead: { advanceWarning: false, reason: 'no_loss' } },
    { forecast: f, probability: 0.1, occurred: true, lead: { advanceWarning: true, leadUs: 50 * S } },
    { forecast: f, probability: 0.05, occurred: false, lead: { advanceWarning: false } },
  ];
  const s = scoreEventForecasts(pairs);
  assert.deepEqual([s.hits, s.lateWarnings, s.falseAlarms, s.missed], [1, 1, 1, 1]);
  assert.equal(s.leadUs.min, 600 * S);
  assert.equal(s.timingCoverage, 1);
  assert.ok(Math.abs(s.brier - (0.01 + 0.04 + 0.49 + 0.81 + 0.0025) / 5) < 1e-12);
});

test('a permanently wide interval is calibrated but not useful', () => {
  const actuals = [10, 12, 9, 11, 13, 8];
  const wide = actuals.map(a => ({ interval: [0, 100], actual: a }));
  const tight = actuals.map(a => ({ interval: [a - 1, a + 1], actual: a }));
  const optimistic = actuals.map(a => ({ interval: [a + 1, a + 3], actual: a }));
  const ref = { nominal: 0.9, referenceWidth: 10 };
  assert.deepEqual([scoreIntervals(wide, ref).calibrated, scoreIntervals(wide, ref).useful], [true, false]);
  assert.equal(scoreIntervals(tight, ref).useful, true);
  const o = scoreIntervals(optimistic, ref);
  assert.equal(o.optimisticErrors, 6);
  assert.equal(o.calibrated, false);
});

test('a consequence ensemble keeps every member and reports the range', async () => {
  const preview = async plan => ({ ok: true, unmet: plan.assume.length * 2 });
  const r = await ensembleConsequence({ preview, plan: { actions: [] }, metric: x => x.unmet,
    scenarios: [{ label: 'nominal', assume: [] }, { label: 'surge', assume: [{}] }, { label: 'surge+leak', assume: [{}, {}] }] });
  assert.deepEqual(r.interval, [0, 4]);
  assert.equal(r.members.length, 3);
});

test('trend crossing: a tank draining 0.01 m/s from 3 m crosses 0.5 m in 250 s; ensemble gives the interval', async () => {
  const { trendCrossing } = await import('../../../src/lifeline/kernel/forecast.mjs');
  const samples = [0, 60, 120].map(t => ({ atUs: t * S, value: 3 - 0.01 * t }));
  const r = trendCrossing({ samples, threshold: 0.5, direction: 'down', nowUs: 120 * S, horizonUs: 3600 * S });
  assert.equal(r.status, 'trend');
  assert.equal(r.probability, 1);
  assert.deepEqual(r.interval, [Math.round((120 + 130 / 1.25) * S), Math.round((120 + 130 / 0.8) * S)]);
  assert.equal(trendCrossing({ samples, threshold: 0.5, direction: 'down', nowUs: 120 * S, horizonUs: 120 * S }).probability, 1 / 3); // only the 1.25x member crosses by 240 s
  assert.equal(trendCrossing({ samples: samples.map(s => ({ ...s, value: 6 - s.value })), threshold: 0.5, direction: 'down', nowUs: 120 * S, horizonUs: 3600 * S }).status, 'no_trend_toward_threshold');
  assert.equal(trendCrossing({ samples: samples.slice(0, 2), threshold: 0.5, direction: 'down', nowUs: 0, horizonUs: 1 }).status, 'insufficient_data');
});
