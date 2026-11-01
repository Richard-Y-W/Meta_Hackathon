// Single LIFELINE run on the isolated Linux host (the reference deployment runs the supervisor in the VM).
//   node scripts/lifeline-run.mjs --scenario fixtures/lifeline/development/cascade.json --controller fixed \
//     --backend mininet --out artifacts/lifeline/packet-run-0 [--duration-ms 120000] [--tag lfa1]
// The orchestrator connection owns scenario construction and the hidden fault schedule. The supervisor
// connection sees only telemetry. Scores come from sender/receiver records, never from controller output.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalRecord } from '../src/lifeline/identity.mjs';
import { scoreBackground, scoreMessages } from '../src/lifeline/metrics.mjs';
import { admitObservation, auditControllerView } from '../src/lifeline/telemetry.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';
import { RunBudgets, admitProposal } from '../src/lifeline/guard.mjs';
import { Executor } from '../src/lifeline/executor.mjs';
import { createScriptedController } from '../src/lifeline/controllers/scripted.mjs';
import { WorkerClient } from '../src/lifeline/worker-client.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_MS = 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function args(argv) {
  const get = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  return {
    scenario: get('--scenario'), controller: get('--controller', 'fixed'), backend: get('--backend', 'mininet'),
    out: get('--out'), script: get('--script'), policy: get('--policy', 'fixtures/lifeline/policy-v1.json'), durationMs: get('--duration-ms') ? Number(get('--duration-ms')) : undefined,
    tag: get('--tag', `lf${randomBytes(1).toString('hex')}`),
  };
}

const lines = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : null);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

async function openClient(socketPath, runId, role) {
  const stream = connect(socketPath);
  await new Promise((ok, fail) => { stream.once('connect', ok); stream.once('error', fail); });
  const client = new WorkerClient(stream, { runId, role });
  await client.hello();
  return client;
}

