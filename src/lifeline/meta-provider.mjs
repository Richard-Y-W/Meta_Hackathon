// Meta Responses API client and strict parser for the investigator's typed decision. Nothing the model
// returns reaches beliefs or actions without passing parseModelDecision; the credential never leaves
// the request header.
import { createHash } from 'node:crypto';

export const PROVIDER_CONFIG = Object.freeze({
  endpoint: 'https://api.meta.ai/v1/responses',
  promptVersion: 'lifeline-investigator-v1',
  // Measured in G0 (runtime run 0): 4.7-8.1 s per call; a 1,500-token cap truncated 6/10 decisions.
  maxOutputTokens: 4000,
  callTimeoutMs: 12_000,
  decisionDeadlineMs: 20_000,
  callsPerDecision: 2,
  maxResponseChars: 32_000,
});

const scrub = (text, key) => (key ? String(text).split(key).join('[redacted]') : String(text)).slice(0, 300);

export async function callModel({ apiKey, prompt, model = process.env.META_MODEL || 'muse-spark-1.3', timeoutMs = PROVIDER_CONFIG.callTimeoutMs, maxOutputTokens = PROVIDER_CONFIG.maxOutputTokens, fetchImpl = globalThis.fetch, now = () => performance.now() }) {
  const body = JSON.stringify({ model, input: [{ role: 'user', content: prompt }], max_output_tokens: maxOutputTokens });
  const base = { model, promptVersion: PROVIDER_CONFIG.promptVersion, promptSha256: createHash('sha256').update(body).digest('hex'), startedAtUnixMs: Date.now() };
  if (!apiKey) return { ...base, code: 'provider_unavailable', reason: 'credential_missing', durationMs: 0 };
  const started = now();
  try {
    const response = await fetchImpl(PROVIDER_CONFIG.endpoint, {
      method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ...base, code: 'provider_unavailable', reason: 'http_error', httpStatus: response.status, detail: scrub(detail, apiKey), durationMs: now() - started };
    }
    const result = await response.json();
    const durationMs = now() - started;
    const text = result.output_text ?? (result.output ?? []).flatMap(i => i.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('');
    const meta = { ...base, durationMs, httpStatus: response.status, responseId: result.id ?? null, reportedModel: result.model ?? null, usage: result.usage ?? null };
    if (text.length > PROVIDER_CONFIG.maxResponseChars) return { ...meta, code: 'provider_invalid_response', reason: 'response_too_large' };
    return { ...meta, code: 'ok', text };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { ...base, code: timedOut ? 'provider_timeout' : 'provider_unavailable', reason: timedOut ? 'timeout' : 'transport_error', detail: scrub(error?.message ?? error, apiKey), durationMs: now() - started };
  }
}

// Strict JSON: like JSON.parse, but a repeated object key anywhere is an error instead of last-wins.
export function strictJsonParse(raw) {
  const text = String(raw).trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let i = 0;
  const fail = what => { throw new Error(what); };
  const ws = () => { while (/\s/.test(text[i] ?? '')) i++; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const out = {}; ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws(); if (text[i] !== '"') fail('invalid_json');
        const key = string(); ws();
        if (text[i++] !== ':') fail('invalid_json');
        if (Object.hasOwn(out, key)) fail('duplicate_key');
        out[key] = value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] === '}') return out;
        fail('invalid_json');
      }
    }
    if (c === '[') {
      i++; const out = []; ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] === ']') return out;
        fail('invalid_json');
      }
    }
    if (c === '"') return string();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail('invalid_json');
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const string = () => {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(i));
    if (!m) fail('invalid_json');
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const out = value();
  ws();
  if (i !== text.length) fail('invalid_json');
  return out;
}

