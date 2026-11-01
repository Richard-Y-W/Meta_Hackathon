import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../../src/lifeline/executor.mjs';
import { WorkerError } from '../../src/lifeline/worker-client.mjs';

// A fake worker client with an operation registry, so lost replies and retries can be reconciled.
function fakeClient({ prepare = () => ({ status: 'prepared', version: 1, effects: [{ switch: 'r5' }] }), commit, verifyPackets, dropReplyFor = new Set(), dieOn } = {}) {
  const ops = new Map();
  const applied = [];
  let packets = 0;
  let active = 0;
  const client = {
    requests: [],
    async request(cmd, args) {
      client.requests.push({ cmd, args });
      if (dieOn?.(cmd, args)) throw new WorkerError('worker_unavailable', 'exited');
      if (cmd === 'operation') return ops.get(args.operationId) ?? { operationId: args.operationId, status: 'unknown' };
      if (cmd === 'verify_route') { packets += verifyPackets?.() ?? 10; return { version: args.version, packets: { r3: packets } }; }
      if (cmd === 'control_state') return { configRevision: 1 + applied.filter(a => a.cmd === 'commit_route').length };
      if (ops.has(args.operationId)) return { ...ops.get(args.operationId), replayed: true };
      let outcome;
      if (cmd === 'prepare_route') outcome = prepare(args);
      else if (cmd === 'commit_route') { outcome = commit?.(args) ?? { status: 'committed', version: args.version, configRevision: 2, effects: [{ switch: 'r0', ingress: true }] }; if (outcome.status === 'committed') active = args.version; }
      else if (cmd === 'retire_route') outcome = { status: 'retired', version: args.version, remaining: 0 };
      else if (cmd === 'abort_route') outcome = { status: 'aborted', version: args.version, remaining: 0 };
      else if (cmd === 'set_rate') outcome = { status: 'applied', sourceId: args.sourceId, priorBps: 6_500_000, appliedBps: args.bitsPerSecond, readBackBps: args.bitsPerSecond };
      else throw new WorkerError('command_rejected', 'unknown_command');
      outcome = { ...outcome, operationId: args.operationId };
      ops.set(args.operationId, outcome);
      applied.push({ cmd, operationId: args.operationId });
      if (dropReplyFor.has(cmd)) { dropReplyFor.delete(cmd); throw new WorkerError('worker_unavailable', 'timeout'); }
      return { ...outcome, replayed: false };
    },
  };
  client.applied = applied;
  client.active = () => active;
  return client;
}

const decision = (o = {}) => ({ version: 'DecisionV1', proposalId: 'p-1', admitted: true, code: 'ok', ...o });
const routeAction = { actionId: 'a1', type: 'set_route', flowId: 'dispatch-clinic', path: ['r0', 'r5', 'r4', 'r3'], ackPath: ['r3', 'r4', 'r5', 'r0'] };
const rateAction = { actionId: 'a2', type: 'set_background_rate', sourceId: 'bulk-field', bitsPerSecond: 2_000_000 };
const proposal = (actions = [routeAction]) => ({ proposalId: 'p-1', actions });
const current = { 'dispatch-clinic': { version: 0, path: ['r0', 'r1', 'r2', 'r3'], ackPath: ['r3', 'r2', 'r1', 'r0'] } };

function executor(client, o = {}) {
  let t = 0;
  return new Executor({ client, now: () => t, sleep: async ms => { t += ms; }, drainMs: 500, verifyTimeoutMs: 1000, verifyPollMs: 100,
    currentRoutes: structuredClone(current), isPathFeasible: () => true, fallback: async () => null, ...o });
}

test('a rejected or mismatched decision produces no worker effect', async () => {
  const client = fakeClient();
  const ex = executor(client);
  const rejected = await ex.execute(decision({ admitted: false, code: 'configuration_stale' }), proposal());
  assert.equal(rejected.status, 'not_executed');
  const mismatched = await ex.execute(decision({ proposalId: 'p-other' }), proposal());
  assert.equal(mismatched.status, 'not_executed');
  assert.equal(client.requests.length, 0);
});

