import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInventory } from '../../src/lifeline/controllers/common.mjs';
import { createMetaController } from '../../src/lifeline/controllers/meta.mjs';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const INV = buildInventory(read('../../fixtures/lifeline/development/cascade.json'), read('../../fixtures/lifeline/policy-v1.json'));
const POLICY = read('../../fixtures/lifeline/policy-v1.json');
const IDS = INV.topology.links.map(l => l.linkId);
const flush = () => new Promise(r => setImmediate(r));

function observation({ down = [], seq = 10 } = {}) {
  return { version: 'ObservationV1', runId: 'run-1', seq, collectedAtMs: seq * 500, ageMs: 5, stale: false, configRevision: 1,
    links: Object.fromEntries(IDS.map(id => [id, { state: down.includes(id) ? 'down' : 'up' }])), services: {} };
}
const reference = () => Object.fromEntries(INV.essential.map(f => [f.flowId, { version: 0, path: INV.reference[f.flowId].primary, ackPath: INV.reference[f.flowId].ackPrimary }]));
const scheduled = () => Object.fromEntries(INV.background.map(s => [s.sourceId, s.scheduledBps]));
const rates = (onTime = {}) => ({ links: {}, services: Object.fromEntries(INV.essential.map(f => [f.flowId, { recentOnTimeFraction: onTime[f.flowId] ?? 1, retransmissionRatio: 1 }])) });
const state = (o = {}) => ({ observation: observation(o.obs), rates: o.rates ?? rates(), routes: reference(), backgroundRates: scheduled(), nowMs: o.nowMs ?? 30_000, remaining: { interventionBundles: 12, incidentProbeBytes: 262_144, modelCalls: o.modelCalls ?? 12 } });

function decision(evidence, action) {
  return JSON.stringify({
    hypotheses: [{ id: 'h1', statement: 'r1-r2 drops packets silently', evidence, wouldContradict: 'clean probe on r1-r2-r3' }],
    selected: 'h1', actions: [action], expected: [{ flowId: 'field-clinic', onTimeFraction: [0.9, 1] }], beliefUpdates: [], stop: false,
  });
}
const probe = { type: 'probe_path', sourceId: 'field', destinationId: 'clinic', path: ['r1', 'r4', 'r3'], packetCount: 16, payloadBytes: 1000, intervalMs: 10 };

function controller(responses, o = {}) {
  const calls = [];
  let charged = 0;
  const c = createMetaController(INV, POLICY, {
    callModel: async ({ prompt }) => { calls.push(prompt); const r = responses.shift(); return typeof r === 'function' ? r(prompt) : r; },
    chargeModelCall: () => { charged++; },
    ...o,
  });
  return { c, calls, charged: () => charged };
}
const ok = text => ({ code: 'ok', text, responseId: `resp-${Math.random()}`, durationMs: 6000, usage: { output_tokens: 1400 } });
const degradedState = nowMs => state({ rates: rates({ 'field-clinic': 0.7 }), nowMs });
const evidenceFrom = prompt => [...new Set(prompt.match(/obs-\d+/g))].slice(-2);

async function persist(c, until = 6) {
  let intent = null;
  for (let i = 0; i < until && !intent; i++) { intent = c.decide(degradedState(30_000 + i * 500)); await flush(); }
  return intent;
}

test('an outage is handled by the deterministic layer immediately while the model investigates in parallel', async () => {
  const { c, calls } = controller([ok(decision(['obs-10'], { type: 'retain_policy', reasonCode: 'recovered' }))]);
  const intent = c.decide(state({ obs: { down: ['r0-r3', 'r1-r2'] } }));
  assert.equal(intent.source, 'deterministic');
  assert.equal(intent.actions[0].type, 'set_route');
  await flush();
  assert.equal(calls.length, 1);
});

test('unexplained degradation is investigated by the model, whose cited evidence and typed probe become the intent', async () => {
  const { c, calls, charged } = controller([prompt => ok(decision(evidenceFrom(prompt), probe))]);
  let intent = await persist(c);
  if (!intent) { await flush(); intent = c.decide(degradedState(33_500)); }
  assert.equal(calls.length, 1);
  assert.equal(charged(), 1);
  assert.equal(intent.source, 'meta');
  assert.equal(intent.actions[0].type, 'probe_path');
  assert.deepEqual(intent.actions[0].path, ['r1', 'r4', 'r3']);
  assert.equal(intent.modelTrace.selected, 'h1');
  assert.match(intent.modelTrace.responseId, /^resp-/);
  assert.ok(!calls[0].includes('link_loss') && !calls[0].includes('counter_loss') && !calls[0].includes('bwMbit'), 'no fault truth in the prompt');
});

