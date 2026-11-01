// Receipt-based scoring of one run bundle from its raw sender/receiver records. Shared by the run script
// and the replay verifier so a recomputed score uses exactly the same rules.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreBackground, scoreMessages } from './metrics.mjs';

const lines = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : null);

export function scoreRun(runDir, scenario, epochNs, startAtMs, durationMs, faults) {
  const rel = ns => (Number(BigInt(ns) - epochNs) / 1e6) - startAtMs; // ms since traffic start
  const offered = [], receipts = [], transmissions = {}, manifests = [];
  let captureThroughMs = Infinity;
  for (const flow of scenario.workload.essential) {
    const tx = lines(join(runDir, `tx-${flow.flowId}.jsonl`));
    const rx = lines(join(runDir, `rx-${flow.flowId}.jsonl`));
    if (!tx || !rx) return { status: 'run_incomplete', detail: `missing capture for ${flow.flowId}` };
    const complete = tx.find(r => r.t === 'complete');
    const flowOffered = tx.filter(r => r.t === 'offered');
    manifests.push({ flowId: flow.flowId, complete: Boolean(complete), declared: complete?.offered ?? null, recorded: flowOffered.length });
    for (const r of flowOffered) offered.push({ id: r.id, flowId: flow.flowId, createdAtMs: rel(r.createdAtNs), deadlineMs: r.deadlineMs });
    transmissions[flow.flowId] = tx.filter(r => r.t === 'tx').length;
    for (const r of rx) if (r.t === 'rx') receipts.push({ id: r.id, receivedAtMs: rel(r.receivedAtNs) });
    const rxComplete = rx.find(r => r.t === 'complete');
    captureThroughMs = Math.min(captureThroughMs, rxComplete ? rel(rxComplete.atNs) : -1);
  }
  const senderManifest = { complete: manifests.every(m => m.complete && m.declared === m.recorded), count: manifests.reduce((s, m) => s + (m.declared ?? -1), 0) };
  const firstIncident = Math.min(durationMs, faults.length ? Math.min(...faults.map(f => f.atMs)) : scenario.warmupMs);
  const windows = { warmup: [0, firstIncident], primary: [firstIncident, durationMs] };
  const sorted = [...new Set(faults.map(f => f.atMs))].sort((a, b) => a - b);
  sorted.forEach((at, i) => { windows[`afterIncident${i + 1}`] = [at, sorted[i + 1] ?? durationMs]; });
  const results = {};
  for (const [name, [fromMs, toMs]] of Object.entries(windows)) {
    try { results[name] = scoreMessages({ offered, receipts, fromMs, toMs, captureThroughMs, senderManifest }); delete results[name].byFlow.undefined; }
    catch (error) { results[name] = { error: error.code ?? 'error', detail: error.detail ?? error.message }; }
  }
  // Per-second on-time series (by creation second) for evidence and display.
  const first = new Map();
  for (const r of receipts) if (!first.has(r.id) || r.receivedAtMs < first.get(r.id)) first.set(r.id, r.receivedAtMs);
  const series = {};
  for (const m of offered) {
    const s = Math.floor(m.createdAtMs / 1000);
    const row = (series[m.flowId] ??= {})[s] ??= { offered: 0, onTime: 0 };
    row.offered++;
    const at = first.get(m.id);
    if (at !== undefined && at >= m.createdAtMs && at <= m.createdAtMs + m.deadlineMs) row.onTime++;
  }
  const background = {};
  for (const flow of scenario.workload.background) {
    const tx = lines(join(runDir, `bulk-tx-${flow.sourceId}.jsonl`)) ?? [];
    const rx = lines(join(runDir, `bulk-rx-${flow.sourceId}.jsonl`)) ?? [];
    const scheduled = tx.filter(r => r.t === 'bin').map(r => ({ sourceId: flow.sourceId, atMs: Math.max(0, rel(r.endNs) - 1), bytes: r.scheduledBytes }));
    const delivered = rx.filter(r => r.t === 'bin').map(r => ({ sourceId: flow.sourceId, atMs: r.endMs - 1 - startAtMs, bytes: r.deliveredBytes }));
    const sent = tx.filter(r => r.t === 'bin').reduce((s, r) => s + r.sentBytes, 0);
    background[flow.sourceId] = { ...scoreBackground({ offered: scheduled, delivered, fromMs: firstIncident, toMs: durationMs }), sentBytesWholeRun: sent };
  }
  const offeredCount = offered.length;
  return {
    status: Object.values(results).some(r => r.error) ? 'run_incomplete' : 'scored', windows, results, background,
    retryAmplification: Object.fromEntries(scenario.workload.essential.map(f => [f.flowId, transmissions[f.flowId] / offered.filter(m => m.flowId === f.flowId).length])),
    senderManifests: manifests, captureThroughMs, offeredCount, series,
  };
}

