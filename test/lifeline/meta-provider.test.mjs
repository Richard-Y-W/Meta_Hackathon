import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callModel, parseModelDecision, strictJsonParse, PROVIDER_CONFIG } from '../../src/lifeline/meta-provider.mjs';

const CONTROLS = JSON.parse(readFileSync(new URL('../../fixtures/lifeline/development/provider-controls.json', import.meta.url), 'utf8'));
const KEY = 'sk-test-must-not-leak';
const envelope = text => ({ id: 'resp-1', model: 'muse-spark-1.3', usage: { input_tokens: 900, output_tokens: 1200 }, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const reply = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const ids = new Set(CONTROLS.evidenceIds);

test('provider config reflects the measured G0 limits', () => {
  // Investigator development: at 4,000 tokens and default effort, 2/2 gray-failure responses were cut off
  // mid-reasoning; medium effort answered 3/3 in 3.6-7.0 s.
  assert.equal(PROVIDER_CONFIG.maxOutputTokens, 6000);
  assert.equal(PROVIDER_CONFIG.reasoningEffort, 'medium');
  // Live pilot development: 3.2k-token prompts took 7.9-11.9 s and 2/7 calls exceeded 12 s.
  assert.equal(PROVIDER_CONFIG.callTimeoutMs, 18_000);
  assert.equal(PROVIDER_CONFIG.decisionDeadlineMs, 30_000);
  assert.equal(PROVIDER_CONFIG.endpoint, 'https://api.meta.ai/v1/responses');
});

test('call: timeout, HTTP error and transport failure are precise outcomes without the key', async () => {
  const hang = (_u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const timeout = await callModel({ apiKey: KEY, prompt: 'p', timeoutMs: 30, fetchImpl: hang });
  assert.equal(timeout.code, 'provider_timeout');
  const http = await callModel({ apiKey: KEY, prompt: 'p', fetchImpl: reply({ error: `bad ${KEY}` }, 429) });
  assert.deepEqual([http.code, http.httpStatus], ['provider_unavailable', 429]);
  const transport = await callModel({ apiKey: KEY, prompt: 'p', fetchImpl: async () => { throw new Error(`ECONNRESET ${KEY}`); } });
  assert.equal(transport.code, 'provider_unavailable');
  for (const r of [timeout, http, transport]) assert.equal(JSON.stringify(r).includes(KEY), false);
  const missing = await callModel({ apiKey: '', prompt: 'p', fetchImpl: async () => assert.fail('no request without a key') });
  assert.deepEqual([missing.code, missing.reason], ['provider_unavailable', 'credential_missing']);
});

test('call: a valid envelope returns text, response ID, usage, duration and a prompt hash', async () => {
  let sent;
  const r = await callModel({ apiKey: KEY, prompt: 'hello', fetchImpl: async (url, o) => { sent = o; return reply(envelope('{"a":1}'))(); } });
  assert.equal(r.code, 'ok');
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.responseId, 'resp-1');
  assert.deepEqual(r.usage, { input_tokens: 900, output_tokens: 1200 });
  assert.match(r.promptSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(sent.body).max_output_tokens, 6000);
  assert.deepEqual(JSON.parse(sent.body).reasoning, { effort: 'medium' });
  assert.equal(sent.body.includes(KEY), false);
});

test('call: an oversized response is refused before parsing', async () => {
  const r = await callModel({ apiKey: KEY, prompt: 'p', fetchImpl: reply(envelope('x'.repeat(40_000))) });
  assert.equal(r.code, 'provider_invalid_response');
  assert.equal(r.reason, 'response_too_large');
});

test('strict JSON: duplicate keys are rejected at any depth; fenced JSON is accepted', () => {
  assert.throws(() => strictJsonParse('{"a":1,"a":2}'), /duplicate_key/);
  assert.throws(() => strictJsonParse('{"x":{"b":1,"b":1}}'), /duplicate_key/);
  assert.deepEqual(strictJsonParse('```json\n{"a":[1,{"b":2}]}\n```'), { a: [1, { b: 2 }] });
  assert.throws(() => strictJsonParse('not json'), /invalid_json/);
});

test('parse: a valid typed decision yields hypotheses, actions, expectations and the stop option', () => {
  const d = parseModelDecision(JSON.stringify(CONTROLS.valid), { evidenceIds: ids });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.decision.selected, 'h1');
  assert.equal(d.decision.actions[0].type, 'probe_path');
  assert.equal(d.decision.actions[0].actionId, 'm1');
  assert.equal(d.decision.hypotheses.length, 2);
  assert.equal(d.decision.stop, false);
});

for (const [name, code] of [['inventedEvidence', 'evidence_unknown'], ['unsupportedAction', 'action_not_allowed'], ['invalidUnits', 'invalid_units'], ['missingField', 'missing_field'], ['selectedUnknown', 'hypothesis_unknown'], ['tooManyActions', 'too_many_actions']]) {
  test(`parse: ${name} is rejected as ${code}`, () => {
    const d = parseModelDecision(JSON.stringify(CONTROLS.invalid[name]), { evidenceIds: ids });
    assert.equal(d.ok, false);
    assert.equal(d.code, 'proposal_invalid');
    assert.equal(d.detail, code);
  });
}

test('parse: malformed JSON and unknown top-level fields are rejected', () => {
  assert.equal(parseModelDecision('{"hypotheses": [', { evidenceIds: ids }).detail, 'invalid_json');
  assert.equal(parseModelDecision(JSON.stringify({ ...CONTROLS.valid, override: true }), { evidenceIds: ids }).detail, 'unknown_field');
  assert.equal(parseModelDecision(JSON.stringify({ ...CONTROLS.valid, hypotheses: [] }), { evidenceIds: ids }).detail, 'missing_field');
});

test('parse: a belief update must cite known evidence and use numeric units', () => {
  const withUpdate = u => JSON.stringify({ ...CONTROLS.valid, beliefUpdates: [u] });
  assert.equal(parseModelDecision(withUpdate({ link: 'r1>r2', hiBps: 3_000_000, evidence: ['obs-41'] }), { evidenceIds: ids }).ok, true);
  assert.equal(parseModelDecision(withUpdate({ link: 'r1>r2', hiBps: 3_000_000, evidence: ['obs-7'] }), { evidenceIds: ids }).detail, 'evidence_unknown');
  assert.equal(parseModelDecision(withUpdate({ link: 'r1>r2', hiBps: -1, evidence: ['obs-41'] }), { evidenceIds: ids }).detail, 'invalid_units');
});

test('call: a cancelled investigation aborts the request and is reported as cancelled, not as a provider failure', async () => {
  const abort = new AbortController();
  const hang = (_u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const pending = callModel({ apiKey: KEY, prompt: 'p', timeoutMs: 10_000, signal: abort.signal, fetchImpl: hang });
  abort.abort();
  const r = await pending;
  assert.equal(r.code, 'provider_cancelled');
  assert.ok(r.durationMs < 1000);
});
