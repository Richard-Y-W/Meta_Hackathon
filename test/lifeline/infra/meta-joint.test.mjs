// P14: what a model answer must satisfy before it can reach the planner, and the investigation deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, investigationDeadline, parseJointDecision } from '../../../src/lifeline/controllers/meta-joint.mjs';

const S = 1_000_000;
const ctx = { evidenceIds: new Set(['obs:water:lv-T1', 'adv:eta-nominal', 'state:gen-portable']), templateIds: new Set(['retain-policy', 'close-sw-S2']), sensorIds: new Set(['water:lv-T1']), gridUs: 60 * S };
const good = () => ({
  hypotheses: [{ id: 'h1', statement: 'Station on battery after feeder loss', evidence: ['obs:water:lv-T1'], falsifier: 'station mains alarm returns' },
    { id: 'h2', statement: 'Level sensor stale', evidence: ['obs:water:lv-T1'], falsifier: 'fresh reading changes' }],
  selected: 'h1', observe: { sensorId: 'water:lv-T1', why: 'confirm drain rate' },
  assumptions: [{ id: 'a1', type: 'line_restore', assetId: 'line-3-8', inS: 9000, evidence: ['adv:eta-nominal'] }],
  plan: { steps: [{ domain: 'power', action: { type: 'set_switch', params: { switchId: 'sw-S2', closed: true } }, inS: 0 }] },
  expected: [{ metric: 'water_essential_unmet', value: [0, 1], unit: 'm3' }],
  parameters: [{ key: 'tank.netDraw', value: 0.018, unit: 'm3/s', evidence: ['obs:water:lv-T1'] }, { key: 'repair.eta', value: null, unit: 's', evidence: ['adv:eta-nominal'] }],
  validForS: 1800,
});
const parse = (o, c = ctx) => parseJointDecision(JSON.stringify(o), c);

test('a well-formed answer parses, including an unknown value read as null', () => {
  const r = parse(good());
  assert.equal(r.ok, true);
  assert.equal(r.decision.parameters[1].value, null);
  assert.equal(parse({ ...good(), plan: { templateId: 'close-sw-S2' } }).ok, true);
});

test('long citation lists parse up to the limit and are named precisely beyond it (P14 run 2 regression)', () => {
  const o = good(); o.hypotheses[0].evidence = Array(20).fill('obs:water:lv-T1');
  assert.equal(parse(o).ok, true);
  o.hypotheses[0].evidence = Array(25).fill('obs:water:lv-T1');
  assert.equal(parse(o).detail, 'too_many_citations');
});

test('RED: invalid evidence IDs cannot reach execution', () => {
  const o = good(); o.hypotheses[0].evidence = ['obs:water:lv-T9'];
  assert.equal(parse(o).detail, 'evidence_unknown');
  const p = good(); p.assumptions[0].evidence = ['made-up'];
  assert.equal(parse(p).detail, 'evidence_unknown');
});

test('RED: unsupported actions and assets cannot reach execution', () => {
  const cases = [
    { domain: 'power', action: { type: 'shed_hospital', params: {} }, inS: 0 },
    { domain: 'power', action: { type: 'set_switch', params: { switchId: 'sw-S9', closed: true } }, inS: 0 },
    { domain: 'water', action: { type: 'set_switch', params: { switchId: 'sw-S2', closed: true } }, inS: 0 },
    { domain: 'water', action: { type: 'set_pump', params: { pumpId: 'PU1', on: true, speed: 0.7 } }, inS: 0 },
  ];
  for (const step of cases) assert.equal(parse({ ...good(), plan: { steps: [step] } }).ok, false, JSON.stringify(step));
  assert.equal(parse({ ...good(), plan: { templateId: 'invented' } }).detail, 'template_unknown');
});