function score(runDir, scenario, epochNs, startAtMs, durationMs, faults) {
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

async function main() {
  const opt = args(process.argv.slice(2));
  if (opt.backend !== 'mininet') throw new Error('only the mininet backend exists');
  if (!['fixed', 'scripted'].includes(opt.controller)) throw new Error(`controller ${opt.controller} is not implemented yet`);
  if (opt.controller === 'scripted' && !opt.script) throw new Error('--script is required for the scripted diagnostic controller');
  const out = resolve(opt.out);
  const admitted = admitOutputPath(REPO, out, { role: process.platform === 'linux' ? 'guest' : 'host' });
  if (!admitted.ok) { console.log(JSON.stringify(admitted)); process.exitCode = 2; return; }
  const full = JSON.parse(readFileSync(resolve(opt.scenario), 'utf8'));
  const { faults: hiddenFaults, ...publicScenario } = full; // the schedule stays with the orchestrator
  const durationMs = opt.durationMs ?? full.durationMs;
  const faults = hiddenFaults.filter(f => f.atMs < durationMs);
  const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${opt.tag}`;
  const runDir = `/run/lifeline/${runId}`;
  const socketPath = `${runDir}/worker.sock`;
  mkdirSync(out, { recursive: true });
  const events = join(out, 'events.jsonl');
  const record = (type, data) => appendFileSync(events, `${JSON.stringify({ type, atUnixMs: Date.now(), ...data })}\n`);

  execFileSync('sudo', ['-n', 'mkdir', '-p', runDir]);
  const worker = spawn('sudo', ['-n', 'python3', join(REPO, 'runtime/mininet/worker.py'), '--run-id', runId, '--socket', socketPath, '--dir', runDir, '--tag', opt.tag],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let workerLog = '';
  worker.stdout.on('data', d => { workerLog += d; });
  worker.stderr.on('data', d => { workerLog += d; });
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) await sleep(100);

  const manifest = {
    version: 'RunManifestV1', runId, controller: opt.controller, backend: opt.backend, tag: opt.tag,
    code: { commit: execFileSync('git', ['-c', 'safe.directory=*', '-C', REPO, 'rev-parse', 'HEAD']).toString().trim(), dirty: execFileSync('git', ['-c', 'safe.directory=*', '-C', REPO, 'status', '--porcelain']).toString().trim().split('\n').filter(Boolean) },
    scenario: { path: opt.scenario, scenarioId: full.scenarioId, sha256: canonicalRecord(full).sha256, publicSha256: canonicalRecord(publicScenario).sha256 },
    durationMs, startedAtUnixMs: Date.now(), terminal: 'running',
  };
  const observations = [];
  let orchestrator, supervisor;
  try {
    orchestrator = await openClient(socketPath, runId, 'orchestrator');
    supervisor = await openClient(socketPath, runId, 'supervisor');
    const epochNs = BigInt(orchestrator.info.epochMonotonicNs);
    const nowMs = () => Number(process.hrtime.bigint() - epochNs) / 1e6; // same CLOCK_MONOTONIC, same kernel
    manifest.workerEpochMonotonicNs = orchestrator.info.epochMonotonicNs;
    const built = await orchestrator.request('build', publicScenario, { timeoutMs: 60_000 });
    record('built', { configRevision: built.configRevision, policy: built.policy, interfaces: built.interfaces });

    const policy = JSON.parse(readFileSync(resolve(REPO, opt.policy), 'utf8'));
    const policyId = canonicalRecord(policy).sha256;
    manifest.policy = { path: opt.policy, sha256: policyId };
    const topology = {
      revision: full.topologyRevision, nodes: full.topology.switches, links: full.topology.links.map(({ linkId, a, b }) => ({ linkId, a, b })),
      endpoints: Object.fromEntries(full.topology.hosts.map(h => [h.hostId, h.switch])),
    };
    const budgets = new RunBudgets(policy);
    const controller = opt.controller === 'scripted' ? createScriptedController(JSON.parse(readFileSync(resolve(opt.script), 'utf8'))) : null;
    if (opt.script) manifest.script = { path: opt.script, sha256: sha256(resolve(opt.script)) };
    let latest = null;
    const linkUp = (a, b) => {
      const link = topology.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
      return latest?.links?.[link.linkId]?.state === 'up';
    };
    const executor = new Executor({
      client: supervisor, now: nowMs, sleep, drainMs: 1000, verifyTimeoutMs: 3000, verifyPollMs: 200,
      currentRoutes: Object.fromEntries(full.workload.essential.map(f => [f.flowId, { version: 0, path: full.referencePolicy.routes[f.flowId].primary, ackPath: full.referencePolicy.ackRoutes[f.flowId].primary }])),
      isPathFeasible: path => path.slice(1).every((node, i) => linkUp(path[i], node)),
      fallback: async () => null,
    });
    let outstanding = null;
    const startAtMs = Math.ceil(nowMs()) + 1500;
    const traffic = await orchestrator.request('start_traffic', { startAtMs, stopAtMs: startAtMs + durationMs, tailMs: 2000 }, { timeoutMs: 10_000 });
    record('traffic_started', { startAtMs, stopAtMs: startAtMs + durationMs, ...traffic });
    manifest.trafficStartAtMs = startAtMs;

    const pending = faults.map(f => ({ ...f, due: startAtMs + f.atMs }));
    let lastSeq = 0;
    const endAt = traffic.listenUntilMs + 500;
    let nextSample = startAtMs;
    while (nowMs() < endAt) {
      for (const fault of pending.filter(f => !f.done && nowMs() >= f.due)) {
        fault.done = true;
        const result = await orchestrator.request('inject_fault', { atMs: fault.atMs, kind: fault.kind, linkId: fault.linkId, ...(fault.bwMbit ? { bwMbit: fault.bwMbit } : {}) });
        record('admin_fault', { fault: { atMs: fault.atMs, kind: fault.kind, linkId: fault.linkId, bwMbit: fault.bwMbit }, scheduledAtMs: fault.due, appliedAtMs: result.appliedAtMs });
      }
      if (nowMs() >= nextSample) {
        nextSample += SAMPLE_MS;
        try {
          const raw = await supervisor.request('telemetry', { intervalMs: SAMPLE_MS }, { timeoutMs: 2000 });
          const admittedObs = admitObservation(raw, { runId, nowMs: nowMs(), lastSeq, maxAgeMs: 2000 });
          if (admittedObs.ok) { lastSeq = raw.seq; observations.push(admittedObs.observation); latest = admittedObs.observation; }
          else record('observation_rejected', { code: admittedObs.code });
          const intent = controller && latest && !outstanding ? controller.decide({ observation: latest, trafficMs: nowMs() - startAtMs }) : null;
          if (intent) {
            const proposal = {
              version: 'ProposalV1', proposalId: intent.proposalId, runId, policyId, baseConfigRevision: latest.configRevision,
              observationSeq: latest.seq, observationAtMs: Math.floor(latest.collectedAtMs), expiresAtMs: Math.floor(latest.collectedAtMs) + policy.limits.proposalLifetimeMs, // integer ms: exact lifetime
              preconditions: intent.preconditions, actions: intent.actions, predicted: [], evidence: [`obs-${latest.seq}`],
            };
            const decision = admitProposal(proposal, { runId, configRevision: latest.configRevision, nowMs: nowMs(), policy, policyId, topology, observation: latest, budgets });
            record('decision', { controller: controller.name, proposal, decision });
            if (decision.admitted) {
              outstanding = executor.execute(decision, proposal).then(result => { record('execution', { controller: controller.name, ...result }); })
                .catch(error => record('execution_failed', { detail: error.message })).finally(() => { outstanding = null; });
            }
          }
        } catch (error) { record('telemetry_failed', { code: error.code, detail: error.detail }); }
      }
      await sleep(Math.max(5, Math.min(50, nextSample - nowMs())));
    }
    if (outstanding) await outstanding;
    const collected = await orchestrator.request('collect', {});
    record('collected', collected);
    const teardown = await orchestrator.request('teardown', {}, { timeoutMs: 60_000 });
    record('teardown', teardown);
    manifest.teardown = teardown;

    const rawDir = join(out, 'raw');
    mkdirSync(rawDir, { recursive: true });
    for (const name of readdirSync(runDir).filter(n => n.endsWith('.jsonl'))) copyFileSync(join(runDir, name), join(rawDir, name));
    writeFileSync(join(out, 'controller-view.jsonl'), observations.map(o => JSON.stringify(o)).join('\n') + '\n');
    const audit = auditControllerView(observations, faults);
    const summary = { runId, ...score(rawDir, full, epochNs, startAtMs, durationMs, faults), controllerViewAudit: { observations: observations.length, findings: audit } };
    writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    manifest.terminal = summary.status === 'scored' && audit.length === 0 ? 'completed' : 'run_incomplete';
    console.log(JSON.stringify({ runId, terminal: manifest.terminal, primary: summary.results?.primary && { offered: summary.results.primary.offered, onTime: summary.results.primary.onTime, late: summary.results.primary.late, lost: summary.results.primary.lost, deliveryRate: summary.results.primary.deliveryRate }, audit: audit.length, teardown }));
  } catch (error) {
    manifest.terminal = 'run_incomplete';
    manifest.failure = { code: error.code ?? 'error', detail: error.detail ?? error.message };
    record('run_failed', manifest.failure);
    console.error(error);
    process.exitCode = 1;
  } finally {
    try { await (orchestrator ?? supervisor)?.request('shutdown', {}); } catch { /* worker may already be gone */ }
    orchestrator?.close(); supervisor?.close();
    await Promise.race([new Promise(r => worker.once('exit', r)), sleep(10_000)]);
    manifest.workerExitCode = worker.exitCode;
    manifest.endedAtUnixMs = Date.now();
    writeFileSync(join(out, 'worker.log'), workerLog);
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const files = readdirSync(out, { recursive: true }).filter(n => !n.endsWith('checksums.txt')).map(n => join(out, n)).filter(p => !p.endsWith('/raw') && existsSync(p));
    writeFileSync(join(out, 'checksums.txt'), files.filter(p => { try { return readFileSync(p) && true; } catch { return false; } }).map(p => `${sha256(p)}  ${p.slice(out.length + 1)}`).join('\n') + '\n');
  }
}

await main();
