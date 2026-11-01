// Power domain adapter: typed infra-contract-v1 envelopes over the pandapower worker
// (runtime/infra/power_pandapower.py). The worker keeps checkpoints and the admitted model; this side
// sees only handles and hashes, so a controller cannot read the hidden fault schedule from them.
import { join } from 'node:path';
import { CONTRACT, validateEnvelope } from '../kernel/contracts.mjs';
import { scoreService } from '../kernel/measurement.mjs';
import { spawnStdioWorker } from '../kernel/stdio-worker.mjs';

const DOMAIN = 'power';
const OPERATIONS = { describe: true, initialize: true, observe: true, preview: true, validate: true, execute: true, readback: true, checkpoint: true, restore: true, advance: true, close: true };
const LIMITATIONS = [
  'Balanced steady-state AC power flow at discrete steps; no transients, protection coordination, black start or switching surges.',
  'Islands without a slack source are unsupplied; storage is grid-following and lossless within its declared capacity.',
  'A load level beyond loadability or a numerical failure yields no solution; service is then missing, never full.',
  'preview forks the admitted model (current configuration, no fault schedule), not the evaluated plant.',
];
const CAPABILITIES = {
  set_switch: { parameters: { switchId: 'id', closed: 'bool' }, durationUs: 100_000, effectChecks: ['switch_state_read_back'] },
  set_load_connected: { parameters: { loadId: 'id', connected: 'bool' }, durationUs: 100_000, effectChecks: ['load_power_read_back'] },
  set_storage_power: { parameters: { storageId: 'id', dischargeW: 'W' }, durationUs: 1_000_000, effectChecks: ['storage_power_read_back'] },
};
const CROSS_CHECK_J = 1; // the Python and Node scorers integrate the same samples independently

export function spawnPowerWorker({ python, root, timeoutMs = 60_000 }) {
  return spawnStdioWorker({
    command: python, args: [join(root, 'runtime/infra/power_pandapower.py'), 'serve'], cwd: root, timeoutMs,
    env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(root, '.work/cache/matplotlib'), TMPDIR: join(root, '.work/tmp'), PYTHONDONTWRITEBYTECODE: '1' },
  });
}

const envelope = (runId, sequence, tickUs, kind, fields) => ({ schemaVersion: CONTRACT.schemaVersion, runId, domainId: DOMAIN, sequence, tickUs, kind, ...fields });

