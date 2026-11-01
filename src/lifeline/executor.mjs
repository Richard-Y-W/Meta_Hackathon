// Bounded executor: applies an admitted proposal's actions in order through the worker, records an
// effect only after the worker's read-back, reconciles lost replies by operation ID, verifies route
// changes with traffic counters, and compensates on failure. It never retries an effect under a new ID.

const TERMINAL_STOP = new Set(['failed', 'compensated', 'service_unavailable', 'unknown']);

class Unknown extends Error {}

export class Executor {
  constructor({ client, now, sleep, drainMs = 1000, verifyTimeoutMs = 3000, verifyPollMs = 200, currentRoutes, isPathFeasible, fallback, onProbeBytes = () => {} }) {
    Object.assign(this, { client, now, sleep, drainMs, verifyTimeoutMs, verifyPollMs, isPathFeasible, fallback, onProbeBytes });
    this.currentRoutes = currentRoutes; // flowId -> {version, path, ackPath}, as installed
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  async execute(decision, proposal) {
    if (!decision?.admitted || decision.proposalId !== proposal?.proposalId) {
      return { status: 'not_executed', code: decision?.admitted ? 'proposal_mismatch' : decision?.code ?? 'action_rejected', receipts: [] };
    }
    this.cancelled = false;
    const receipts = [];
    let stopped = false;
    for (const action of proposal.actions) {
      if (stopped || this.cancelled) {
        receipts.push(this.#receipt(proposal.proposalId, action, { status: 'not_started', detail: this.cancelled ? 'cancelled' : 'prior_action_incomplete' }));
        continue;
      }
      const receipt = await this.#run(proposal.proposalId, action);
      receipts.push(receipt);
      if (TERMINAL_STOP.has(receipt.status)) stopped = true;
    }
    const statuses = receipts.map(r => r.status);
    const status = statuses.includes('unknown') ? 'unknown'
      : statuses.includes('service_unavailable') ? 'service_unavailable'
        : statuses.includes('compensated') ? 'compensated'
          : statuses.includes('failed') ? 'failed'
            : statuses.includes('not_started') ? 'cancelled' : 'confirmed';
    return { status, receipts, requiresReconciliation: status === 'unknown', proposalId: proposal.proposalId };
  }

  #receipt(proposalId, action, fields = {}) {
    return {
      version: 'ActionReceiptV1', operationId: `${proposalId}:${action.actionId}`, actionId: action.actionId, type: action.type,
      startedAtMs: null, endedAtMs: null, status: 'pending', attemptedEffects: [], confirmedEffects: [], reconciled: [],
      resultingConfigRevision: null, compensation: null, ...fields,
    };
  }

  // One worker step. A timeout is resolved by looking up the operation; an effect that never happened is
  // retried once under the same operation ID; a vanished worker leaves the effect unknown.
  async #call(cmd, args, step, receipt) {
    try {
      return await this.client.request(cmd, args);
    } catch (error) {
      if (error.code === 'worker_unavailable' && error.detail === 'timeout') {
        let prior;
        try { prior = await this.client.request('operation', { operationId: args.operationId }); } catch { throw new Unknown(step); }
        receipt.reconciled.push(step);
        if (prior.status !== 'unknown') return prior;
        try { return await this.client.request(cmd, args); } catch { throw new Unknown(step); }
      }
      if (error.code === 'worker_unavailable') throw new Unknown(step);
      return { status: 'failed', detail: error.detail ?? 'worker_rejected' };
    }
  }

