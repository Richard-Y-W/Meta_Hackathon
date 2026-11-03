// Meta-assisted joint decisions (P14). The model receives only the admitted evidence packet and the
// capability catalog; its answer is parsed strictly and enters the same candidate pool and ranking as the
// conventional templates. Conventional control (the hybrid's rule layer) keeps acting while it works. The
// investigation is bounded by the remaining opportunity: the earliest predicted essential loss minus the
// longest actuation and a margin, converted to wall time through the clock mapping.
import { readFileSync } from 'node:fs';
import { CONTRACT } from '../kernel/contracts.mjs';
import { createModelStore } from '../kernel/model-store.mjs';
import { validateTimedPlan } from '../kernel/plans.mjs';
import { evaluatePlan, scenarioKey, searchPlans, templates } from '../kernel/planner.mjs';
import { strictJsonParse } from '../meta-provider.mjs';
import { CATALOG, priority } from './joint.mjs';

const S = 1_000_000;
const PROMPT = readFileSync(new URL('../../../fixtures/lifeline/infra/meta-prompt-v1.txt', import.meta.url), 'utf8');
export const PROMPT_VERSION = 'lifeline-joint-v1';
const HIDDEN = /^(fault(id|s|schedule)?|groundtruth|truth|hidden|oracle|injected)$/i;
const UNITS = new Set([...Object.values(CONTRACT.metrics), 's', 'm', 'm3', 'J']);
const EXPECTED_UNITS = { water_essential_unmet: 'm3', power_essential_unserved: 'J' };
const ASSUMPTION_TYPES = new Set(['line_restore', 'line_trip', 'pump_outage']);
export const ACTION_SCHEMAS = {
  set_switch: { switchId: CATALOG.switches, closed: 'bool' },
  set_pump: { pumpId: CATALOG.pumps, on: 'bool' },
  set_link: { linkId: CATALOG.links, open: 'bool' },
  set_station_mode: { mode: CATALOG.stationModes },
  allocate_generator: { resourceId: CATALOG.resources, site: ['pump-station'] },
  release_generator: { resourceId: CATALOG.resources },
};
const DOMAIN_OF = { set_switch: 'power', set_pump: 'water', set_link: 'water', set_station_mode: 'water', allocate_generator: 'resource', release_generator: 'resource' };

