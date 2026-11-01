// Bounded live Meta provider qualification. Usage:
//   node --env-file-if-exists=.env scripts/lifeline-provider-smoke.mjs --out artifacts/lifeline/provider-smoke.json [--count 10]
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

export const ENDPOINT = 'https://api.meta.ai/v1/responses';
export const PROMPT_VERSION = 'lifeline-smoke-v1';
const ACTIONS = ['set_route', 'set_background_rate', 'probe_path', 'retain_policy'];

// A development-sized diagnostic request, so latency reflects a decision call rather than a trivial echo.
const DEVELOPMENT_CONTEXT = {
  topology: { switches: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'], links: ['r0-r1', 'r1-r2', 'r2-r3', 'r3-r4', 'r4-r5', 'r5-r0', 'r0-r3', 'r1-r4'] },
  observations: [
    { id: 'obs-1', ageMs: 400, link: 'r0-r3', state: 'down' },
    { id: 'obs-2', ageMs: 400, link: 'r0-r1', utilization: 0.97, dropsPerS: 41 },
    { id: 'obs-3', ageMs: 400, service: 'dispatch->clinic', onTimeFraction: 0.61, retriesPerS: 22 },
  ],
  allowedActions: ACTIONS,
};

function requestBody(model, maxOutputTokens) {
  return {
    model,
    input: [{ role: 'user', content: `You are a network incident investigator for a synthetic emulated network. Using only these observations, return ONLY JSON {"hypothesis": <one sentence>, "action": <one of ${JSON.stringify(ACTIONS)}>, "evidence": [<observation ids>]}.\n${JSON.stringify(DEVELOPMENT_CONTEXT)}` }],
    max_output_tokens: maxOutputTokens,
  };
}

function outputText(result) {
  return result.output_text ?? (result.output ?? []).flatMap(item => item.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('');
}

function parseDecision(text) {
  let value;
  try { value = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { return 'invalid_json'; }
  const ids = new Set(DEVELOPMENT_CONTEXT.observations.map(o => o.id));
  const ok = value && typeof value.hypothesis === 'string' && ACTIONS.includes(value.action)
    && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(id => ids.has(id));
  return ok ? 'valid' : 'invalid_fields';
}

export async function smokeOnce({ apiKey, model, timeoutMs = 6000, maxOutputTokens = 1500, fetchImpl = globalThis.fetch, now = () => performance.now() }) {
  const body = JSON.stringify(requestBody(model, maxOutputTokens));
  const base = { model, promptVersion: PROMPT_VERSION, maxOutputTokens, endpoint: ENDPOINT, payloadSha256: createHash('sha256').update(body).digest('hex'), startedAtUnixMs: Date.now() };
  if (!apiKey) return { ...base, code: 'provider_unavailable', reason: 'credential_missing', durationMs: 0 };
  const scrub = text => String(text).split(apiKey).join('[redacted]').slice(0, 300);
  const started = now();
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ...base, code: 'provider_unavailable', reason: 'http_error', httpStatus: response.status, detail: scrub(detail), durationMs: now() - started };
    }
    const result = await response.json();
    const durationMs = now() - started;
    return {
      ...base, code: 'ok', durationMs, httpStatus: response.status, responseId: result.id ?? null,
      reportedModel: result.model ?? null, usage: result.usage ?? null, parserOutcome: parseDecision(outputText(result)),
    };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { ...base, code: timedOut ? 'provider_timeout' : 'provider_unavailable', reason: timedOut ? 'timeout' : 'transport_error', detail: scrub(error?.message ?? error), durationMs: now() - started };
  }
}

export function summarize(records) {
  const ok = records.filter(r => r.code === 'ok');
  const codes = {};
  for (const r of records) codes[r.code] = (codes[r.code] ?? 0) + 1;
  return {
    attempts: records.length, succeeded: ok.length, validDecisions: ok.filter(r => r.parserOutcome === 'valid').length,
    outcomes: codes, okDurationsMs: ok.map(r => r.durationMs),
    // Ten observations are a distribution, not a stable tail estimate.
    p95Claimed: false,
  };
}

async function main(argv) {
  const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const out = arg('--out');
  if (!out) throw new Error('--out is required');
  const admitted = admitOutputPath(repo, resolve(out));
  if (!admitted.ok) { console.log(JSON.stringify(admitted)); process.exitCode = 2; return; }
  const count = Math.min(Math.max(Number(arg('--count') ?? 1), 1), 20);
  const model = process.env.META_MODEL || 'muse-spark-1.3';
  const records = [];
  for (let i = 0; i < count; i++) {
    const record = await smokeOnce({ apiKey: process.env.MODEL_API_KEY, model, timeoutMs: Number(arg('--timeout-ms') ?? 6000), maxOutputTokens: Number(arg('--max-output-tokens') ?? 1500) });
    records.push({ attempt: i + 1, ...record });
    if (record.reason === 'credential_missing') break;
  }
  const report = { schema: 'lifeline.provider-smoke.v1', evidenceLevel: 'live-provider', records, summary: summarize(records) };
  mkdirSync(dirname(admitted.path), { recursive: true });
  writeFileSync(admitted.path, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