  async #run(proposalId, action) {
    const receipt = this.#receipt(proposalId, action, { startedAtMs: this.now() });
    try {
      if (action.type === 'set_route') await this.#route(receipt, action);
      else if (action.type === 'set_background_rate') await this.#rate(receipt, action);
      else if (action.type === 'probe_path') await this.#probe(receipt, action);
      else if (action.type === 'retain_policy') receipt.status = 'confirmed';
      else Object.assign(receipt, { status: 'failed', detail: 'unsupported_action' });
    } catch (error) {
      if (!(error instanceof Unknown)) throw error;
      Object.assign(receipt, { status: 'unknown', detail: 'worker_unavailable', unknownStep: error.message });
    }
    receipt.endedAtMs = this.now();
    return receipt;
  }

  async #rate(receipt, action) {
    const result = await this.#call('set_rate', { operationId: `${receipt.operationId}:set_rate`, sourceId: action.sourceId, bitsPerSecond: action.bitsPerSecond }, 'set_rate', receipt);
    receipt.attemptedEffects.push({ step: 'set_rate', sourceId: action.sourceId, bitsPerSecond: action.bitsPerSecond });
    if (result.status !== 'applied' || result.readBackBps !== action.bitsPerSecond) {
      Object.assign(receipt, { status: 'failed', detail: result.status === 'applied' ? 'verification_failed' : result.detail });
      return;
    }
    receipt.confirmedEffects.push({ step: 'set_rate', sourceId: result.sourceId, priorBps: result.priorBps, appliedBps: result.appliedBps, readBackBps: result.readBackBps });
    receipt.status = 'confirmed';
  }

  // A probe is measurement, not configuration: completion with loss is still a confirmed result.
  async #probe(receipt, action) {
    const op = `${receipt.operationId}:probe`;
    const { sourceId, destinationId, packetCount, payloadBytes, intervalMs, path } = action;
    const started = await this.#call('probe', { operationId: op, sourceId, destinationId, packetCount, payloadBytes, intervalMs, ...(path ? { path } : {}) }, 'probe', receipt);
    if (started.status !== 'started' && started.status !== 'complete') return Object.assign(receipt, { status: 'failed', detail: started.detail ?? 'probe_rejected' });
    receipt.attemptedEffects.push({ step: 'probe', path: started.path, packetCount, payloadBytes });
    const deadline = this.now() + packetCount * intervalMs + 4000;
    let result = started;
    while (result.status !== 'complete' && result.status !== 'failed' && this.now() < deadline) {
      await this.sleep(250);
      try { result = await this.client.request('probe_result', { operationId: op }); }
      catch (error) { if (error.code === 'worker_unavailable') throw new Unknown('probe'); throw error; }
    }
    if (result.status !== 'complete') {
      this.onProbeBytes(packetCount * payloadBytes, receipt.operationId); // unknown delivery: charge what was planned
      return Object.assign(receipt, { status: 'failed', detail: result.status === 'failed' ? result.detail : 'probe_timeout' });
    }
    this.onProbeBytes(result.bytesSent, receipt.operationId);
    receipt.measurement = {
      sent: result.sent, received: result.received, lossFraction: result.sent ? 1 - result.received / result.sent : null,
      rttMs: result.rttMs, path: result.path, bytesSent: result.bytesSent, bytesEchoed: result.bytesEchoed,
    };
    receipt.confirmedEffects.push({ step: 'probe', path: result.path });
    receipt.status = 'confirmed';
  }

  async #install(receipt, flowId, path, ackPath, tag) {
    const op = `${receipt.operationId}:${tag}`;
    const prep = await this.#call('prepare_route', { operationId: `${op}prepare`, flowId, path, ackPath }, `${tag}prepare`, receipt);
    receipt.attemptedEffects.push(...(prep.effects ?? []));
    if (prep.status !== 'prepared') {
      const abort = prep.version !== undefined ? await this.#call('abort_route', { operationId: `${op}abort`, flowId, version: prep.version }, `${tag}abort`, receipt) : null;
      return { ok: false, detail: prep.detail, compensation: { outcome: abort?.status === 'aborted' ? 'aborted' : 'abort_incomplete', remaining: abort?.remaining ?? null } };
    }
    receipt.confirmedEffects.push({ step: `${tag}prepare`, version: prep.version });
    const commit = await this.#call('commit_route', { operationId: `${op}commit`, flowId, version: prep.version }, `${tag}commit`, receipt);
    if (commit.status !== 'committed') {
      return { ok: false, detail: commit.detail, version: prep.version, partial: commit.status === 'partial', configRevision: commit.configRevision };
    }
    receipt.confirmedEffects.push({ step: `${tag}commit`, version: prep.version, configRevision: commit.configRevision });
    receipt.resultingConfigRevision = commit.configRevision;
    return { ok: true, version: prep.version };
  }

  async #verify(flowId, version, lastSwitch) {
    const read = async () => {
      try { return (await this.client.request('verify_route', { flowId, version })).packets[lastSwitch] ?? 0; }
      catch (error) { if (error.code === 'worker_unavailable') throw new Unknown('verify'); throw error; }
    };
    const baseline = await read();
    const started = this.now();
    while (this.now() - started < this.verifyTimeoutMs) {
      await this.sleep(this.verifyPollMs);
      const packets = await read();
      if (packets > baseline) return { ok: true, packets: packets - baseline };
    }
    return { ok: false };
  }

  async #route(receipt, action) {
    const { flowId, path, ackPath } = action;
    const previous = this.currentRoutes[flowId];
    if (!previous) return Object.assign(receipt, { status: 'failed', detail: 'unknown_current_route' });
    const installed = await this.#install(receipt, flowId, path, ackPath, '');
    if (!installed.ok) {
      if (installed.compensation) return Object.assign(receipt, { status: 'failed', detail: installed.detail, compensation: installed.compensation });
      // Commit failed: if any part switched, point the ingress back first; then remove the new version.
      const restored = installed.partial ? await this.#call('commit_route', { operationId: `${receipt.operationId}:rollback`, flowId, version: previous.version }, 'rollback', receipt) : null;
      const abort = await this.#call('abort_route', { operationId: `${receipt.operationId}:abort`, flowId, version: installed.version }, 'abort', receipt);
      return Object.assign(receipt, {
        status: installed.partial ? 'compensated' : 'failed', detail: installed.detail,
        compensation: { outcome: installed.partial ? (restored?.status === 'committed' ? 'rolled_back' : 'rollback_failed') : 'aborted', remaining: abort.remaining ?? null },
      });
    }
    const verified = await this.#verify(flowId, installed.version, path.at(-1));
    if (!verified.ok) return this.#compensate(receipt, action, previous, installed.version);
    receipt.confirmedEffects.push({ step: 'verify', packets: verified.packets });
    await this.sleep(this.drainMs); // in-flight packets on the old version drain before its rules go
    const retire = await this.#call('retire_route', { operationId: `${receipt.operationId}:retire`, flowId, version: previous.version }, 'retire', receipt);
    if (retire.status === 'retired') receipt.confirmedEffects.push({ step: 'retire', version: previous.version });
    else receipt.retireIncomplete = { version: previous.version, remaining: retire.remaining ?? null };
    this.currentRoutes[flowId] = { version: installed.version, path, ackPath };
    receipt.status = 'confirmed';
  }

  async #compensate(receipt, action, previous, failedVersion) {
    const { flowId } = action;
    receipt.detail = 'verification_failed';
    if (this.isPathFeasible(previous.path) && this.isPathFeasible(previous.ackPath)) {
      const back = await this.#call('commit_route', { operationId: `${receipt.operationId}:rollback`, flowId, version: previous.version }, 'rollback', receipt);
      if (back.status === 'committed') {
        await this.#call('abort_route', { operationId: `${receipt.operationId}:abort`, flowId, version: failedVersion }, 'abort', receipt);
        receipt.resultingConfigRevision = back.configRevision ?? receipt.resultingConfigRevision;
        return Object.assign(receipt, { status: 'compensated', compensation: { outcome: 'rolled_back', version: previous.version } });
      }
    }
    // Literal rollback is impossible: ask the deterministic controller for a new feasible policy.
    const plan = await this.fallback(flowId);
    if (plan) {
      const installed = await this.#install(receipt, flowId, plan.path, plan.ackPath, 'fallback-');
      if (installed.ok) {
        this.currentRoutes[flowId] = { version: installed.version, path: plan.path, ackPath: plan.ackPath };
        return Object.assign(receipt, { status: 'compensated', compensation: { outcome: 'fallback_policy', controller: plan.controller, path: plan.path, version: installed.version } });
      }
    }
    return Object.assign(receipt, { status: 'service_unavailable', compensation: { outcome: 'service_unavailable', activeVersion: failedVersion } });
  }
}