export function createPowerAdapter({ worker }) {
  let state = 'created', ctx = null, sequence = 0;

  const capabilities = runId => Object.entries(CAPABILITIES).map(([actionType, c]) => envelope(runId ?? 'unbound', 0, 0, 'capability', {
    capabilityId: `power.${actionType}`, actionType, parameters: c.parameters, assets: [DOMAIN], authorityModes: ['recommend', 'approve_each', 'bounded_auto'],
    limits: {}, expectedDurationUs: c.durationUs, reversible: true, effectChecks: c.effectChecks,
  }));
  const gate = () => (state === 'closed' ? { ok: false, code: 'adapter_closed' } : state !== 'ready' ? { ok: false, code: 'not_initialized' } : null);
  const call = async (cmd, args) => {
    try { return { ok: true, result: await worker.request(cmd, args) }; } catch (error) { return { ok: false, code: error.code ?? 'worker_unavailable', detail: error.detail }; }
  };

  function toWorkerAction(action) {
    const env = validateEnvelope(action, { runId: ctx.runId, capabilities: capabilities(ctx.runId) });
    if (!env.ok) return env;
    const revision = action.preconditions.find(p => p.type === 'configuration_revision' && p.domainId === DOMAIN)?.revision;
    if (!Number.isInteger(revision)) return { ok: false, code: 'missing_revision_precondition' };
    return { ok: true, action: { actionId: action.actionId, type: action.capabilityId.replace(/^power\./, ''), params: action.parameters, baseRevision: revision } };
  }

  return {
    describe: () => ({ domainId: DOMAIN, schemaVersion: CONTRACT.schemaVersion, operations: { ...OPERATIONS }, limitations: [...LIMITATIONS], capabilities: capabilities(ctx?.runId) }),

    async initialize({ runId, network, faults = [], stepUs }) {
      if (state === 'closed') return { ok: false, code: 'adapter_closed' };
      const r = await call('initialize', { runId, network, faults, ...(stepUs ? { stepUs } : {}) });
      if (!r.ok) return r;
      ctx = { runId, networkId: r.result.networkId, modelVersion: r.result.modelVersion };
      state = 'ready';
      return { ok: true, code: 'ok', modelVersion: r.result.modelVersion };
    },

    async observe() {
      const blocked = gate();
      if (blocked) return blocked;
      const r = await call('observe', {});
      if (!r.ok) return r;
      const { atUs, configurationRevision, readings } = r.result;
      const observations = readings.map(x => envelope(ctx.runId, ++sequence, atUs, 'observation', {
        observationId: `obs-${atUs}-${x.sensorId}`, assetId: x.assetId, metric: x.metric,
        quantity: x.value === null ? { value: null, unit: x.unit, missingReason: x.missingReason } : { value: x.value, unit: x.unit },
        observedAtUs: atUs, receivedAtUs: atUs, quality: x.value === null ? 'missing' : 'good', sourceId: `sensor:${x.sensorId}`, configurationRevision,
      }));
      for (const o of observations) {
        const v = validateEnvelope(o, { runId: ctx.runId });
        if (!v.ok) return { ok: false, code: 'observation_rejected', detail: `${o.observationId}:${v.code}` };
      }
      return { ok: true, observations, configurationRevision, solveStatus: r.result.solveStatus };
    },

    async preview(plan, modelSnapshot) {
      const blocked = gate();
      if (blocked) return blocked;
      const model = modelSnapshot ?? (await call('admitted_model', {}));
      if (model.ok === false) return model;
      const modelId = model.modelId ?? model.result.modelId;
      const r = await call('preview', { plan, modelId });
      if (!r.ok) return r;
      const p = r.result;
      const revision = (await call('observe', {})).result?.configurationRevision ?? null;
      const forecast = envelope(ctx.runId, ++sequence, 0, 'forecast', {
        forecastId: `fc-${p.modelHash.slice(0, 16)}-${sequence}`, originObservations: [], originHash: p.modelHash, configurationRevisions: { [DOMAIN]: revision },
        modelVersion: p.modelVersion, horizonUs: p.horizonUs,
        outcomes: { essentialUnservedJ: p.essential_unserved_j, essentialDemandJ: p.essential_demand_j, status: p.status, solveStatuses: p.solveStatuses, constraintEvents: p.constraintEvents },
        assumptions: ['admitted model: current configuration and storage, no fault schedule', 'demand held at current level over the horizon'], supportStatus: 'admitted_model',
      });
      const v = validateEnvelope(forecast, { runId: ctx.runId });
      return v.ok ? { ok: true, forecast } : { ok: false, code: 'forecast_rejected', detail: v.code };
    },

    async validate(action) {
      const blocked = gate();
      if (blocked) return blocked;
      const mapped = toWorkerAction(action);
      if (!mapped.ok) return mapped;
      const r = await call('validate', { action: mapped.action });
      return r.ok ? r.result : r;
    },

    async execute(action) {
      const blocked = gate();
      if (blocked) return blocked;
      const mapped = toWorkerAction(action);
      let raw;
      if (!mapped.ok) raw = { actionId: action.actionId, status: 'rejected', reason: mapped.code, requestedAtUs: 0, startedAtUs: null, completedAtUs: null, actualSettings: [] };
      else {
        const r = await call('execute', { action: mapped.action });
        raw = r.ok ? r.result : { actionId: action.actionId, status: 'unknown', reason: r.code, requestedAtUs: 0, startedAtUs: null, completedAtUs: null, actualSettings: [] };
      }
      const receipt = envelope(ctx.runId, ++sequence, raw.requestedAtUs, 'receipt', {
        actionId: raw.actionId, requestedAtUs: raw.requestedAtUs, startedAtUs: raw.startedAtUs, completedAtUs: raw.completedAtUs,
        actualSettings: raw.actualSettings, observedEffects: [], status: raw.status, reason: raw.reason,
      });
      return { ok: raw.status === 'success', receipt, ...(raw.duplicate ? { duplicate: true } : {}) };
    },

    async readback(actionId) {
      const blocked = gate();
      if (blocked) return blocked;
      const r = await call('readback', { actionId });
      if (!r.ok) return r;
      const raw = r.result;
      return { ok: true, receipt: envelope(ctx.runId, sequence, raw.requestedAtUs, 'receipt', {
        actionId: raw.actionId, requestedAtUs: raw.requestedAtUs, startedAtUs: raw.startedAtUs, completedAtUs: raw.completedAtUs,
        actualSettings: raw.actualSettings, observedEffects: [], status: raw.status, reason: raw.reason }) };
    },

    async checkpoint() {
      const blocked = gate();
      if (blocked) return blocked;
      const r = await call('checkpoint', {});
      return r.ok ? { ok: true, ...r.result } : r;
    },

    async restore(checkpoint) {
      const blocked = gate();
      if (blocked) return blocked;
      const r = await call('restore', { checkpointId: checkpoint.checkpointId });
      return r.ok ? { ok: true, ...r.result } : r;
    },

    async advance(toTickUs) {
      const blocked = gate();
      if (blocked) return blocked;
      const r = await call('advance', { toUs: toTickUs });
      return r.ok ? { ok: true, ...r.result } : r;
    },

    async close() {
      if (state === 'closed') return { ok: true };
      state = 'closed';
      await worker.shutdown();
      return { ok: true };
    },

    // Evaluator only: private service record from the worker, scored by both the Python reference scorer
    // and the Node kernel scorer; disagreement beyond CROSS_CHECK_J fails the cross-check.
    async measure() {
      const blocked = gate();
      if (blocked) return blocked;
      const r = await call('service_record', {});
      if (!r.ok) return r;
      const { cases, summary, record } = r.result;
      const disagreements = [];
      const measurements = Object.entries(cases).map(([loadId, c], i) => {
        const node = scoreService(c);
        const py = summary.byLoad[loadId];
        if (node.status !== py.status || Math.abs(node.demandIntegral - py.demandJ) > CROSS_CHECK_J || Math.abs(node.servedIntegral - py.servedJ) > CROSS_CHECK_J) disagreements.push(loadId);
        return envelope(ctx.runId, i + 1, c.toUs, 'measurement', {
          measurementId: `meas-${loadId}`, serviceId: loadId, workloadRef: `${record.networkId}:demand`, demanded: { value: node.demandIntegral, unit: 'J' },
          supplied: { value: node.servedIntegral, unit: 'J' }, fromUs: c.fromUs, toUs: c.toUs, missingStatus: node.status === 'scored' ? 'complete' : 'capture_incomplete', provenance: 'power-ledger-v1',
        });
      });
      return { ok: true, measurements, cases, summary, essential: record.essential, crossCheck: { ok: disagreements.length === 0, disagreements, toleranceJ: CROSS_CHECK_J } };
    },
  };
}