test('an invalid response is retried once; a second failure hands the role to the deterministic rule visibly', async () => {
  const { c, calls } = controller([ok('{"hypotheses":'), ok(decision(['obs-999'], probe))]);
  await persist(c);
  await flush(); await flush();
  c.decide(degradedState(34_000)); await flush();
  assert.equal(calls.length, 2);
  const events = c.drainEvents();
  assert.ok(events.some(e => e.type === 'model_rejected' && e.detail === 'invalid_json'));
  assert.ok(events.some(e => e.type === 'model_rejected' && e.detail === 'evidence_unknown'));
  assert.ok(events.some(e => e.type === 'mode' && e.mode === 'degraded'));
  let intent = null;
  for (let i = 0; i < 8 && !intent; i++) { intent = c.decide(degradedState(35_000 + i * 500)); await flush(); }
  assert.equal(intent.source, 'deterministic');
  assert.equal(intent.actions[0].type, 'probe_path'); // the adaptive unexplained-degradation rule, now active
});

test('a timeout or unavailable provider degrades without blocking; nothing is invented', async () => {
  const { c } = controller([{ code: 'provider_timeout', durationMs: 12000 }, { code: 'provider_unavailable', httpStatus: 503 }]);
  await persist(c);
  await flush(); await flush(); c.decide(degradedState(34_000)); await flush();
  const events = c.drainEvents();
  assert.ok(events.some(e => e.type === 'provider_call' && e.code === 'provider_timeout'));
  assert.ok(events.some(e => e.type === 'mode' && e.mode === 'degraded'));
});

test('no model call is made without remaining model-call budget', async () => {
  const { c, calls } = controller([ok(decision(['obs-10'], probe))]);
  for (let i = 0; i < 6; i++) { c.decide({ ...degradedState(30_000 + i * 500), remaining: { interventionBundles: 12, incidentProbeBytes: 262_144, modelCalls: 0 } }); await flush(); }
  assert.equal(calls.length, 0);
  assert.ok(c.drainEvents().some(e => e.type === 'mode' && e.mode === 'degraded' && e.reason === 'model_budget_exhausted'));
});

test('a belief update without supporting measurement rejects the whole decision', async () => {
  const withUpdate = prompt => ok(JSON.stringify({ ...JSON.parse(decision(evidenceFrom(prompt), probe)), beliefUpdates: [{ link: 'r1>r2', hiBps: 1_000_000, evidence: evidenceFrom(prompt) }] }));
  const { c } = controller([withUpdate, withUpdate]);
  await persist(c);
  await flush(); await flush(); c.decide(degradedState(34_000)); await flush();
  assert.ok(c.drainEvents().some(e => e.type === 'model_rejected' && e.detail === 'evidence_unsupported'));
});

test('only one model call is outstanding at a time', async () => {
  let release;
  const pending = new Promise(r => { release = r; });
  const { c, calls } = controller([() => pending]);
  for (let i = 0; i < 10; i++) { c.decide(degradedState(30_000 + i * 500)); await flush(); }
  assert.equal(calls.length, 1);
  release(ok(decision(['obs-60'], { type: 'retain_policy', reasonCode: 'wait' })));
});

test('stop with retain_policy is recorded as a model decision without spending intervention budget', async () => {
  const { c } = controller([prompt => ok(JSON.stringify({ ...JSON.parse(decision(evidenceFrom(prompt), { type: 'retain_policy', reasonCode: 'transient' })), stop: true }))]);
  let intent = await persist(c);
  for (let i = 0; i < 3; i++) { await flush(); intent = intent ?? c.decide(degradedState(33_500 + i * 500)); }
  assert.equal(intent, null);
  const recorded = c.drainEvents().find(e => e.type === 'model_decision');
  assert.equal(recorded.stop, true);
  assert.equal(recorded.selected, 'h1');
  assert.match(recorded.responseId, /^resp-/);
});

test('a persisting outage with no degraded flow is investigated once, not every interval', async () => {
  const { c, calls } = controller([ok(decision(['obs-10'], { type: 'retain_policy', reasonCode: 'handled' })), ok(decision(['obs-10'], { type: 'retain_policy', reasonCode: 'handled' }))]);
  for (let i = 0; i < 80; i++) { c.decide(state({ obs: { down: ['r0-r3'], seq: 10 + i }, nowMs: 30_000 + i * 500 })); await flush(); }
  assert.equal(calls.length, 1);
});

test('progress bound: repeating an equivalent probe is refused and hands control to the deterministic layer', async () => {
  const again = prompt => ok(decision(evidenceFrom(prompt), probe));
  const { c } = controller([again, again, again]);
  let intent = await persist(c);
  for (let i = 0; i < 4 && !intent; i++) { await flush(); intent = c.decide(degradedState(33_500 + i * 500)); }
  assert.equal(intent.source, 'meta');
  c.applied(intent, { status: 'confirmed', nowMs: 35_000, receipts: [{ type: 'probe_path', status: 'confirmed', measurement: { lossFraction: 0, path: probe.path } }] });
  for (let i = 0; i < 40; i++) { const r = c.decide(degradedState(36_000 + i * 500)); await flush(); if (r?.source === 'meta') assert.fail('equivalent probe repeated'); }
  const events = c.drainEvents();
  assert.ok(events.some(e => e.type === 'model_rejected' && e.detail === 'progress_limit'));
});
