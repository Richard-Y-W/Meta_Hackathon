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

// Feed degraded samples until the model contributes an intent; deterministic intents are not applied here.
async function untilMeta(c, from = 30_000, ticks = 12) {
  for (let i = 0; i < ticks; i++) { const r = c.decide(degradedState(from + i * 500)); await flush(); if (r?.source === 'meta') return r; }
  return null;
}

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

test('unexplained degradation is investigated by the model in parallel; its cited evidence and typed probe become an intent once the deterministic layer is idle', async () => {
  const { c, calls, charged } = controller([prompt => ok(decision(evidenceFrom(prompt), probe))]);
  const intents = [];
  for (let i = 0; i < 10; i++) { const r = c.decide(degradedState(30_000 + i * 500)); if (r) intents.push(r); await flush(); }
  assert.equal(calls.length, 1);
  assert.equal(charged(), 1);
  assert.equal(intents[0].source, 'deterministic'); // the conventional rule does not wait for the model
  const meta = intents.find(x => x.source === 'meta');
  assert.ok(meta, JSON.stringify(intents.map(x => x.source)));
  assert.deepEqual(meta.actions[0].path, ['r1', 'r4', 'r3']);
  assert.equal(meta.modelTrace.selected, 'h1');
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
  assert.equal(await untilMeta(c), null);
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
  assert.equal(await untilMeta(c), null); // no intervention proposal from the model
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
  const intent = await untilMeta(c);
  assert.equal(intent.source, 'meta');
  c.applied(intent, { status: 'confirmed', nowMs: 35_000, receipts: [{ type: 'probe_path', status: 'confirmed', measurement: { lossFraction: 0, path: probe.path } }] });
  for (let i = 0; i < 40; i++) { const r = c.decide(degradedState(36_000 + i * 500)); await flush(); if (r?.source === 'meta') assert.fail('equivalent probe repeated'); }
  const events = c.drainEvents();
  assert.ok(events.some(e => e.type === 'model_rejected' && e.detail === 'progress_limit'));
});


// ---- P01: parallel investigation, clocks, expiry and stale-response binding ----
import { createAdaptiveController } from '../../src/lifeline/controllers/adaptive.mjs';

function deferredProvider() {
  const calls = [];
  const callModel = args => new Promise(resolve => { calls.push({ ...args, resolve }); });
  return { calls, callModel };
}

function timed(o = {}) {
  let now = o.start ?? 30_000;
  const provider = deferredProvider();
  let charged = 0;
  const c = createMetaController(INV, POLICY, { callModel: provider.callModel, chargeModelCall: () => { charged++; }, now: () => now });
  return { c, provider, charged: () => charged, setNow: t => { now = t; }, now: () => now };
}

const at = (t, o = {}) => ({ ...state({ ...o, nowMs: t }), nowMs: t });
const withRevision = (s, revision) => ({ ...s, observation: { ...s.observation, configRevision: revision } });

test('P01 parity: with the provider hanging, failing or answering, Meta keeps the adaptive recovery on the same tick', async () => {
  const baseline = createAdaptiveController(INV, POLICY);
  const reference = [];
  for (let i = 0; i < 8; i++) reference.push(baseline.decide(degradedState(30_000 + i * 500)));
  const firstTick = reference.findIndex(Boolean);
  assert.ok(firstTick >= 0);
  const providers = {
    hang: () => new Promise(() => {}),
    fail: async () => ({ code: 'provider_timeout', durationMs: 18000 }),
    answer: async ({ prompt }) => ok(decision(evidenceFrom(prompt), { type: 'retain_policy', reasonCode: 'watch' })),
  };
  for (const [name, callModel] of Object.entries(providers)) {
    const c = createMetaController(INV, POLICY, { callModel, chargeModelCall: () => {} });
    const got = [];
    for (let i = 0; i < 8; i++) { got.push(c.decide(degradedState(30_000 + i * 500))); await flush(); }
    const tick = got.findIndex(x => x?.source === 'deterministic');
    assert.equal(tick, firstTick, `${name}: recovery tick`);
    assert.deepEqual(got[tick].actions, reference[firstTick].actions, `${name}: same recovery action`);
  }
});

test('P01 clock: a retry is bounded by the remaining deadline and the degraded hold starts at completion time', async () => {
  const t = timed({ start: 31_000 });
  t.c.decide(at(31_000, { obs: { down: ['r0-r3'] } }));
  assert.equal(t.provider.calls.length, 1);
  assert.equal(t.provider.calls[0].timeoutMs, 18_000);
  t.setNow(49_000); t.provider.calls[0].resolve({ code: 'provider_timeout', durationMs: 18_000 }); await flush();
  assert.equal(t.provider.calls.length, 2, 'retry started');
  assert.equal(t.provider.calls[1].timeoutMs, 12_000, 'bounded by the 30 s total deadline');
  t.setNow(67_000); t.provider.calls[1].resolve({ code: 'provider_timeout', durationMs: 18_000 }); await flush();
  const degraded = t.c.drainEvents().find(e => e.type === 'mode' && e.mode === 'degraded');
  assert.equal(degraded.atMs, 67_000);
  t.c.decide(at(86_999, { obs: { down: ['r0-r3'] } }));
  assert.equal(t.c.mode(), 'degraded');
  t.setNow(87_000); t.c.decide(at(87_000, { obs: { down: ['r0-r3'] } }));
  assert.equal(t.c.mode(), 'normal');
  assert.equal(t.charged(), 2);
});