test('a route change is prepared, committed, verified with traffic, then the old version retired', async () => {
  const client = fakeClient();
  const result = await executor(client).execute(decision(), proposal());
  assert.equal(result.status, 'confirmed', JSON.stringify(result));
  assert.deepEqual(client.applied.map(a => a.cmd), ['prepare_route', 'commit_route', 'retire_route']);
  const [receipt] = result.receipts;
  assert.equal(receipt.version, 'ActionReceiptV1');
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.operationId, 'p-1:a1');
  assert.deepEqual(receipt.confirmedEffects.map(e => e.step), ['prepare', 'commit', 'verify', 'retire']);
  assert.equal(receipt.resultingConfigRevision, 2);
  assert.ok(receipt.endedAtMs >= receipt.startedAtMs + 500); // drain interval elapsed before retirement
});

test('prepare failure aborts partial effects and leaves the ingress untouched', async () => {
  const client = fakeClient({ prepare: () => ({ status: 'failed', detail: 'openflow_failed', version: 1, effects: [{ switch: 'r5' }] }) });
  const result = await executor(client).execute(decision(), proposal());
  assert.equal(result.status, 'failed');
  assert.deepEqual(client.applied.map(a => a.cmd), ['prepare_route', 'abort_route']);
  assert.equal(result.receipts[0].compensation.outcome, 'aborted');
  assert.deepEqual(result.receipts[0].attemptedEffects.map(e => e.switch), ['r5']);
});

test('an ingress-switch failure during commit is partial and compensated by aborting the new version', async () => {
  const client = fakeClient({ commit: () => ({ status: 'failed', detail: 'openflow_failed', effects: [] }) });
  const result = await executor(client).execute(decision(), proposal());
  assert.equal(result.status, 'failed');
  assert.equal(result.receipts[0].detail, 'openflow_failed');
  assert.ok(client.applied.some(a => a.cmd === 'abort_route'));
  assert.equal(client.active(), 0);
});

test('a successful effect with a lost reply is reconciled, not duplicated', async () => {
  const client = fakeClient({ dropReplyFor: new Set(['commit_route']) });
  const result = await executor(client).execute(decision(), proposal());
  assert.equal(result.status, 'confirmed', JSON.stringify(result));
  assert.equal(client.applied.filter(a => a.cmd === 'commit_route').length, 1);
  assert.ok(client.requests.some(r => r.cmd === 'operation' && r.args.operationId === 'p-1:a1:commit'));
  assert.equal(result.receipts[0].reconciled.includes('commit'), true);
});

test('a lost reply for an effect that never happened is retried under the same operation ID', async () => {
  const client = fakeClient();
  const original = client.request;
  let first = true;
  client.request = async (cmd, args) => {
    if (cmd === 'set_rate' && first) { first = false; client.requests.push({ cmd, args }); throw new WorkerError('worker_unavailable', 'timeout'); }
    return original(cmd, args);
  };
  const result = await executor(client).execute(decision(), proposal([rateAction]));
  assert.equal(result.status, 'confirmed', JSON.stringify(result));
  const sets = client.requests.filter(r => r.cmd === 'set_rate');
  assert.equal(sets.length, 2);
  assert.equal(new Set(sets.map(s => s.args.operationId)).size, 1);
  assert.equal(client.applied.filter(a => a.cmd === 'set_rate').length, 1);
});

test('a background rate change records prior, applied and read-back values', async () => {
  const result = await executor(fakeClient()).execute(decision(), proposal([rateAction]));
  const [receipt] = result.receipts;
  assert.equal(receipt.status, 'confirmed');
  assert.deepEqual(receipt.confirmedEffects[0], { step: 'set_rate', sourceId: 'bulk-field', priorBps: 6_500_000, appliedBps: 2_000_000, readBackBps: 2_000_000 });
});

test('verification timeout rolls back to the still-feasible previous version', async () => {
  const client = fakeClient({ verifyPackets: () => 0 });
  const result = await executor(client).execute(decision(), proposal());
  assert.equal(result.status, 'compensated');
  const [receipt] = result.receipts;
  assert.equal(receipt.detail, 'verification_failed');
  assert.equal(receipt.compensation.outcome, 'rolled_back');
  assert.deepEqual(client.applied.filter(a => a.cmd === 'commit_route').length, 2);
  assert.equal(client.active(), 0);
  assert.equal(client.applied.some(a => a.cmd === 'retire_route' && a.operationId.endsWith(':retire')), false); // old version kept
});

