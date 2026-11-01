// P03 evidence: one communications run driven only through the common infrastructure adapter
// (src/lifeline/domains/communications.mjs). The orchestrator builds the scenario and injects the hidden
// faults; control uses adapter.observe() envelopes and adapter.execute() action envelopes, nothing else.
// The adapter's measure() score is compared with the original receipt scorer on the same raw records.
//   node scripts/lifeline-adapter-run.mjs --scenario fixtures/lifeline/development/cascade.json \
//     --out artifacts/lifeline/infra/p03-run-0/adapter-run [--duration-ms 60000] [--tag lfp3]
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommunicationsAdapter } from '../src/lifeline/domains/communications.mjs';
import { validateEnvelope } from '../src/lifeline/kernel/contracts.mjs';
import { msToUs } from '../src/lifeline/kernel/clock.mjs';
import { buildInventory, candidatePaths } from '../src/lifeline/controllers/common.mjs';
import { scoreRun } from '../src/lifeline/run-score.mjs';
import { Ledger } from '../src/lifeline/ledger.mjs';
import { canonicalRecord } from '../src/lifeline/identity.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';
import { WorkerClient } from '../src/lifeline/worker-client.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_MS = 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);

async function openClient(socketPath, runId, role) {
  const stream = connect(socketPath);
  await new Promise((ok, fail) => { stream.once('connect', ok); stream.once('error', fail); });
  const client = new WorkerClient(stream, { runId, role });
  await client.hello();
  return client;
}