class Invalid extends Error {}
const invalid = code => { throw new Invalid(code); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function exact(record, required, optional = []) {
  if (!plain(record)) invalid('missing_field');
  for (const k of Object.keys(record)) if (!required.includes(k) && !optional.includes(k)) invalid('unknown_field');
  for (const k of required) if (!Object.hasOwn(record, k)) invalid('missing_field');
}
function scanHidden(value) {
  if (Array.isArray(value)) value.forEach(scanHidden);
  else if (plain(value)) for (const [k, v] of Object.entries(value)) { if (HIDDEN.test(k)) invalid('hidden_state'); scanHidden(v); }
}
const MAX_CITATIONS = 24;
const cite = (list, ids) => {
  if (!Array.isArray(list) || !list.length) invalid('missing_field');
  if (list.length > MAX_CITATIONS) invalid('too_many_citations');
  for (const id of list) if (!ids.has(id)) invalid('evidence_unknown');
};

export function parseJointDecision(text, { evidenceIds, templateIds, sensorIds, gridUs }) {
  try {
    let raw;
    try { raw = strictJsonParse(text); } catch (e) { invalid(e.message === 'duplicate_key' ? 'duplicate_key' : 'invalid_json'); }
    scanHidden(raw);
    exact(raw, ['hypotheses', 'selected', 'observe', 'assumptions', 'plan', 'expected', 'parameters', 'validForS']);
    if (!Array.isArray(raw.hypotheses) || raw.hypotheses.length < 1 || raw.hypotheses.length > 3) invalid('missing_field');
    for (const h of raw.hypotheses) { exact(h, ['id', 'statement', 'evidence', 'falsifier']); cite(h.evidence, evidenceIds); }
    if (!raw.hypotheses.some(h => h.id === raw.selected)) invalid('hypothesis_unknown');
    if (raw.observe !== null) { exact(raw.observe, ['sensorId', 'why']); if (!sensorIds.has(raw.observe.sensorId)) invalid('evidence_unknown'); }
    if (!Array.isArray(raw.assumptions) || raw.assumptions.length > 2) invalid('missing_field');
    for (const a of raw.assumptions) {
      exact(a, ['id', 'type', 'assetId', 'inS', 'evidence']);
      if (!ASSUMPTION_TYPES.has(a.type)) invalid('action_not_allowed');
      if (!Number.isInteger(a.inS) || a.inS < 0) invalid('invalid_units');
      cite(a.evidence, evidenceIds);
    }
    let plan = null;
    if (raw.plan !== null) {
      if (!plain(raw.plan)) invalid('missing_field');
      if ('templateId' in raw.plan) { exact(raw.plan, ['templateId']); if (!templateIds.has(raw.plan.templateId)) invalid('template_unknown'); plan = { templateId: raw.plan.templateId }; }
      else {
        exact(raw.plan, ['steps']);
        if (!Array.isArray(raw.plan.steps) || !raw.plan.steps.length || raw.plan.steps.length > 4) invalid('missing_field');
        plan = { steps: raw.plan.steps.map(st => {
          exact(st, ['domain', 'action', 'inS']);
          exact(st.action, ['type', 'params']);
          const schema = ACTION_SCHEMAS[st.action.type];
          if (!schema || DOMAIN_OF[st.action.type] !== st.domain) invalid('action_not_allowed');
          exact(st.action.params, Object.keys(schema));
          for (const [k, allowed] of Object.entries(schema)) {
            const v = st.action.params[k];
            if (allowed === 'bool' ? typeof v !== 'boolean' : !allowed.includes(v)) invalid('action_not_allowed');
          }
          if (!Number.isInteger(st.inS) || st.inS < 0 || (st.inS * S) % gridUs) invalid('invalid_units');
          return st;
        }) };
      }
    }
    if (!Array.isArray(raw.expected) || raw.expected.length > 2) invalid('missing_field');
    for (const e of raw.expected) {
      exact(e, ['metric', 'value', 'unit']);
      if (EXPECTED_UNITS[e.metric] === undefined) invalid('unknown_metric');
      if (e.unit !== EXPECTED_UNITS[e.metric]) invalid('invalid_units');
      // An unknown expectation is null (or a null bound), as the prompt instructs; known bounds are non-negative and ordered.
      if (e.value !== null) {
        if (!Array.isArray(e.value) || e.value.length !== 2 || e.value.some(v => v !== null && (typeof v !== 'number' || v < 0))) invalid('invalid_units');
        if (e.value[0] !== null && e.value[1] !== null && e.value[0] > e.value[1]) invalid('invalid_units');
      }
    }
    if (!Array.isArray(raw.parameters) || raw.parameters.length > 3) invalid('missing_field');
    for (const p of raw.parameters) {
      exact(p, ['key', 'value', 'unit', 'evidence']);
      if (!UNITS.has(p.unit)) invalid('invalid_units');
      if (p.value !== null && !(typeof p.value === 'number' && Number.isFinite(p.value))) invalid('invalid_units');
      cite(p.evidence, evidenceIds);
    }
    if (!Number.isInteger(raw.validForS) || raw.validForS < 60 || raw.validForS > 3600) invalid('invalid_units');
    return { ok: true, code: 'ok', decision: { ...raw, plan } };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, code: 'proposal_invalid', detail: e.message };
    throw e;
  }
}