test('when rollback is impossible, the deterministic fallback establishes a new policy or service is reported unavailable', async () => {
  const infeasible = { isPathFeasible: path => !path.includes('r2') }; // an additional failure took out the old path
  const viaFallback = await executor(fakeClient({ verifyPackets: () => 0 }), {
    ...infeasible, fallback: async () => ({ path: ['r0', 'r3'], ackPath: ['r3', 'r0'], controller: 'priority' }),
  }).execute(decision(), proposal());
  assert.equal(viaFallback.receipts[0].compensation.outcome, 'fallback_policy');
  assert.equal(viaFallback.receipts[0].compensation.controller, 'priority');
  const unavailable = await executor(fakeClient({ verifyPackets: () => 0 }), infeasible).execute(decision(), proposal());
  assert.equal(unavailable.status, 'service_unavailable');
  assert.equal(unavailable.receipts[0].compensation.outcome, 'service_unavailable');
});

test('cancellation stops new actions; the started action finishes', async () => {
  const client = fakeClient();
  const ex = executor(client);
  const originalRequest = client.request;
  client.request = async (cmd, args) => { const r = await originalRequest(cmd, args); if (cmd === 'commit_route') ex.cancel(); return r; };
  const result = await ex.execute(decision(), proposal([routeAction, rateAction]));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.receipts[0].status, 'confirmed');
  assert.equal(result.receipts[1].status, 'not_started');
  assert.equal(client.applied.some(a => a.cmd === 'set_rate'), false);
});

test('worker exit mid-action leaves an unknown effect for reconciliation and starts nothing else', async () => {
  const client = fakeClient({ dieOn: cmd => cmd === 'commit_route' });
  const result = await executor(client).execute(decision(), proposal([routeAction, rateAction]));
  assert.equal(result.status, 'unknown');
  assert.equal(result.receipts[0].status, 'unknown');
  assert.equal(result.receipts[0].detail, 'worker_unavailable');
  assert.equal(result.receipts[1].status, 'not_started');
  assert.equal(result.requiresReconciliation, true);
});

test('retain_policy is confirmed without effects; unsupported probes are refused without a worker call', async () => {
  const client = fakeClient();
  const result = await executor(client).execute(decision(), proposal([
    { actionId: 'a1', type: 'retain_policy', reasonCode: 'insufficient_evidence' },
    { actionId: 'a2', type: 'probe_path', sourceId: 'dispatch', destinationId: 'clinic', packetCount: 4, payloadBytes: 100, intervalMs: 10 },
  ]));
  assert.equal(result.receipts[0].status, 'confirmed');
  assert.equal(result.receipts[1].status, 'failed');
  assert.equal(result.receipts[1].detail, 'unsupported_action');
  assert.equal(client.requests.length, 0);
});

test('two successive route updates each retire their predecessor', async () => {
  const client = fakeClient({ prepare: (() => { let v = 0; return () => ({ status: 'prepared', version: ++v, effects: [] }); })() });
  const ex = executor(client);
  await ex.execute(decision(), proposal());
  const second = { ...routeAction, actionId: 'a9', path: ['r0', 'r1', 'r2', 'r3'], ackPath: ['r3', 'r2', 'r1', 'r0'] };
  const result = await ex.execute(decision({ proposalId: 'p-2' }), { proposalId: 'p-2', actions: [second] });
  assert.equal(result.status, 'confirmed');
  const retired = client.requests.filter(r => r.cmd === 'retire_route').map(r => r.args.version);
  assert.deepEqual(retired, [0, 1]);
  assert.deepEqual(ex.currentRoutes['dispatch-clinic'].path, ['r0', 'r1', 'r2', 'r3']);
});

test('worker exit during verification is an unknown effect, not an exception', async () => {
  const client = fakeClient({ dieOn: cmd => cmd === 'verify_route' });
  const result = await executor(client).execute(decision(), proposal());
  assert.equal(result.status, 'unknown');
  assert.equal(result.receipts[0].unknownStep, 'verify');
});
