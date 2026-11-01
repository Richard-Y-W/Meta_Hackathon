// Run the frozen pilot protocol sequentially on the qualified host and write the paired comparison.
//   node --env-file-if-exists=.env scripts/lifeline-evaluate.mjs --protocol fixtures/lifeline/protocol-v1.json \
//     --suite pilot --backend mininet --out artifacts/lifeline/pilot-v1
// Resumable: episodes already in index.jsonl are not rerun. Every attempt stays in the index.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchedule, classifyRun, compare, verifyProtocol } from '../src/lifeline/evaluation.mjs';
import { readEvents } from '../src/lifeline/ledger.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';
import { replayRun } from './lifeline-replay.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const read = p => JSON.parse(readFileSync(p, 'utf8'));

function costOf(dir) {
  const events = readEvents(join(dir, 'events.jsonl'));
  const calls = events.filter(e => e.type === 'controller_provider_call');
  const receipts = events.filter(e => e.type === 'execution').flatMap(e => e.receipts);
  return {
    modelCalls: calls.length, modelFailures: calls.filter(c => c.code !== 'ok').length,
    modelSeconds: calls.reduce((s, c) => s + (c.durationMs ?? 0), 0) / 1000,
    outputTokens: calls.reduce((s, c) => s + (c.usage?.output_tokens ?? 0), 0),
    modelRejected: events.filter(e => e.type === 'controller_model_rejected').length,
    degradedTransitions: events.filter(e => e.type === 'controller_mode' && e.mode === 'degraded').length,
    interventions: events.filter(e => e.type === 'execution').length,
    rejected: events.filter(e => e.type === 'decision' && !e.decision.admitted).length,
    metaDecisions: events.filter(e => e.type === 'decision' && e.source === 'meta').length,
    probeBytes: receipts.reduce((s, r) => s + (r.measurement?.bytesSent ?? 0), 0),
  };
}

function runEpisode(e, attempt, out) {
  const dir = join(out, attempt > 1 ? `${e.episodeId}.a${attempt}` : e.episodeId);
  // Reruns get their own tags: no two consecutive runs share run-owned object names.
  const tag = attempt > 1 ? `lf${'wxyz'[attempt - 2]}${'abcdefghijklmnopqrstuvwxyz0123456789'[(e.order - 1) % 36]}` : e.tag;
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--env-file-if-exists=.env', join(REPO, 'scripts/lifeline-run.mjs'), '--scenario', e.path, '--controller', e.controller, '--backend', 'mininet', '--tag', tag, '--out', dir],
    { cwd: REPO, encoding: 'utf8', timeout: 420_000 });
  const manifest = existsSync(join(dir, 'manifest.json')) ? read(join(dir, 'manifest.json')) : null;
  const summary = existsSync(join(dir, 'summary.json')) ? read(join(dir, 'summary.json')) : null;
  let replay = null;
  try { replay = manifest && summary ? replayRun(dir, REPO) : null; } catch (error) { replay = { ok: false, checks: { replay: { ok: false, detail: error.message } } }; }
  const verdict = classifyRun({ manifest, replay, summary });
  const p = summary?.results?.primary;
  return {
    episodeId: e.episodeId, block: e.block, caseId: e.caseId, controller: e.controller, repetition: e.repetition, order: e.order, attempt,
    recoverable: e.recoverable, noFault: e.noFault, runId: manifest?.runId ?? null, dir, exitCode: run.status, wallSeconds: (Date.now() - started) / 1000,
    ...verdict, primary: p ? { offered: p.offered, onTime: p.onTime, late: p.late, lost: p.lost, deliveryRate: p.deliveryRate } : null,
    perFlow: p?.byFlow ? Object.fromEntries(Object.entries(p.byFlow).map(([f, v]) => [f, v.deliveryRate])) : null,
    background: summary ? Object.fromEntries(Object.entries(summary.background).map(([k, v]) => [k, v.deliveredFraction])) : null,
    cost: manifest ? costOf(dir) : null, replayOk: replay?.ok ?? false,
  };
}

