// Water domain adapter: typed infra-contract-v1 envelopes over the EPANET/WNTR worker
// (runtime/infra/water_wntr.py, water environment). Same lifecycle and handle discipline as the power
// adapter: the worker keeps checkpoints and the admitted model; this side sees only handles and hashes.
import { join } from 'node:path';
import { CONTRACT, validateEnvelope } from '../kernel/contracts.mjs';
import { scoreService } from '../kernel/measurement.mjs';
import { spawnStdioWorker } from '../kernel/stdio-worker.mjs';

const DOMAIN = 'water';
const OPERATIONS = { describe: true, initialize: true, observe: true, preview: true, validate: true, execute: true, readback: true, checkpoint: true, restore: true, advance: true, close: true };
const LIMITATIONS = [
  'Distribution hydraulics only (EPANET 2.2 pressure-driven demand); no water-quality, treatment-plant or transient model.',
  'Restore and preview replay the applied-change history from the initial network; cost grows with elapsed simulated time.',
  'INP controls acting on declared actuators are removed; isolation is judged on the undirected graph of open links.',
  'preview forks the admitted model (current configuration, no fault schedule), not the evaluated plant.',
];
const CAPABILITIES = {
  set_pump: { parameters: { pumpId: 'id', on: 'bool' }, durationUs: 1_000_000, effectChecks: ['pump_state_read_back', 'pump_flow_read_back'] },
  set_link: { parameters: { linkId: 'id', open: 'bool' }, durationUs: 1_000_000, effectChecks: ['link_state_read_back'] },
};
const CROSS_CHECK_M3 = 1e-6; // the Python and Node scorers integrate the same samples independently

export function spawnWaterWorker({ python, root, timeoutMs = 60_000 }) {
  return spawnStdioWorker({
    command: python, args: [join(root, 'runtime/infra/water_wntr.py'), 'serve'], cwd: root, timeoutMs,
    env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(root, '.work/cache/matplotlib'), TMPDIR: join(root, '.work/tmp'), PYTHONDONTWRITEBYTECODE: '1' },
  });
}

const envelope = (runId, sequence, tickUs, kind, fields) => ({ schemaVersion: CONTRACT.schemaVersion, runId, domainId: DOMAIN, sequence, tickUs, kind, ...fields });

export function createWaterAdapter({ worker }) {
  let state = 'created', ctx = null, sequence = 0;

  const capabilities = runId => Object.entries(CAPABILITIES).map(([actionType, c]) => envelope(runId ?? 'unbound', 0, 0, 'capability', {
    capabilityId: `water.${actionType}`, actionType, parameters: c.parameters, assets: [DOMAIN], authorityModes: ['recommend', 'approve_each', 'bounded_auto'],
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
    return { ok: true, action: { actionId: action.actionId, type: action.capabilityId.replace(/^water\./, ''), params: action.parameters, baseRevision: revision } };
  }

  return {
    describe: () => ({ domainId: DOMAIN, schemaVersion: CONTRACT.schemaVersion, operations: { ...OPERATIONS }, limitations: [...LIMITATIONS], capabilities: capabilities(ctx?.runId) }),

    async initialize({ runId, network, faults = [], fixtureDir }) {
      if (state === 'closed') return { ok: false, code: 'adapter_closed' };
      const r = await call('initialize', { runId, network, faults, ...(fixtureDir ? { fixtureDir } : {}) });
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
      const { staleAfterUs } = r.result;
      const observations = readings.map(x => envelope(ctx.runId, ++sequence, atUs, 'observation', {
        observationId: `obs-${atUs}-${x.sensorId}`, assetId: x.assetId, metric: x.metric,
        quantity: x.value === null ? { value: null, unit: x.unit, missingReason: x.missingReason } : { value: x.value, unit: x.unit },
        observedAtUs: x.observedAtUs, receivedAtUs: atUs, quality: x.value === null ? 'missing' : atUs - x.observedAtUs > staleAfterUs ? 'stale' : 'good',
        sourceId: `sensor:${x.sensorId}`, configurationRevision,
      }));
      for (const o of observations) {
        const v = validateEnvelope(o, { runId: ctx.runId });
        if (!v.ok) return { ok: false, code: 'observation_rejected', detail: `${o.observationId}:${v.code}` };
      }
      return { ok: true, observations, configurationRevision, unavailableActuators: r.result.unavailableActuators };
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
        outcomes: { essentialUnmetM3: p.essential_unmet_m3, essentialRequiredM3: p.essential_required_m3, lowPressureSeconds: p.low_pressure_seconds, pumpEnergyJ: p.pump_energy_j, status: p.status, replaySeconds: p.replaySeconds },
        assumptions: ['admitted model: current configuration, tank levels and history, no fault schedule', 'demand follows the declared pattern schedule'], supportStatus: 'admitted_model',
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
    // and the Node kernel scorer; disagreement beyond CROSS_CHECK_M3 fails the cross-check.
    async measure() {
      const blocked = gate();
      if (blocked) return blocked;
      const r = await call('service_record', {});
      if (!r.ok) return r;
      const { cases, summary, record } = r.result;
      const disagreements = [];
      const measurements = Object.entries(cases).map(([nodeId, c], i) => {
        const node = scoreService(c);
        const py = summary.byNode[nodeId];
        if (node.status !== py.status || Math.abs(node.demandIntegral - py.requiredM3) > CROSS_CHECK_M3 || Math.abs(node.servedIntegral - py.deliveredM3) > CROSS_CHECK_M3) disagreements.push(nodeId);
        return envelope(ctx.runId, i + 1, c.toUs, 'measurement', {
          measurementId: `meas-${nodeId}`, serviceId: nodeId, workloadRef: `${record.networkId}:demand`, demanded: { value: node.demandIntegral, unit: 'm3' },
          supplied: { value: node.servedIntegral, unit: 'm3' }, fromUs: c.fromUs, toUs: c.toUs, missingStatus: node.status === 'scored' ? 'complete' : 'capture_incomplete', provenance: 'water-ledger-v1',
        });
      });
      return { ok: true, measurements, cases, summary, essential: record.essential, crossCheck: { ok: disagreements.length === 0, disagreements, toleranceM3: CROSS_CHECK_M3 } };
    },
  };
}