// Remaining opportunity for an effective intervention, in simulated and wall time.
export function investigationDeadline({ nowUs, firstLossUs, actuationUs, marginUs, acceleration, providerCapS }) {
  if (firstLossUs === null || firstLossUs === undefined) return { simUs: null, wallS: providerCapS, basis: 'no predicted loss in the horizon; provider cap', providerCapS };
  const simUs = firstLossUs - nowUs - actuationUs - marginUs;
  if (firstLossUs <= nowUs) {
    // Loss already in progress: the opportunity is to shorten it; conventional control keeps acting, and the
    // call is bounded by the provider cap (its latency is still charged on the town clock).
    return { simUs, wallS: providerCapS, basis: `loss in progress since ${firstLossUs / S}s: mitigation, provider cap`, providerCapS, mitigation: true };
  }
  const wallS = Math.max(0, Math.min(providerCapS, simUs / S / acceleration));
  return { simUs, wallS, basis: `loss ${firstLossUs / S}s - now ${nowUs / S}s - actuation ${actuationUs / S}s - margin ${marginUs / S}s, / ${acceleration}x`, providerCapS };
}

// Declared asset information (what an operator's single-line diagram and service register say): admissible
// knowledge, the same the conventional templates were designed with. No fault or evaluator data.
export function assetRegister(layout = { pumpStationBus: 'bus-7', backupPumpBus: 'bus-14' }) {
  const n = b => b.replace('bus-', 'bus ');
  return ASSET_REGISTER.map(([id, text]) => [id, text.replace('supplied from bus 7 or', `supplied from ${n(layout.pumpStationBus)} or`).replace('supplied from bus 14', `supplied from ${n(layout.backupPumpBus)}`)]);
}
export const ASSET_REGISTER = [
  ['asset:JH', 'water consumer JH is the hospital: essential'], ['asset:JF', 'water consumer JF is the fire station: essential'],
  ['asset:JR', 'water consumer JR is a residential zone: non-essential'], ['asset:PZ', 'link PZ is the valve feeding the residential zone JR'],
  ['asset:PF', 'link PF feeds the fire station JF'], ['asset:T1', 'tank T1 (20 m2, usable 0.5-5.0 m) feeds JH, JF and JR'],
  ['asset:PU1', 'pump PU1 at the pump station, supplied from bus 7 or the portable generator'], ['asset:PU2', 'pump PU2, supplied from bus 14'],
  ['asset:gen', 'portable generator gen-portable: 25 kW, serves the pump station (PU1 and its router), 10 min to dispatch'],
  ['asset:ties', 'ties: sw-S1 (line 14-8), sw-S2 (line 6-7), sw-S3 (line 11-4) can feed buses 7-11 from the other feeder'],
  ['asset:essential-power', 'essential electrical loads: CI3 (bus 3), CI7 (bus 7), CI9 (bus 9)'],
];

function packet({ obs, state, advisory, receipts = [] }) {
  const lines = [], ids = new Set(), sensors = new Set();
  for (const [id, text] of assetRegister(state.layout)) { ids.add(id); lines.push(`${id}: ${text}`); }
  for (const r of obs.readings) {
    if (r.value === null) continue;
    const id = `obs:${r.sensorId}`;
    ids.add(id); sensors.add(r.sensorId);
    const age = Math.round((obs.atUs - r.observedAtUs) / S);
    lines.push(`${id}: ${r.metric} of ${r.assetId} = ${typeof r.value === 'number' ? +r.value.toPrecision(5) : r.value} ${r.unit} (age ${age} s)`);
  }
  for (const [r, v] of Object.entries(obs.routers)) { ids.add(`router:${r}`); lines.push(`router:${r}: ${v}`); }
  ids.add('state:station'); lines.push(`state:station: pump station mode ${state.stationMode}`);
  for (const [id, r] of Object.entries(state.resources)) { ids.add(`state:${id}`); lines.push(`state:${id}: allocated to ${r.allocatedTo ?? 'none'}, fuel ${Math.round(r.fuelJ / 1e6)} MJ`); }
  receipts.forEach((r, i) => { const id = `rcpt:${i + 1}`; ids.add(id); lines.push(`${id}: at ${r.atUs / S} s ${r.domain} ${r.action.type} ${JSON.stringify(r.action.params)} -> ${r.status}${r.reason ? ` (${r.reason})` : ''}`); });
  if (advisory) for (const sc of advisory.etaScenarios) { ids.add(`adv:${sc.label}`); lines.push(`adv:${sc.label}: ${advisory.source} estimates ${sc.assume.map(a => `${a.type} ${a.assetId} at ${a.atUs / S} s`).join(', ')}`); }
  return { text: lines.join('\n'), ids, sensors };
}