function markdown(c, rows) {
  const pct = v => (v === null || v === undefined ? '—' : (100 * v).toFixed(2));
  const pp = v => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${(100 * v).toFixed(2)}`);
  const lines = ['# LIFELINE pilot comparison (exploratory, G4a)', '', `Episodes: ${c.episodes.total} attempted, ${c.episodes.valid} valid, ${c.episodes.infrastructureInvalid} infrastructure-invalid.`, '',
    '| Case | Priority | Adaptive | Meta | Meta − adaptive (pp) | Meta − priority (pp) |', '| --- | --- | --- | --- | --- | --- |'];
  for (const [id, k] of Object.entries(c.cases)) lines.push(`| ${id}${k.noFault ? ' (no fault)' : ''}${k.recoverable ? '' : ' (partition)'} | ${pct(k.mean.priority)} | ${pct(k.mean.adaptive)} | ${pct(k.mean.meta)} | ${pp(k.diff.metaMinusAdaptive)} | ${pp(k.diff.metaMinusPriority)} |`);
  lines.push('', `Mean paired difference over recoverable failure cases (meta − adaptive): ${pp(c.summary.meanPairedDiffMetaMinusAdaptive)} pp; worst ${pp(c.summary.worstCaseDiffMetaMinusAdaptive)}, best ${pp(c.summary.bestCaseDiffMetaMinusAdaptive)}.`,
    `No-fault regression (adaptive − meta): ${pp(c.summary.noFaultRegressionMetaVsAdaptive)} pp.`, '', c.summary.note, '', '| Controller | Runs | Model calls | Model failures | Model seconds | Output tokens | Interventions | Rejected | Probe bytes |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(c.cost)) lines.push(`| ${k} | ${v.runs} | ${v.modelCalls} | ${v.modelFailures} | ${v.modelSeconds.toFixed(1)} | ${v.outputTokens} | ${v.interventions} | ${v.rejected} | ${v.probeBytes} |`);
  lines.push('', '## Every attempt', '', '| Order | Episode | Attempt | Status | On time | Run ID |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) lines.push(`| ${r.order} | ${r.episodeId} | ${r.attempt} | ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.superseded ? ', superseded' : ''} | ${pct(r.primary?.deliveryRate)} | ${r.runId ?? '—'} |`);
  return lines.join('\n') + '\n';
}

const protocolPath = resolve(arg('--protocol'));
const protocol = read(protocolPath);
const out = resolve(arg('--out'));
if (arg('--suite') !== protocol.suite) throw new Error(`suite ${arg('--suite')} is not the frozen ${protocol.suite} suite`);
const verified = verifyProtocol(protocol, p => readFileSync(resolve(REPO, p)));
if (!verified.ok) { console.log(JSON.stringify(verified)); process.exit(2); }
if (protocol.controllers.includes('meta') && !process.env.MODEL_API_KEY) { console.log(JSON.stringify({ ok: false, code: 'provider_unavailable', detail: 'credential_missing' })); process.exit(2); }
const admitted = admitOutputPath(REPO, out, { role: process.platform === 'linux' ? 'guest' : 'host' });
if (!admitted.ok) { console.log(JSON.stringify(admitted)); process.exit(2); }
mkdirSync(out, { recursive: true });
const indexPath = join(out, 'index.jsonl');
const rows = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const schedule = buildSchedule(protocol);
writeFileSync(join(out, 'schedule.json'), JSON.stringify({ protocol: protocolPath, protocolRevision: protocol.protocolRevision, orderSeed: protocol.orderSeed, episodes: schedule }, null, 2) + '\n');
const save = row => { rows.push(row); appendFileSync(indexPath, `${JSON.stringify(row)}\n`); };

// --reclassify: re-apply the current replay checker and validity rule to every recorded first attempt,
// without rerunning traffic. Each change is appended to reclassification.jsonl; reruns that the corrected
// rule would not have triggered are withdrawn from the comparison but stay in the index.
const reclassified = {};
if (argv.includes('--reclassify')) {
  for (const r of rows.filter(x => x.attempt === 1)) {
    const manifest = existsSync(join(r.dir, 'manifest.json')) ? read(join(r.dir, 'manifest.json')) : null;
    const summary = existsSync(join(r.dir, 'summary.json')) ? read(join(r.dir, 'summary.json')) : null;
    let replay = null;
    try { replay = manifest && summary ? replayRun(r.dir, REPO) : null; } catch (error) { replay = { ok: false, checks: { replay: { ok: false, detail: error.message } } }; }
    const after = classifyRun({ manifest, replay, summary });
    reclassified[r.episodeId] = after;
    appendFileSync(join(out, 'reclassification.jsonl'), `${JSON.stringify({ episodeId: r.episodeId, attempt: 1, before: { status: r.status, reason: r.reason ?? null }, after, checker: 'compareContractDecision (contract check only)', atUnixMs: Date.now() })}\n`);
  }
}

for (const e of schedule) {
  if (rows.some(r => r.episodeId === e.episodeId && r.attempt === 1)) continue;
  const row = runEpisode(e, 1, out);
  save(row);
  console.log(JSON.stringify({ order: e.order, episode: e.episodeId, status: row.status, reason: row.reason, onTime: row.primary?.deliveryRate, wallSeconds: Math.round(row.wallSeconds) }));
}
// Infrastructure-invalid runs: rerun the whole paired block once, retaining the original attempts.
const statusOf = r => (r.attempt === 1 && reclassified[r.episodeId] ? reclassified[r.episodeId].status : r.status);
for (const block of [...new Set(rows.filter(r => statusOf(r) === 'infrastructure_invalid' && r.attempt === 1).map(r => r.block))]) {
  if (rows.some(r => r.block === block && r.attempt === 2)) continue;
  for (const e of schedule.filter(x => x.block === block)) {
    const row = runEpisode(e, 2, out);
    save(row);
    console.log(JSON.stringify({ rerun: e.episodeId, status: row.status, onTime: row.primary?.deliveryRate }));
  }
}
// A block's rerun counts only if the (current) rule found its first attempt infrastructure-invalid.
const needsRerun = new Set(rows.filter(r => r.attempt === 1 && statusOf(r) === 'infrastructure_invalid').map(r => r.block));
const forCompare = rows.map(r => {
  const current = r.attempt === 1 && reclassified[r.episodeId] ? { ...r, ...reclassified[r.episodeId], reason: reclassified[r.episodeId].reason } : r;
  if (r.attempt > 1 && !needsRerun.has(r.block)) return { ...current, status: 'withdrawn', reason: 'rerun not required under the corrected rule' };
  if (r.attempt === 1 && needsRerun.has(r.block) && rows.some(x => x.block === r.block && x.attempt > 1)) return { ...current, superseded: true, status: statusOf(r) === 'valid' ? 'superseded' : statusOf(r) };
  return current;
});
const comparison = { version: 'lifeline.pilot-comparison.v1', protocol: { path: arg('--protocol'), revision: protocol.protocolRevision, frozenAtCommit: protocol.frozenAtCommit },
  reclassification: Object.keys(reclassified).length ? { applied: true, changed: rows.filter(r => r.attempt === 1 && reclassified[r.episodeId] && reclassified[r.episodeId].status !== r.status).map(r => ({ episodeId: r.episodeId, before: r.reason, after: reclassified[r.episodeId].status })), withdrawnAttempts: forCompare.filter(r => r.status === 'withdrawn').length } : { applied: false },
  ...compare(forCompare.map(r => (r.status === 'withdrawn' ? { ...r, status: 'withdrawn' } : r))) };
writeFileSync(join(out, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
writeFileSync(join(out, 'comparison.md'), markdown(comparison, forCompare));
console.log(JSON.stringify({ done: true, episodes: comparison.episodes, summary: comparison.summary }));