const ACTION_FIELDS = {
  probe_path: { required: ['type', 'sourceId', 'destinationId', 'packetCount', 'payloadBytes', 'intervalMs'], optional: ['path'], numeric: ['packetCount', 'payloadBytes', 'intervalMs'] },
  set_route: { required: ['type', 'flowId', 'path', 'ackPath'], optional: [], numeric: [] },
  set_background_rate: { required: ['type', 'sourceId', 'bitsPerSecond'], optional: [], numeric: ['bitsPerSecond'] },
  retain_policy: { required: ['type', 'reasonCode'], optional: [], numeric: [] },
};
const TOP = ['hypotheses', 'selected', 'actions', 'expected', 'beliefUpdates', 'stop'];
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finitePositive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

class Invalid extends Error {}
const invalid = detail => { throw new Invalid(detail); };

function exact(record, required, optional = []) {
  if (!plain(record)) invalid('missing_field');
  for (const k of Object.keys(record)) if (!required.includes(k) && !optional.includes(k)) invalid('unknown_field');
  for (const k of required) if (!Object.hasOwn(record, k)) invalid('missing_field');
}

function cited(list, evidenceIds) {
  if (!Array.isArray(list) || !list.length || list.length > 8) invalid('missing_field');
  for (const id of list) if (typeof id !== 'string' || !evidenceIds.has(id)) invalid('evidence_unknown');
}

export function parseModelDecision(text, { evidenceIds }) {
  try {
    let raw;
    try { raw = strictJsonParse(text); } catch (error) { invalid(error.message === 'duplicate_key' ? 'duplicate_key' : 'invalid_json'); }
    exact(raw, TOP);
    if (!Array.isArray(raw.hypotheses) || raw.hypotheses.length < 1 || raw.hypotheses.length > 3) invalid('missing_field');
    for (const h of raw.hypotheses) {
      exact(h, ['id', 'statement', 'evidence', 'wouldContradict']);
      if (typeof h.id !== 'string' || typeof h.statement !== 'string' || typeof h.wouldContradict !== 'string' || h.statement.length > 400 || h.wouldContradict.length > 300) invalid('missing_field');
      cited(h.evidence, evidenceIds);
    }
    if (new Set(raw.hypotheses.map(h => h.id)).size !== raw.hypotheses.length) invalid('duplicate_id');
    if (!raw.hypotheses.some(h => h.id === raw.selected)) invalid('hypothesis_unknown');
    if (!Array.isArray(raw.actions)) invalid('missing_field');
    if (raw.actions.length > 2) invalid('too_many_actions');
    if (typeof raw.stop !== 'boolean') invalid('missing_field');
    if (!raw.stop && raw.actions.length === 0) invalid('missing_field');
    const actions = raw.actions.map((a, i) => {
      if (!plain(a) || !Object.hasOwn(ACTION_FIELDS, a.type)) invalid('action_not_allowed');
      const spec = ACTION_FIELDS[a.type];
      exact(a, spec.required, spec.optional);
      for (const k of spec.numeric) if (!finitePositive(a[k]) || !Number.isInteger(a[k])) invalid('invalid_units');
      return { actionId: `m${i + 1}`, ...a };
    });
    if (!Array.isArray(raw.expected) || raw.expected.length > 3) invalid('missing_field');
    for (const e of raw.expected) {
      exact(e, ['flowId', 'onTimeFraction']);
      const r = e.onTimeFraction;
      if (!Array.isArray(r) || r.length !== 2 || r.some(v => typeof v !== 'number' || v < 0 || v > 1) || r[0] > r[1]) invalid('invalid_units');
    }
    if (!Array.isArray(raw.beliefUpdates) || raw.beliefUpdates.length > 3) invalid('missing_field');
    for (const u of raw.beliefUpdates) {
      exact(u, ['link', 'evidence'], ['hiBps', 'loBps']);
      if (typeof u.link !== 'string') invalid('missing_field');
      for (const k of ['hiBps', 'loBps']) if (Object.hasOwn(u, k) && !finitePositive(u[k])) invalid('invalid_units');
      cited(u.evidence, evidenceIds);
    }
    return { ok: true, code: 'ok', decision: { hypotheses: raw.hypotheses, selected: raw.selected, actions, expected: raw.expected, beliefUpdates: raw.beliefUpdates, stop: raw.stop } };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, code: 'proposal_invalid', detail: error.message };
    throw error;
  }
}
