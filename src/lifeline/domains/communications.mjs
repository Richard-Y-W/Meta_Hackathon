// Communications domain adapter: the qualified V1 network runtime behind the common infrastructure
// interface. Semantics are V1's own (contract validation, guarded executor, receipt scorer); unsupported
// operations are reported as unsupported, never as success.
import { join } from 'node:path';
import { CONTRACT, validateEnvelope } from '../kernel/contracts.mjs';
import { msToUs } from '../kernel/clock.mjs';
import { canonicalRecord } from '../identity.mjs';
import { validateProposal } from '../contracts.mjs';
import { Executor } from '../executor.mjs';
import { readEvents } from '../ledger.mjs';
import { scoreRun } from '../run-score.mjs';
import { buildInventory, candidatePaths, linkBetween } from '../controllers/common.mjs';

const DOMAIN = 'communications';
const OPERATIONS = { describe: true, initialize: true, observe: true, preview: true, validate: true, execute: true, readback: true, checkpoint: false, restore: false, advance: false, close: true };
const LIMITATIONS = [
  'Real-time packet emulation: no checkpoint/restore or forked counterfactual branches; experiments that require branching cannot use this adapter.',
  'advance is wall-clock: the network runs continuously and cannot be stepped.',
  'preview uses the bounded capacity forecast (forecast-v1), not the emulated network.',
];
const CAPABILITY_PARAMS = {
  set_route: { flowId: 'id', path: 'node_path', ackPath: 'node_path' },
  set_background_rate: { sourceId: 'id', bitsPerSecond: 'bit/s' },
  probe_path: { sourceId: 'id', destinationId: 'id', packetCount: 'count', payloadBytes: 'B', intervalMs: 'ms', path: 'node_path' },
  retain_policy: { reasonCode: 'id' },
};

const envelope = (runId, sequence, tickUs, kind, fields) => ({ schemaVersion: CONTRACT.schemaVersion, runId, domainId: DOMAIN, sequence, tickUs, kind, ...fields });

