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
import { scoreRun } from '../src/lifeline/run-score.mjs';
import { Ledger } from '../src/lifeline/ledger.mjs';
import { SessionState } from '../src/lifeline/session.mjs';
import { admitObservation, auditControllerView, deriveRates } from '../src/lifeline/telemetry.mjs';
import { admitOutputPath } from '../src/lifeline/storage.mjs';
import { RunBudgets, admitProposal } from '../src/lifeline/guard.mjs';
import { Executor } from '../src/lifeline/executor.mjs';
import { createScriptedController } from '../src/lifeline/controllers/scripted.mjs';
import { CapacityBeliefs } from '../src/lifeline/beliefs.mjs';
import { forecast } from '../src/lifeline/forecast.mjs';
import { createPriorityController } from '../src/lifeline/controllers/priority.mjs';
import { createAdaptiveController } from '../src/lifeline/controllers/adaptive.mjs';
import { createMetaController } from '../src/lifeline/controllers/meta.mjs';
import { PROVIDER_CONFIG, callModel } from '../src/lifeline/meta-provider.mjs';
import { backgroundPath, backgroundWireBps, buildInventory, candidatePaths, effectiveRoute, essentialDemandBps, linkBetween } from '../src/lifeline/controllers/common.mjs';
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

async function main() {
  const opt = args(process.argv.slice(2));
  if (opt.backend !== 'mininet') throw new Error('only the mininet backend exists');
  if (!['fixed', 'scripted', 'priority', 'adaptive', 'meta'].includes(opt.controller)) throw new Error(`controller ${opt.controller} is not implemented yet`);
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
  const ledger = new Ledger(events); // append-only, hash-chained; the event type lives outside the data
  const record = (type, data) => ledger.append(type, data);
  const session = new SessionState(() => Date.now());
  const move = (to, reason) => { try { session.transition(to, reason); record('session_state', { state: to, reason }); } catch { record('session_violation', { from: session.state, to, reason }); } };

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
    const inventory = buildInventory(full, policy); // operator-known topology, nominal ratings, declared workload
    const { topology } = inventory;
    const budgets = new RunBudgets(policy);
    const controller = opt.controller === 'scripted' ? createScriptedController(JSON.parse(readFileSync(resolve(opt.script), 'utf8')))
      : opt.controller === 'priority' ? createPriorityController(inventory, policy)
        : opt.controller === 'adaptive' ? createAdaptiveController(inventory, policy)
          : opt.controller === 'meta' ? createMetaController(inventory, policy, {
            callModel: ({ prompt }) => callModel({ apiKey: process.env.MODEL_API_KEY, prompt }), // key stays in this process
            chargeModelCall: () => budgets.charge('modelCalls', 1, 'meta investigation call'),
          }) : null;
    if (opt.controller === 'meta') manifest.provider = { ...PROVIDER_CONFIG, model: process.env.META_MODEL || 'muse-spark-1.3', credentialPresent: Boolean(process.env.MODEL_API_KEY) };
    if (opt.script) manifest.script = { path: opt.script, sha256: sha256(resolve(opt.script)) };
    let latest = null;
    const history = [];
    const linkUp = (a, b) => latest?.links?.[linkBetween(topology, a, b).linkId]?.state === 'up';
    const backgroundRates = Object.fromEntries(inventory.background.map(s => [s.sourceId, s.scheduledBps]));
    const executor = new Executor({
      client: supervisor, now: nowMs, sleep, drainMs: 1000, verifyTimeoutMs: 3000, verifyPollMs: 200,
      currentRoutes: Object.fromEntries(inventory.essential.map(f => [f.flowId, { version: 0, path: inventory.reference[f.flowId].primary, ackPath: inventory.reference[f.flowId].ackPrimary }])),
      isPathFeasible: path => path.slice(1).every((node, i) => linkUp(path[i], node)),
      // Deterministic takeover when rollback is impossible: first candidate over links observed up.
      fallback: async flowId => {
        const flow = inventory.essential.find(f => f.flowId === flowId);
        const up = { ...topology, links: topology.links.filter(l => latest?.links?.[l.linkId]?.state === 'up') };
        const [path] = candidatePaths(up, flow.from, flow.to, 1);
        return path ? { path, ackPath: [...path].reverse(), controller: 'priority-fallback' } : null;
      },
      onProbeBytes: (bytes, why) => budgets.charge('incidentProbeBytes', bytes, `probe ${why}`),
    });
    const beliefs = new CapacityBeliefs(inventory); // supervisor's shared belief record, for forecasts
    let outstanding = null;
    let suppressUntil = 0; // after a rejection, wait before proposing again: every attempt is charged
    let proposalCount = 0;
    let downLinks = new Set();
    let lastUnavailable = '[]';
    const startAtMs = Math.ceil(nowMs()) + 1500;
    const traffic = await orchestrator.request('start_traffic', { startAtMs, stopAtMs: startAtMs + durationMs, tailMs: 2000 }, { timeoutMs: 10_000 });
    record('traffic_started', { startAtMs, stopAtMs: startAtMs + durationMs, ...traffic });
    manifest.trafficStartAtMs = startAtMs;

    // One supervisory step after each sample: age the latest observation on the supervisor clock, derive
    // rates, let the controller propose, and admit through the shared guard before any execution.
    const step = () => {
      if (!controller || !latest || outstanding || nowMs() < suppressUntil) return;
      const ageMs = nowMs() - latest.collectedAtMs;
      const view = { ...latest, ageMs, stale: ageMs > policy.limits.maxObservationAgeMs };
      const rates = deriveRates(history.filter(o => o.collectedAtMs >= latest.collectedAtMs - 4000));
      if (beliefs.updatedAtMs !== latest.collectedAtMs) beliefs.update(latest, rates);
      const services = Object.fromEntries(Object.entries(view.services).map(([id, v]) => [id, { ...v, ...rates.services[id] }]));
      const observation = { ...view, services };
      const nowDown = new Set(Object.entries(latest.links).filter(([, l]) => l.state !== 'up').map(([id]) => id));
      if ([...nowDown].some(id => !downLinks.has(id))) budgets.resetIncident(`links down: ${[...nowDown].join(',')}`);
      downLinks = nowDown;
      const intent = controller.decide({ observation, rates, routes: executor.currentRoutes, backgroundRates: { ...backgroundRates }, nowMs: nowMs(), trafficMs: nowMs() - startAtMs, remaining: budgets.remaining() });
      for (const e of controller.drainEvents?.() ?? []) record(`controller_${e.type}`, { controller: controller.name, ...e, atMs: e.atMs ?? nowMs() });
      const unavailable = JSON.stringify(controller.unavailable?.() ?? []);
      if (unavailable !== lastUnavailable) { record('service_unavailable', { controller: controller.name, flows: JSON.parse(unavailable), atMs: nowMs() }); lastUnavailable = unavailable; }
      if (controller.investigating?.() && session.state === 'observing') move('investigating', 'model call outstanding');
      if (controller.mode?.() === 'degraded' && session.state === 'observing') move('degraded', 'provider failure: deterministic control');
      if (controller.mode?.() === 'normal' && session.state === 'degraded') move('observing', 'investigator restored');
      if (JSON.parse(unavailable).length && session.state === 'observing') move('unavailable', `no path: ${JSON.parse(unavailable).join(',')}`);
      if (!JSON.parse(unavailable).length && session.state === 'unavailable') move('observing', 'path restored');
      if (!intent) { if (session.state === 'investigating' && !controller.investigating?.()) move('observing', 'investigation finished'); return; }
      move('proposed', intent.source ?? controller.name);
      const proposal = {
        version: 'ProposalV1', proposalId: intent.proposalId ?? `${controller.name}-${++proposalCount}`, runId, policyId, baseConfigRevision: latest.configRevision,
        observationSeq: latest.seq, observationAtMs: Math.floor(latest.collectedAtMs), expiresAtMs: Math.floor(latest.collectedAtMs) + policy.limits.proposalLifetimeMs, // integer ms: exact lifetime
        preconditions: intent.preconditions, actions: intent.actions, predicted: [], evidence: [`obs-${latest.seq}`],
      };
      const effective = Object.fromEntries(inventory.essential.map(f => [f.flowId, effectiveRoute(f, executor.currentRoutes[f.flowId], latest, inventory).path]));
      const transition = intent.transition && {
        capacityBps: intent.transition.capacityBps,
        flowRoutes: { ...effective, ...Object.fromEntries(inventory.background.map(s => [s.sourceId, backgroundPath(s, latest, topology)])) },
        flowRateBps: { ...Object.fromEntries(inventory.essential.map(f => [f.flowId, essentialDemandBps(f)])), ...Object.fromEntries(inventory.background.map(s => [s.sourceId, backgroundWireBps(s, backgroundRates[s.sourceId])])) },
      };
      // Forecast of the configuration the proposal would produce: advisory for conventional controllers.
      const nextRoutes = Object.fromEntries(inventory.essential.map(f => [f.flowId, effectiveRoute(f, executor.currentRoutes[f.flowId], latest, inventory)]));
      const nextRates = { ...backgroundRates };
      for (const a of proposal.actions) {
        if (a.type === 'set_route') nextRoutes[a.flowId] = { version: 1, path: a.path, ackPath: a.ackPath };
        if (a.type === 'set_background_rate') nextRates[a.sourceId] = a.bitsPerSecond;
      }
      const predicted = forecast({ inventory, beliefs, routes: nextRoutes, rates: nextRates, observation: latest });
      const decision = { ...admitProposal(proposal, { runId, configRevision: latest.configRevision, nowMs: nowMs(), policy, policyId, topology, observation, budgets, transition }), forecastId: predicted.forecastId };
      record('decision', { controller: controller.name, source: intent.source ?? controller.name, rationale: intent.rationale, modelTrace: intent.modelTrace, proposal, decision,
        forecast: { status: predicted.status, beliefRevision: beliefs.revision, flows: predicted.flows?.map(f => ({ flowId: f.flowId, predictedOnTime: f.predictedOnTime, peakUtilization: f.peakUtilization })), nominalAssumed: predicted.nominalAssumed } });
      move('evaluating', 'guard and forecast');
      if (!decision.admitted) { move('observing', `rejected ${decision.code}`); suppressUntil = nowMs() + 2000; controller.applied?.(proposal, { status: 'rejected', nowMs: nowMs() }); return; }
      move('executing', proposal.proposalId);
      outstanding = executor.execute(decision, proposal).then(result => {
        move('verifying', result.status);
        move(result.status === 'service_unavailable' ? 'unavailable' : 'observing', result.status);
        for (const r of result.receipts) for (const e of r.confirmedEffects) if (e.step === 'set_rate') backgroundRates[e.sourceId] = e.readBackBps;
        controller.applied?.(proposal, { ...result, nowMs: nowMs() });
        record('execution', { controller: controller.name, ...result });
      }).catch(error => record('execution_failed', { detail: error.message })).finally(() => { outstanding = null; });
    };

    const pending = faults.map(f => ({ ...f, due: startAtMs + f.atMs }));
    let lastSeq = 0;
    const endAt = traffic.listenUntilMs + 500;
    let nextSample = startAtMs;
    while (nowMs() < endAt) {
      for (const fault of pending.filter(f => !f.done && nowMs() >= f.due)) {
        fault.done = true;
        const { due, done, ...args } = fault;
        const result = await orchestrator.request('inject_fault', args);
        record('admin_fault', { fault: args, scheduledAtMs: due, appliedAtMs: result.appliedAtMs });
      }
      if (nowMs() >= nextSample) {
        nextSample += SAMPLE_MS;
        try {
          const raw = await supervisor.request('telemetry', { intervalMs: SAMPLE_MS }, { timeoutMs: 2000 });
          const admittedObs = admitObservation(raw, { runId, nowMs: nowMs(), lastSeq, maxAgeMs: policy.limits.maxObservationAgeMs });
          if (admittedObs.ok) { lastSeq = raw.seq; observations.push(admittedObs.observation); history.push(admittedObs.observation); latest = admittedObs.observation; }
          else record('observation_rejected', { code: admittedObs.code });
        } catch (error) { record('telemetry_failed', { code: error.code, detail: error.detail }); }
        step();
      }
      await sleep(Math.max(5, Math.min(50, nextSample - nowMs())));
    }
    if (outstanding) await outstanding;
    for (const e of controller?.drainEvents?.() ?? []) record(`controller_${e.type}`, { controller: controller.name, ...e, atMs: e.atMs ?? nowMs() });
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
    const summary = { runId, ...scoreRun(rawDir, full, epochNs, startAtMs, durationMs, faults), controllerViewAudit: { observations: observations.length, findings: audit } };
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
    if (manifest.terminal !== 'completed' || worker.exitCode !== 0) {
      // An interrupted worker may leave run-owned objects; remove only those carrying this run's tag.
      try { manifest.cleanup = JSON.parse(execFileSync('sudo', ['-n', 'python3', join(REPO, 'runtime/mininet/cleanup.py'), '--tag', opt.tag]).toString()); }
      catch (error) { manifest.cleanup = { error: String(error.message).slice(0, 200) }; }
    }
    manifest.endedAtUnixMs = Date.now();
    writeFileSync(join(out, 'worker.log'), workerLog);
    manifest.ledger = ledger.finalize();
    manifest.session = { finalState: session.state, transitions: session.history.length, violations: session.violations.length };
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const files = readdirSync(out, { recursive: true }).filter(n => !n.endsWith('checksums.txt')).map(n => join(out, n)).filter(p => !p.endsWith('/raw') && existsSync(p));
    writeFileSync(join(out, 'checksums.txt'), files.filter(p => { try { return readFileSync(p) && true; } catch { return false; } }).map(p => `${sha256(p)}  ${p.slice(out.length + 1)}`).join('\n') + '\n');
  }
}

await main();