const out = resolve(get('--out'));
const admitted = admitOutputPath(REPO, out, { role: process.platform === 'linux' ? 'guest' : 'host' });
if (!admitted.ok) { console.log(JSON.stringify(admitted)); process.exit(2); }
const scenarioPath = get('--scenario');
const full = JSON.parse(readFileSync(resolve(scenarioPath), 'utf8'));
const { faults: hiddenFaults, ...publicScenario } = full;
const durationMs = Number(get('--duration-ms', full.durationMs));
const faults = hiddenFaults.filter(f => f.atMs < durationMs);
const policy = JSON.parse(readFileSync(resolve(REPO, 'fixtures/lifeline/policy-v1.json'), 'utf8'));
const tag = get('--tag', `lf${randomBytes(1).toString('hex')}`);
const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${tag}`;
const runDir = `/run/lifeline/${runId}`;
const socketPath = `${runDir}/worker.sock`;
mkdirSync(out, { recursive: true });
const ledger = new Ledger(join(out, 'events.jsonl'));
const record = (type, data) => ledger.append(type, data);

execFileSync('sudo', ['-n', 'mkdir', '-p', runDir]);
const worker = spawn('sudo', ['-n', 'python3', join(REPO, 'runtime/mininet/worker.py'), '--run-id', runId, '--socket', socketPath, '--dir', runDir, '--tag', tag], { stdio: ['ignore', 'pipe', 'pipe'] });
let workerLog = '';
worker.stdout.on('data', d => { workerLog += d; });
worker.stderr.on('data', d => { workerLog += d; });
for (let i = 0; i < 100 && !existsSync(socketPath); i++) await sleep(100);

const manifest = {
  version: 'AdapterRunManifestV1', runId, tag, durationMs, adapter: 'communications', startedAtUnixMs: Date.now(), terminal: 'running',
  code: { commit: execFileSync('git', ['-c', 'safe.directory=*', '-C', REPO, 'rev-parse', 'HEAD']).toString().trim() },
  scenario: { path: scenarioPath, scenarioId: full.scenarioId, sha256: canonicalRecord(full).sha256 }, policy: { sha256: canonicalRecord(policy).sha256 },
};
let orchestrator, supervisor;
const envelopes = { observations: 0, invalid: [], actions: [], receipts: [] };
try {
  orchestrator = await openClient(socketPath, runId, 'orchestrator');
  supervisor = await openClient(socketPath, runId, 'supervisor');
  const epochNs = BigInt(orchestrator.info.epochMonotonicNs);
  const nowMs = () => Number(process.hrtime.bigint() - epochNs) / 1e6;
  manifest.workerEpochMonotonicNs = orchestrator.info.epochMonotonicNs;
  record('built', await orchestrator.request('build', publicScenario, { timeoutMs: 60_000 }));

  const adapter = createCommunicationsAdapter({ client: supervisor, now: nowMs, sleep });
  const init = await adapter.initialize({ runId, scenario: full, policy });
  if (!init.ok) throw new Error(`adapter initialize: ${init.code}`);
  const capabilities = adapter.describe().capabilities;
  const inventory = buildInventory(full, policy);
  const current = Object.fromEntries(inventory.essential.map(f => [f.flowId, inventory.reference[f.flowId].primary]));

  const startAtMs = Math.ceil(nowMs()) + 1500;
  const traffic = await orchestrator.request('start_traffic', { startAtMs, stopAtMs: startAtMs + durationMs, tailMs: 2000 }, { timeoutMs: 10_000 });
  manifest.trafficStartAtMs = startAtMs;
  const pending = faults.map(f => ({ ...f, due: startAtMs + f.atMs }));
  let nextSample = startAtMs, seq = 0;
  const endAt = traffic.listenUntilMs + 500;
  while (nowMs() < endAt) {
    for (const fault of pending.filter(f => !f.done && nowMs() >= f.due)) {
      fault.done = true;
      const { due, done, ...args } = fault;
      record('admin_fault', { fault: args, appliedAtMs: (await orchestrator.request('inject_fault', args)).appliedAtMs });
    }
    if (nowMs() >= nextSample) {
      nextSample += SAMPLE_MS;
      const obs = await adapter.observe();
      if (!obs.ok) { record('observe_failed', obs); continue; }
      envelopes.observations += obs.observations.length;
      for (const o of obs.observations) { const v = validateEnvelope(o, { runId }); if (!v.ok) envelopes.invalid.push({ id: o.observationId, code: v.code }); }
      // Conventional rule over adapter envelopes only: a flow whose path crosses a link reported down
      // moves to the first candidate path over links reported up.
      const up = new Set(obs.observations.filter(o => o.metric === 'link.state' && o.quantity.value === 1).map(o => o.assetId));
      const linkId = (a, b) => inventory.topology.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))?.linkId;
      for (const flow of inventory.essential) {
        const path = current[flow.flowId];
        if (path.slice(1).every((n, i) => up.has(linkId(path[i], n)))) continue;
        const live = { ...inventory.topology, links: inventory.topology.links.filter(l => up.has(l.linkId)) };
        const [next] = candidatePaths(live, flow.from, flow.to, 1);
        if (!next) continue;
        const action = {
          schemaVersion: 'infra-contract-v1', runId, domainId: 'communications', sequence: ++seq, tickUs: msToUs(Math.floor(nowMs())), kind: 'action',
          actionId: `adapter-route-${seq}`, capabilityId: 'comms.set_route', parameters: { flowId: flow.flowId, path: next, ackPath: [...next].reverse() },
          preconditions: [], effectDeadlineUs: msToUs(Math.floor(nowMs()) + 5000), lockSet: [`comms:${flow.flowId}`], authorityGrant: 'conventional-baseline', compensation: [],
        };
        const env = validateEnvelope(action, { runId, capabilities });
        const result = await adapter.execute(action);
        envelopes.actions.push({ actionId: action.actionId, envelope: env.code, flowId: flow.flowId, path: next });
        envelopes.receipts.push(result.receipt);
        record('adapter_execute', { action, receipt: result.receipt });
        if (result.receipt.status === 'success') current[flow.flowId] = next;
      }
    }
    await sleep(Math.max(5, Math.min(50, nextSample - nowMs())));
  }
  record('collected', await orchestrator.request('collect', {}));
  record('teardown', await orchestrator.request('teardown', {}, { timeoutMs: 60_000 }));
  const rawDir = join(out, 'raw');
  mkdirSync(rawDir, { recursive: true });
  for (const name of readdirSync(runDir).filter(n => n.endsWith('.jsonl'))) copyFileSync(join(runDir, name), join(rawDir, name));
  try { execFileSync('sudo', ['-n', 'rm', '-rf', '--', runDir]); } catch { record('run_dir_cleanup_failed', { runDir }); }

  const ledgerEnd = ledger.finalize();
  const measured = await adapter.measure({ bundleDir: out, manifest: { ...manifest, durationMs }, scenario: full });
  const original = scoreRun(rawDir, full, epochNs, startAtMs, durationMs, faults);
  const same = JSON.stringify(measured.score.results) === JSON.stringify(original.results);
  const measurementsValid = measured.measurements.every(m => validateEnvelope(m, { runId }).ok);
  await adapter.close();
  const summary = {
    runId, scoreMatchesOriginal: same, measurementsValid, primary: original.results.primary && { offered: original.results.primary.offered, onTime: original.results.primary.onTime, deliveryRate: original.results.primary.deliveryRate },
    envelopes: { observations: envelopes.observations, invalidObservations: envelopes.invalid.length, actions: envelopes.actions, receipts: envelopes.receipts.map(r => ({ actionId: r.actionId, status: r.status, reason: r.reason })) },
    measurements: measured.measurements.length, ledger: ledgerEnd,
  };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  manifest.terminal = same && measurementsValid && envelopes.invalid.length === 0 ? 'completed' : 'run_incomplete';
  console.log(JSON.stringify({ terminal: manifest.terminal, scoreMatchesOriginal: same, primary: summary.primary, actions: envelopes.actions.length, receipts: summary.envelopes.receipts }));
} catch (error) {
  manifest.terminal = 'run_incomplete';
  manifest.failure = { code: error.code ?? 'error', detail: error.detail ?? error.message };
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await (orchestrator ?? supervisor)?.request('shutdown', {}); } catch { /* already gone */ }
  orchestrator?.close(); supervisor?.close();
  await Promise.race([new Promise(r => worker.once('exit', r)), sleep(10_000)]);
  manifest.workerExitCode = worker.exitCode;
  manifest.endedAtUnixMs = Date.now();
  writeFileSync(join(out, 'worker.log'), workerLog);
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