export function createCommunicationsAdapter({ client, now = () => 0, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let state = 'created';
  let ctx = null;
  let sequence = 0;
  let latest = null;
  const receipts = new Map();

  const capabilities = runId => Object.entries(CAPABILITY_PARAMS).map(([actionType, parameters]) => envelope(runId ?? 'unbound', 0, 0, 'capability', {
    capabilityId: `comms.${actionType}`, actionType, parameters, assets: ['network'], authorityModes: ['recommend', 'approve_each', 'bounded_auto'],
    limits: actionType === 'probe_path' ? { maxPackets: 64, maxBytes: 65536 } : {}, expectedDurationUs: actionType === 'set_route' ? 3_000_000 : 1_000_000,
    reversible: actionType !== 'probe_path', effectChecks: actionType === 'set_route' ? ['traffic_on_new_version', 'old_version_retired'] : actionType === 'set_background_rate' ? ['rate_read_back'] : [],
  }));

  const gate = () => (state === 'closed' ? { ok: false, code: 'adapter_closed' } : state !== 'ready' ? { ok: false, code: 'not_initialized' } : null);

  function toProposal(action) {
    const { flowId, path, ackPath, ...rest } = action.parameters;
    const type = action.capabilityId.replace(/^comms\./, '');
    const v1Action = { actionId: 'a1', type, ...(flowId !== undefined ? { flowId } : {}), ...(path !== undefined ? { path } : {}), ...(ackPath !== undefined ? { ackPath } : {}), ...rest };
    const seq = latest?.seq ?? 0;
    const atMs = Math.floor(latest?.collectedAtMs ?? now());
    return {
      version: 'ProposalV1', proposalId: action.actionId, runId: ctx.runId, policyId: ctx.policyId, baseConfigRevision: latest?.configRevision ?? ctx.configRevision,
      observationSeq: seq, observationAtMs: atMs, expiresAtMs: atMs + ctx.policy.limits.proposalLifetimeMs, preconditions: [], actions: [v1Action], predicted: [], evidence: [`obs-${seq}`],
    };
  }

  async function validate(action) {
    const blocked = gate();
    if (blocked) return blocked;
    const env = validateEnvelope(action, { runId: ctx.runId, capabilities: capabilities(ctx.runId) });
    if (!env.ok) return env;
    const contract = validateProposal(toProposal(action), {
      runId: ctx.runId, configRevision: latest?.configRevision ?? ctx.configRevision, nowMs: Math.max(now(), latest?.collectedAtMs ?? 0), policy: ctx.policy, policyId: ctx.policyId,
      topology: ctx.inventory.topology, freshObservation: { seq: latest?.seq ?? 0, atMs: latest?.collectedAtMs ?? now() }, budgets: { remainingBundles: 1, remainingIncidentProbeBytes: ctx.policy.limits.incidentProbeBytes },
    });
    return contract.ok ? { ok: true, code: 'ok' } : { ok: false, code: contract.code, detail: contract.detail };
  }

  return {
    describe: () => ({ domainId: DOMAIN, schemaVersion: CONTRACT.schemaVersion, operations: { ...OPERATIONS }, limitations: [...LIMITATIONS], capabilities: capabilities(ctx?.runId) }),

    async initialize({ runId, scenario, policy, configRevision = 1 }) {
      if (state === 'closed') return { ok: false, code: 'adapter_closed' };
      const { faults, ...publicScenario } = scenario; // the fault schedule never enters the adapter
      const inventory = buildInventory(publicScenario, policy);
      ctx = { runId, policy, policyId: canonicalRecord(policy).sha256, inventory, configRevision };
      const executor = new Executor({
        client, now, sleep, drainMs: 1000, verifyTimeoutMs: 3000, verifyPollMs: 200,
        currentRoutes: Object.fromEntries(inventory.essential.map(f => [f.flowId, { version: 0, path: inventory.reference[f.flowId].primary, ackPath: inventory.reference[f.flowId].ackPrimary }])),
        isPathFeasible: path => path.slice(1).every((n, i) => latest?.links?.[linkBetween(inventory.topology, path[i], n).linkId]?.state === 'up'),
        fallback: async flowId => {
          const flow = inventory.essential.find(f => f.flowId === flowId);
          const up = { ...inventory.topology, links: inventory.topology.links.filter(l => latest?.links?.[l.linkId]?.state === 'up') };
          const [path] = candidatePaths(up, flow.from, flow.to, 1);
          return path ? { path, ackPath: [...path].reverse(), controller: 'priority-fallback' } : null;
        },
      });
      ctx.executor = executor;
      state = 'ready';
      return { ok: true, code: 'ok' };
    },

    async observe() {
      const blocked = gate();
      if (blocked) return blocked;
      const raw = await client.request('telemetry', { intervalMs: 500 });
      latest = raw;
      const tickUs = msToUs(raw.collectedAtMs);
      const out = [];
      for (const [linkId, link] of Object.entries(raw.links)) {
        const base = { observedAtUs: tickUs, receivedAtUs: Math.max(tickUs, msToUs(now())), sourceId: 'ovs', configurationRevision: raw.configRevision };
        out.push(envelope(ctx.runId, ++sequence, tickUs, 'observation', { ...base, observationId: `obs-${raw.seq}-${linkId}-state`, assetId: linkId, metric: 'link.state', quantity: { value: link.state === 'up' ? 1 : 0, unit: 'state' }, quality: 'good' }));
        for (const [end, bytes] of Object.entries(link.txBytes ?? {})) {
          const missing = bytes === null || bytes === undefined;
          out.push(envelope(ctx.runId, ++sequence, tickUs, 'observation', {
            ...base, observationId: `obs-${raw.seq}-${linkId}-${end}-tx`, assetId: `${linkId}:${end}`, metric: 'comms.bytes',
            quantity: missing ? { value: null, unit: 'B', missingReason: 'counter_unreported' } : { value: bytes, unit: 'B' }, quality: missing ? 'missing' : 'good',
          }));
        }
      }
      return { ok: true, observations: out, configurationRevision: raw.configRevision };
    },

    async preview() {
      const blocked = gate();
      return blocked ?? { ok: false, code: 'preview_requires_coordinator', detail: 'forecast-v1 previews are run by the coordinator with beliefs (P04)' };
    },

    validate,

    async execute(action) {
      const blocked = gate();
      if (blocked) return blocked;
      if (receipts.has(action.actionId)) return { ok: true, duplicate: true, receipt: receipts.get(action.actionId) };
      const requestedAtUs = msToUs(now());
      const verdict = await validate(action);
      let status, reason, startedAtUs = null, completedAtUs = null, actualSettings = [], observedEffects = [];
      if (!verdict.ok) { status = 'rejected'; reason = verdict.detail ? `${verdict.code}/${verdict.detail}` : verdict.code; }
      else {
        const proposal = toProposal(action);
        const result = await ctx.executor.execute({ admitted: true, proposalId: proposal.proposalId }, proposal);
        const r = result.receipts[0];
        status = { confirmed: 'success', compensated: 'partial', service_unavailable: 'partial', unknown: 'unknown' }[r.status] ?? 'rejected';
        reason = r.detail ?? r.status;
        startedAtUs = r.startedAtMs === null ? null : msToUs(r.startedAtMs);
        completedAtUs = r.endedAtMs === null ? null : msToUs(r.endedAtMs);
        actualSettings = r.confirmedEffects;
        observedEffects = r.measurement ? [r.measurement] : [];
      }
      const receipt = envelope(ctx.runId, ++sequence, msToUs(now()), 'receipt', { actionId: action.actionId, requestedAtUs, startedAtUs, completedAtUs, actualSettings, observedEffects, status, reason });
      receipts.set(action.actionId, receipt);
      return { ok: status === 'success', receipt };
    },

    async readback(actionId) {
      const blocked = gate();
      if (blocked) return blocked;
      return receipts.has(actionId) ? { ok: true, receipt: receipts.get(actionId) } : { ok: false, code: 'unknown_action' };
    },

    checkpoint: async () => ({ ok: false, code: 'unsupported_operation', operation: 'checkpoint' }),
    restore: async () => ({ ok: false, code: 'unsupported_operation', operation: 'restore' }),
    advance: async () => ({ ok: false, code: 'unsupported_operation', operation: 'advance' }),

    async close() { state = 'closed'; receipts.clear(); return { ok: true }; },

    // Independent measurement from a retained bundle's raw sender/receiver records (the V1 receipt scorer).
    async measure({ bundleDir, manifest, scenario }) {
      const applied = readEvents(join(bundleDir, 'events.jsonl')).filter(e => e.type === 'admin_fault' || e.type === 'operator_fault').map(e => e.fault);
      const faults = (applied.length ? applied : scenario.faults).filter(f => f.atMs < manifest.durationMs);
      const score = scoreRun(join(bundleDir, 'raw'), scenario, BigInt(manifest.workerEpochMonotonicNs), manifest.trafficStartAtMs, manifest.durationMs, faults);
      const primary = score.results.primary;
      const fromUs = msToUs(score.windows.primary[0]), toUs = msToUs(score.windows.primary[1]);
      const measurements = Object.entries(primary.byFlow).map(([flowId, v], i) => envelope(manifest.runId, i + 1, toUs, 'measurement', {
        measurementId: `meas-${flowId}`, serviceId: flowId, workloadRef: manifest.scenario.sha256, demanded: { value: v.offered, unit: 'msg' },
        supplied: { value: v.onTime, unit: 'msg' }, fromUs, toUs, missingStatus: 'complete', provenance: 'receipt-scorer-v1',
      }));
      return { ok: true, score, measurements };
    },
  };
}