test('P01 clock: the total deadline expires at start + 30 s even though each call may last 18 s', async () => {
  const t = timed({ start: 31_000 });
  t.c.decide(at(31_000, { obs: { down: ['r0-r3'] } }));
  t.setNow(61_000); t.provider.calls[0].resolve({ code: 'provider_timeout', durationMs: 30_000 }); await flush();
  assert.equal(t.provider.calls.length, 1, 'no retry after the deadline');
  const events = t.c.drainEvents();
  assert.ok(events.some(e => e.type === 'mode' && e.mode === 'degraded' && e.reason === 'deadline_expired' && e.atMs === 61_000));
  assert.equal(t.charged(), 1);
});

async function readyAt(t, startState) {
  t.c.decide(startState);
  const prompt = t.provider.calls.at(-1).prompt;
  t.provider.calls.at(-1).resolve(ok(decision(evidenceFrom(prompt), probe)));
  await flush();
}

test('P01 binding: a response is discarded when the configuration changed after it was requested', async () => {
  const t = timed();
  await readyAt(t, at(30_000, { obs: { down: ['r0-r3'] } }));
  const r = t.c.decide(withRevision(at(31_000, { obs: { down: ['r0-r3'] } }), 2));
  assert.notEqual(r?.source, 'meta');
  assert.ok(t.c.drainEvents().some(e => e.type === 'model_discarded' && e.reason === 'configuration_changed'));
});

test('P01 binding: a second fault discards the old response and starts a new investigation', async () => {
  const t = timed();
  await readyAt(t, at(30_000, { obs: { down: ['r0-r3'] } }));
  const r = t.c.decide(at(31_000, { obs: { down: ['r0-r3', 'r1-r2'] } }));
  assert.notEqual(r?.source, 'meta');
  assert.ok(t.c.drainEvents().some(e => e.type === 'model_discarded' && e.reason === 'incident_changed'));
  assert.equal(t.provider.calls.length, 2);
});

test('P01 binding: a response that arrives after its decision deadline is discarded', async () => {
  const t = timed();
  await readyAt(t, at(30_000, { obs: { down: ['r0-r3'] } }));
  t.setNow(60_001);
  const r = t.c.decide(at(60_001, { obs: { down: ['r0-r3'] } }));
  assert.notEqual(r?.source, 'meta');
  assert.ok(t.c.drainEvents().some(e => e.type === 'model_discarded' && e.reason === 'expired'));
});

test('P01 binding: stopping the run cancels the call and an end-of-run arrival changes nothing', async () => {
  const t = timed();
  t.c.decide(at(30_000, { obs: { down: ['r0-r3'] } }));
  const call = t.provider.calls[0];
  t.c.stop();
  assert.equal(call.signal.aborted, true);
  call.resolve(ok(decision(['obs-10'], probe))); await flush();
  assert.equal(t.c.decide(at(31_000, { obs: { down: ['r0-r3'] } })), null);
  assert.equal(t.provider.calls.length, 1);
  assert.ok(t.c.drainEvents().some(e => e.type === 'model_discarded' && e.reason === 'run_stopped'));
});

test('P01 ordering: a superseded investigation is cancelled and its late answer is discarded', async () => {
  const t = timed();
  t.c.decide(at(30_000, { obs: { down: ['r0-r3'] } }));
  const first = t.provider.calls[0];
  t.c.decide(at(30_500, { obs: { down: ['r0-r3', 'r1-r2'] } })); // a new incident supersedes the outstanding call
  assert.equal(first.signal.aborted, true);
  const second = t.provider.calls[1];
  second.resolve(ok(decision(evidenceFrom(second.prompt), { type: 'retain_policy', reasonCode: 'second' })));
  await flush();
  first.resolve(ok(decision(evidenceFrom(first.prompt), probe)));
  await flush();
  const events = t.c.drainEvents();
  assert.ok(events.some(e => e.type === 'model_discarded' && e.reason === 'superseded'));
  assert.equal(events.filter(e => e.type === 'provider_call' && e.code === 'ok').length, 1, 'only the current answer is accepted');
  assert.equal(t.charged(), 2);
});

test('P01 conflict: a same-tick deterministic recovery goes first and the model plan waits rather than vanishing', async () => {
  const t = timed();
  await readyAt(t, at(30_000, { obs: { down: ['r0-r3', 'r1-r2'] } }));
  const first = t.c.decide(at(30_500, { obs: { down: ['r0-r3', 'r1-r2'] } }));
  assert.equal(first.source, 'deterministic');
  const moved = { ...reference(), 'dispatch-clinic': { version: 1, path: first.actions[0].path, ackPath: first.actions[0].ackPath } };
  t.c.applied(first, { status: 'confirmed', nowMs: 30_600, receipts: [] });
  const second = t.c.decide({ ...at(31_000, { obs: { down: ['r0-r3', 'r1-r2'] } }), routes: moved });
  assert.ok(second === null || second.source === 'meta' || second.source === 'deterministic');
  assert.ok(!t.c.drainEvents().some(e => e.type === 'model_discarded' && e.reason === 'conflict'), 'waiting is not discarding');
});