export function buildPrompt({ nowUs, obs, state, advisory, candidates, deadline, validS = 1800, receipts = [] }) {
  const p = packet({ obs, state, advisory, receipts });
  const tmpl = candidates.map(c => `${c.planId}: ${c.steps.map(s => `${s.action.type} ${JSON.stringify(s.action.params)} at +${(s.atUs - nowUs) / S}s`).join('; ') || 'no action'}`).join('\n');
  const actions = Object.entries(ACTION_SCHEMAS).map(([t, sch]) => `${t}: ${Object.entries(sch).map(([k, v]) => `${k} in ${v === 'bool' ? '{true,false}' : JSON.stringify(v)}`).join(', ')}`).join('\n');
  const text = PROMPT.replaceAll('{{NOW_S}}', String(nowUs / S)).replace('{{VALID_S}}', String(validS))
    .replace('{{LOSS}}', deadline.simUs === null ? 'none predicted within the horizon' : `${(deadline.simUs + nowUs) / S} s or later`).replace('{{BUDGET_S}}', deadline.wallS.toFixed(1))
    .replace('{{EVIDENCE}}', p.text).replace('{{TEMPLATES}}', tmpl).replace('{{ACTIONS}}', actions);
  return { text, evidenceIds: p.ids, sensorIds: p.sensors };
}