test('unknown expectations may be null, as instructed (P14 run 2 regression)', () => {
  assert.equal(parse({ ...good(), expected: [{ metric: 'water_essential_unmet', value: null, unit: 'm3' }, { metric: 'power_essential_unserved', value: [0, null], unit: 'J' }] }).ok, true);
  assert.equal(parse({ ...good(), expected: [{ metric: 'water_essential_unmet', value: [5, 1], unit: 'm3' }] }).detail, 'invalid_units');
});

test('RED: invented units cannot reach execution', () => {
  assert.equal(parse({ ...good(), parameters: [{ key: 'fuel', value: 120, unit: 'MJ', evidence: ['obs:water:lv-T1'] }] }).detail, 'invalid_units'); // non-canonical
  assert.equal(parse({ ...good(), expected: [{ metric: 'water_essential_unmet', value: [0, 1], unit: 'gallons' }] }).detail, 'invalid_units');
  assert.equal(parse({ ...good(), parameters: [{ key: 'x', value: 1, unit: 'furlongs', evidence: ['obs:water:lv-T1'] }] }).detail, 'invalid_units');
  assert.equal(parse({ ...good(), plan: { steps: [{ ...good().plan.steps[0], inS: 90 }] } }).detail, 'invalid_units');
});

test('RED: hidden-state fields cannot reach execution', () => {
  assert.equal(parse({ ...good(), faultId: 'storm-3-8' }).detail, 'hidden_state');
  const o = good(); o.assumptions[0].groundTruth = true;
  assert.equal(parse(o).detail, 'hidden_state');
});

test('the investigation deadline is the remaining opportunity, in wall time through the clock', () => {
  const d = investigationDeadline({ nowUs: 1860 * S, firstLossUs: 5940 * S, actuationUs: 600 * S, marginUs: 300 * S, acceleration: 60, providerCapS: 18 });
  assert.equal(d.simUs, (5940 - 1860 - 600 - 300) * S);
  assert.equal(d.wallS, 18); // 3180 s / 60 = 53 s, capped by the provider limit
  const late = investigationDeadline({ nowUs: 5000 * S, firstLossUs: 5940 * S, actuationUs: 600 * S, marginUs: 300 * S, acceleration: 60, providerCapS: 18 });
  assert.ok(Math.abs(late.wallS - 40 / 60) < 1e-9); // 40 simulated seconds left: no time for a model call
  assert.match(late.basis, /loss 5940s - now 5000s/);
  assert.equal(investigationDeadline({ nowUs: 0, firstLossUs: null, actuationUs: 0, marginUs: 0, acceleration: 60, providerCapS: 18 }).wallS, 18);
  const ongoing = investigationDeadline({ nowUs: 2100 * S, firstLossUs: 1800 * S, actuationUs: 600 * S, marginUs: 300 * S, acceleration: 60, providerCapS: 18 });
  assert.deepEqual([ongoing.mitigation, ongoing.wallS], [true, 18]);
});

test('the prompt carries only admitted evidence and the catalog', () => {
  const obs = { atUs: 1860 * S, routers: { 'rt-pump': 'up' }, readings: [{ sensorId: 'water:lv-T1', metric: 'water.level', assetId: 'T1', value: 4.12, unit: 'm', observedAtUs: 1860 * S }, { sensorId: 'water:pr-JH', metric: 'water.pressure', assetId: 'JH', value: null, unit: 'Pa', observedAtUs: 0 }] };
  const p = buildPrompt({ nowUs: 1860 * S, obs, state: { stationMode: 'auto', resources: { 'gen-portable': { allocatedTo: null, fuelJ: 120e6 } } }, advisory: null,
    candidates: [{ planId: 'retain-policy', steps: [] }], deadline: { simUs: 3180 * S, wallS: 18 } });
  assert.ok(p.evidenceIds.has('obs:water:lv-T1') && !p.evidenceIds.has('obs:water:pr-JH'));
  assert.doesNotMatch(p.text, /storm|faultId|line_trip line-3-8 at/);
  assert.match(p.text, /allocate_generator: resourceId in \["gen-portable"\]/);
});