// The model-assisted planning layer. Modes: 'off' (the conventional rolling optimizer), 'narrator' (the
// model is called, its answer is logged and has no effect), 'investigator' (validated assumptions enter
// the ranking scenarios), 'complete' (also its plan enters the candidate pool).
export function metaPlanner(policy, { mode, callModel, providerCapS = 18, actuationUs = 600 * S, marginUs = 300 * S, maxCalls = Infinity, cadence = 'opportunity' }) {
  let spent = 0;
  const budget = { remaining: () => maxCalls - spent, spend: () => { spent++; } };
  const store = createModelStore();
  const calls = [];
  return {
    name: mode === 'off' ? 'rolling' : `meta-${mode}`, label: `Meta-assisted joint planning (${mode})`, calls, store,
    async decide({ town, nowUs, advisory }) {
      const state = await town.state();
      const obs = await town.observe();
      const { modelId } = await town.admittedModel();
      const allocated = Object.fromEntries(Object.entries(state.resources).filter(([, r]) => r.allocatedTo).map(([id, r]) => [id, r.allocatedTo]));
      const candidates = templates({ nowUs, catalog: CATALOG, state });
      const baseScenarios = advisory ? advisory.etaScenarios : [{ label: 'no-forecast', assume: [] }];
      const horizonUs = policy.durationUs - nowUs;
      const preview = (pl, a) => town.preview(pl, modelId, a);
      let extra = [], modelPlans = [], record = null;
      if (mode !== 'off') {
        const retain = await preview({ steps: [], horizonUs }, baseScenarios[0].assume ?? []);
        const deadline = investigationDeadline({ nowUs, firstLossUs: retain.firstEssentialLossUs, actuationUs, marginUs, acceleration: obs.clock.acceleration, providerCapS });
        record = { atUs: nowUs, deadline, mode };
        calls.push(record);
        // P19 ablation: a fixed cadence calls at every decision (up to the call budget) with the provider cap,
        // instead of only when an incident predicts loss and the remaining opportunity allows a call.
        if (cadence === 'fixed') { deadline.wallS = providerCapS; deadline.basis = 'fixed cadence: provider cap'; }
        if (cadence !== 'fixed' && ((state.worldRevision === 0 && !advisory) || retain.firstEssentialLossUs === null)) record.skipped = 'no_incident_or_predicted_loss';
        else if (budget.remaining() <= 0) record.skipped = 'call_budget_exhausted';
        else if (cadence !== 'fixed' && deadline.wallS < 3) record.skipped = 'no_opportunity';
        else {
          const prompt = buildPrompt({ nowUs, obs, state, advisory, candidates, deadline, receipts: (await town.receipts(12)).receipts });
          budget.spend();
          const res = await callModel({ prompt: prompt.text, timeoutMs: deadline.wallS * 1000 });
          Object.assign(record, { code: res.code, durationMs: res.durationMs, usage: res.usage ?? null, responseId: res.responseId ?? null, promptChars: prompt.text.length });
          if (res.code === 'ok') {
            const parsed = parseJointDecision(res.text, { evidenceIds: prompt.evidenceIds, templateIds: new Set(candidates.map(c => c.planId)), sensorIds: prompt.sensorIds, gridUs: policy.gridUs });
            record.parse = parsed.ok ? 'ok' : parsed.detail;
            if (!parsed.ok) record.rawText = res.text.slice(0, 6000); // for debugging the response format; contains no credential
            if (parsed.ok) {
              const d = parsed.decision;
              record.decision = { selected: d.selected, hypotheses: d.hypotheses, observe: d.observe, assumptions: d.assumptions, plan: d.plan, expected: d.expected };
              for (const p of d.parameters) record.store = [...(record.store ?? []), store.add({ key: p.key, value: p.value, unit: p.unit, evidence: p.evidence, source: 'meta', nowUs, ttlUs: d.validForS * S })];
              if (mode === 'investigator' || mode === 'complete') {
                if (d.assumptions.length) extra = [{ label: 'meta-assumptions', assume: d.assumptions.map(a => ({ domain: a.type === 'pump_outage' ? 'water' : 'power', faultId: `meta-${a.id}`, atUs: nowUs + Math.ceil(a.inS * S / policy.gridUs) * policy.gridUs, type: a.type === 'pump_outage' ? 'pump_outage' : a.type, assetId: a.assetId })) }];
              }
              if (mode === 'complete' && d.plan) {
                if (d.plan.templateId) modelPlans = [{ ...candidates.find(c => c.planId === d.plan.templateId), planId: `meta-choice-${d.plan.templateId}`, source: 'meta' }];
                else modelPlans = [{ planId: 'meta-custom', source: 'meta', steps: d.plan.steps.map((st, i) => ({ id: `meta-${i + 1}`, domain: st.domain, action: st.action, atUs: nowUs + st.inS * S, cost: 1,
                  ...(st.action.type === 'allocate_generator' ? { durationUs: 600 * S, resources: [{ id: st.action.params.resourceId, use: 'allocate', site: st.action.params.site }] } : {}) })) }];
              }
            }
          }
        }
      }
      const scenarios = [...baseScenarios, ...extra];
      const r = await searchPlans({
        candidates: [...candidates, ...modelPlans],
        validate: p => validateTimedPlan(p, { nowUs, gridUs: policy.gridUs, resources: { 'gen-portable': {} }, allocated }),
        evaluate: p => evaluatePlan(p, { preview, horizonUs, scenarios }), budget: { maxCandidates: 20, wallMs: 600_000 },
      });
      if (record) {
        // Participation needs a parsed answer, and then either the model's plan won or its assumptions changed
        // which plan won (the conventional ranking is recomputed with the identical key, without its scenario).
        const labels = baseScenarios.map(sc => sc.label);
        const conventional = r.ranking.filter(x => !x.plan.source).map(x => ({ id: x.plan.planId, key: scenarioKey(x.plan, x.runs, labels).key })).sort((a, b) => cmp(a.key, b.key));
        const conventionalBest = conventional[0]?.id ?? 'retain-policy';
        Object.assign(record, { chosen: r.best.plan.planId, conventionalBest, refused: r.refused,
          participated: record.parse === 'ok' && (Boolean(r.best.plan.source) || r.best.plan.planId !== conventionalBest) });
      }
      return { ...r.best.plan, search: { evaluated: r.evaluated, overrun: r.overrun, elapsedMs: r.elapsedMs }, replaceFuture: true, meta: record };
    },
  };
}

const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
export function metaJoint(policy, options) {
  const planner = metaPlanner(policy, options);
  return { name: options.mode === 'off' ? 'hybrid' : `meta-${options.mode}`, label: `rules in parallel with ${planner.label}`, layers: [priority(policy), planner], planner };
}
