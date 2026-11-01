// LIFELINE AI-assisted supervisor. The adaptive conventional layer keeps immediate failover and capacity
// planning; the Meta model investigates incidents and unexplained degradation and proposes typed probes
// or interventions. Every model decision is strictly parsed, its evidence and belief updates checked,
// its consequence forecast, and it then passes the same guard and executor as any other proposal.
// P01: the conventional layer runs in full at all times; investigations run in parallel on the episode
// clock, bounded by a total deadline, cancellable, and bound to the evidence and configuration they used.
import { createAdaptiveController } from './adaptive.mjs';
import { directedLinks, effectiveRoute, essentialDemandBps } from './common.mjs';
import { forecast } from '../forecast.mjs';
import { PROVIDER_CONFIG, parseModelDecision } from '../meta-provider.mjs';
import { createInvestigationBudget } from '../investigation-clock.mjs';

const DEGRADED_HOLD_MS = 20_000;
const REINVESTIGATE_MS = 15_000;
const EVIDENCE_KEPT = 12;
const EQUIVALENT_PROBE_MS = 20_000; // a probe of a path measured this recently adds no information
const ROUTE_CHANGES_PER_INCIDENT = 2;

const round = (v, digits = 0) => (typeof v === 'number' ? Math.round(v * 10 ** digits) / 10 ** digits : v ?? null);

export function createMetaController(inventory, policy, { callModel, chargeModelCall = () => {}, now: clock } = {}) {
  let mode = 'normal';
  let degradedUntil = 0;
  // Full conventional behaviour, including its unexplained-degradation rule, regardless of provider health.
  const adaptive = createAdaptiveController(inventory, policy);
  const now = () => (clock ? clock() : lastState?.nowMs ?? 0);
  const events = [];
  const evidence = new Map(); // obs-<seq> -> measured rates at that sample
  const outcomes = [];        // rcpt-<n> -> recent action outcomes
  let pending = null, ready = null, attempts = 0, inv = null, stopped = false, investigationCount = 0;
  let lastTrigger = '', lastInvestigationAt = -Infinity, lastState = null, receiptCount = 0;
  const probedAt = {};       // path -> time of last completed probe (any layer)
  let routeChanges = {};     // flowId -> model route changes in the current incident

  const setMode = (next, reason, nowMs) => {
    if (next === 'degraded') degradedUntil = nowMs + DEGRADED_HOLD_MS;
    if (mode === next) return;
    mode = next;
    events.push({ type: 'mode', mode: next, reason, atMs: nowMs });
  };

  function evidenceIds() { return new Set([...evidence.keys(), ...outcomes.map(o => o.id)]); }

  function buildPrompt(state, trigger) {
    const { observation, routes, backgroundRates, remaining } = state;
    const effective = Object.fromEntries(inventory.essential.map(f => [f.flowId, effectiveRoute(f, routes[f.flowId], observation, inventory)]));
    const recent = [...evidence.entries()].slice(-4).map(([id, e]) => ({
      id, ageMs: round(observation.collectedAtMs - e.collectedAtMs), linksDown: e.down,
      links: Object.fromEntries(Object.entries(e.links).map(([linkId, ends]) => [linkId, Object.fromEntries(Object.entries(ends).map(([end, m]) => [end, m.txBps === null ? null : { txMbps: round(m.txBps / 1e6, 2), dropsPerS: round(m.dropsPerS, 1), backlogKB: round((m.backlogBytes ?? 0) / 1000, 1) }]))])),
      services: Object.fromEntries(Object.entries(e.services).map(([f, v]) => [f, { onTime: round(v.recentOnTimeFraction, 3), retransmissionRatio: round(v.retransmissionRatio, 2) }])),
    }));
    const missingCounters = [...new Set(recent.flatMap(r => Object.entries(r.links).filter(([, ends]) => Object.values(ends).some(m => m === null)).map(([id]) => id)))];
    const beliefs = adaptive.beliefs;
    const current = forecast({ inventory, beliefs, routes: effective, rates: backgroundRates, observation });
    const context = {
      trigger,
      objectives: inventory.essential.map(f => ({ flowId: f.flowId, source: f.source, destination: f.destination, priority: f.priority, deadlineMs: f.deadlineMs, demandMbps: round(essentialDemandBps(f) / 1e6, 2) })),
      topology: { links: inventory.topology.links.map(l => ({ linkId: l.linkId, nominalMbps: inventory.nominalCapacityBps[l.linkId] / 1e6 })), endpoints: inventory.topology.endpoints },
      currentRoutes: Object.fromEntries(Object.entries(effective).map(([f, r]) => [f, { path: r.path, ackPath: r.ackPath }])),
      background: inventory.background.map(s => ({ sourceId: s.sourceId, path: s.primary, currentBps: backgroundRates[s.sourceId], minBps: s.minBps, scheduledBps: s.scheduledBps })),
      observations: recent,
      missingCounters,
      recentOutcomes: outcomes.slice(-4),
      beliefs: { assumptions: current.assumptions, measuredLinks: Object.fromEntries(Object.entries(beliefs.snapshot(observation.collectedAtMs).links).filter(([, b]) => b.measured || b.down).map(([k, b]) => [k, { loMbps: round(b.lo / 1e6, 2), hiMbps: round(b.hi / 1e6, 2), evidence: b.evidence }])), contradictions: beliefs.contradictions.length },
      forecastForCurrentRoutes: current.flows?.map(f => ({ flowId: f.flowId, predictedOnTime: f.predictedOnTime })) ?? current.status,
      competingExplanations: ['capacity reduction on a reporting link (shows backlog or queue drops)', 'packet loss on a link whose counters are missing (null)', 'congestion from background traffic sharing the path', 'stale or missing telemetry'],
      budgets: { interventionBundles: remaining.interventionBundles, probeBytes: remaining.incidentProbeBytes, modelCalls: remaining.modelCalls },
      limits: { probe: { maxPackets: policy.limits.probeMaxPackets, maxBytes: policy.limits.probeMaxBytes, minIntervalMs: policy.limits.probeMinIntervalMs }, maxActions: 2 },
    };
    return [
      'You are the investigator for an emulated emergency communications network (synthetic facilities, no real service).',
      'A deterministic controller already handles link-down failover. Your job: explain why essential messages are missing deadlines, choose the next discriminating probe or a bounded intervention, and say what you expect to observe.',
      'Use only the measurements below. Counters shown as null are missing, not zero. Cite evidence IDs exactly as given (obs-N, rcpt-N). Do not invent measurements.',
      'Allowed actions (at most 2): probe_path {sourceId, destinationId, path?, packetCount, payloadBytes, intervalMs}; set_route {flowId, path, ackPath} (simple paths over links that are up; ackPath runs destination to source); set_background_rate {sourceId, bitsPerSecond} (integer, within [minBps, scheduledBps]); retain_policy {reasonCode}.',
      'Return ONLY JSON: {"hypotheses":[{"id":"h1","statement":"...","evidence":["obs-N"],"wouldContradict":"..."}],"selected":"h1","actions":[{"type":"..."}],"expected":[{"flowId":"...","onTimeFraction":[lo,hi]}],"beliefUpdates":[],"stop":false}. Use stop=true with a retain_policy action if no change is warranted. Give 1-3 hypotheses.',
      JSON.stringify(context),
    ].join('\n');
  }

  const downKey = observation => Object.entries(observation.links).filter(([, l]) => l.state !== 'up').map(([id]) => id).sort().join(',');

  function giveUp(reason) {
    attempts = 0;
    inv = null;
    setMode('degraded', reason, now());
  }

  function fail(detail) {
    if (!inv) return;
    if (inv.budget.expired()) return giveUp('deadline_expired');
    if (attempts < PROVIDER_CONFIG.callsPerDecision && (lastState?.remaining.modelCalls ?? 0) - attempts > 0) return attemptCall();
    giveUp(detail);
  }

  function attemptCall() {
    if (inv.budget.expired()) return giveUp('deadline_expired');
    attempts++;
    chargeModelCall(); // charged once per attempt, whatever its outcome
    const current = inv;
    const abort = new AbortController();
    current.abort = abort;
    const prompt = buildPrompt(lastState, current.trigger);
    const ids = evidenceIds();
    pending = current.id;
    Promise.resolve(callModel({ prompt, timeoutMs: current.budget.callTimeoutMs(PROVIDER_CONFIG.callTimeoutMs), signal: abort.signal }))
      .then(res => onResult(current, res, ids))
      .catch(error => onResult(current, { code: 'provider_unavailable', reason: 'client_error', detail: String(error?.message ?? error).slice(0, 200) }, ids));
  }

  function onResult(origin, res, ids) {
    if (stopped) { events.push({ type: 'model_discarded', reason: 'run_stopped', investigation: origin.id, responseId: res.responseId ?? null, atMs: now() }); return; }
    if (inv?.id !== origin.id) { events.push({ type: 'model_discarded', reason: 'superseded', investigation: origin.id, responseId: res.responseId ?? null, atMs: now() }); return; }
    pending = null;
    events.push({ type: 'provider_call', code: res.code, reason: res.reason, httpStatus: res.httpStatus, durationMs: res.durationMs, responseId: res.responseId, usage: res.usage, promptSha256: res.promptSha256, promptVersion: PROVIDER_CONFIG.promptVersion, attempt: attempts, trigger: origin.trigger, atMs: now() });
    if (res.code !== 'ok') return fail(res.code);
    const parsed = parseModelDecision(res.text, { evidenceIds: ids });
    if (!parsed.ok) { events.push({ type: 'model_rejected', code: parsed.code, detail: parsed.detail, responseId: res.responseId, text: String(res.text).slice(0, 4000), atMs: now() }); return fail(parsed.detail); }
    ready = { decision: parsed.decision, response: res, trigger: origin.trigger, downKey: origin.downKey, originRevision: origin.originRevision, originAtMs: origin.budget.startedAtMs, investigation: origin.id };
    inv = null;
  }

  function investigate(state, trigger) {
    if (inv?.abort) inv.abort.abort(); // a newer incident supersedes an outstanding call
    attempts = 0;
    lastInvestigationAt = now();
    inv = {
      id: ++investigationCount, trigger, downKey: downKey(state.observation), originRevision: state.observation.configRevision,
      budget: createInvestigationBudget({ startedAtMs: now(), deadlineMs: PROVIDER_CONFIG.decisionDeadlineMs, nowMs: now }),
    };
    attemptCall();
  }

  // A response may only act on the world it was requested about.
  function stale(r, state) {
    if (state.observation.configRevision !== r.originRevision) return 'configuration_changed';
    if (downKey(state.observation) !== r.downKey) return 'incident_changed';
    if (now() - r.originAtMs > PROVIDER_CONFIG.decisionDeadlineMs) return 'expired';
    return null;
  }

  function fromModel({ decision, response, trigger }, state) {
    const { observation, routes, backgroundRates, nowMs } = state;
    // Progress bounds: an equivalent probe or a third reroute of the same flow hands control back.
    const repeated = decision.actions.find(a => (a.type === 'probe_path' && a.path && nowMs - (probedAt[a.path.join()] ?? -Infinity) < EQUIVALENT_PROBE_MS)
      || (a.type === 'set_route' && (routeChanges[a.flowId] ?? 0) >= ROUTE_CHANGES_PER_INCIDENT));
    if (repeated) {
      events.push({ type: 'model_rejected', code: 'proposal_invalid', detail: 'progress_limit', action: repeated.type, responseId: response.responseId, atMs: now() });
      giveUp('progress_limit'); // no retry: the limit is about progress, not parsing
      return null;
    }
    const store = Object.fromEntries(evidence);
    for (const update of decision.beliefUpdates) {
      const result = adaptive.beliefs.applyProposedUpdate(update, store);
      if (!result.ok) { events.push({ type: 'model_rejected', code: 'proposal_invalid', detail: result.code, responseId: response.responseId, atMs: now() }); giveUp(result.code); return null; }
    }
    const next = Object.fromEntries(inventory.essential.map(f => [f.flowId, effectiveRoute(f, routes[f.flowId], observation, inventory)]));
    const rates = { ...backgroundRates };
    for (const a of decision.actions) {
      if (a.type === 'set_route' && next[a.flowId]) next[a.flowId] = { version: 1, path: a.path, ackPath: a.ackPath };
      if (a.type === 'set_background_rate') rates[a.sourceId] = a.bitsPerSecond;
    }
    let predicted;
    try { predicted = forecast({ inventory, beliefs: adaptive.beliefs, routes: next, rates, observation }); } catch { predicted = { status: 'forecast_unavailable' }; }
    if (predicted.status !== 'ok') { events.push({ type: 'model_rejected', code: predicted.status, detail: predicted.status, responseId: response.responseId, atMs: now() }); giveUp(predicted.status); return null; }
    attempts = 0;
    const down = Object.entries(observation.links).filter(([, l]) => l.state !== 'up').map(([id]) => id).slice(0, 4);
    const degradedNow = adaptive.degradedFlows().filter(f => typeof state.rates.services?.[f]?.recentOnTimeFraction === 'number');
    const selected = decision.hypotheses.find(h => h.id === decision.selected);
    return {
      source: 'meta', actions: decision.actions,
      preconditions: [...down.map(linkId => ({ kind: 'link_state', linkId, state: 'down' })), ...degradedNow.map(flowId => ({ kind: 'service_on_time_below', flowId, onTimeFraction: 0.95 }))],
      rationale: `meta ${decision.selected}: ${selected.statement}`.slice(0, 300),
      modelTrace: { responseId: response.responseId, durationMs: response.durationMs, usage: response.usage, selected: decision.selected, hypotheses: decision.hypotheses, expected: decision.expected, stop: decision.stop, trigger, forecastId: predicted.forecastId, forecast: predicted.flows.map(f => ({ flowId: f.flowId, predictedOnTime: f.predictedOnTime })) },
    };
  }

  return {
    name: 'meta',
    beliefs: adaptive.beliefs,
    mode: () => mode,
    investigating: () => inv !== null,
    unavailable: () => adaptive.unavailable(),
    drainEvents: () => events.splice(0),
    applied(intent, result) {
      adaptive.applied(intent, result);
      for (const a of intent.actions ?? []) if (intent.source === 'meta' && a.type === 'set_route' && result.status === 'confirmed') routeChanges[a.flowId] = (routeChanges[a.flowId] ?? 0) + 1;
      for (const r of result.receipts ?? []) {
        if (r.measurement?.path) probedAt[r.measurement.path.join()] = result.nowMs;
        outcomes.push({ id: `rcpt-${++receiptCount}`, type: r.type, status: r.status, ...(r.measurement ? { measurement: { path: r.measurement.path, lossFraction: round(r.measurement.lossFraction, 3), rttMs: r.measurement.rttMs && { median: round(r.measurement.rttMs.median, 1), max: round(r.measurement.rttMs.max, 1) } } } : {}) });
        if (outcomes.length > 8) outcomes.shift();
      }
      if (intent.source === 'meta') events.push({ type: 'model_outcome', responseId: intent.modelTrace?.responseId, status: result.status });
    },
    stop() {
      stopped = true;
      inv?.abort?.abort();
      inv = null; pending = null; ready = null;
    },
    decide(state) {
      lastState = state;
      if (stopped) return null;
      const { observation, rates, remaining } = state;
      if (!observation.stale) {
        evidence.set(`obs-${observation.seq}`, { collectedAtMs: observation.collectedAtMs, down: Object.entries(observation.links).filter(([, l]) => l.state !== 'up').map(([id]) => id), links: rates.links ?? {}, services: rates.services ?? {} });
        while (evidence.size > EVIDENCE_KEPT) evidence.delete(evidence.keys().next().value);
      }
      if (mode === 'degraded' && now() >= degradedUntil && (remaining.modelCalls ?? 0) > 0) setMode('normal', 'hold_elapsed', now());
      if (ready && !observation.stale) {
        const reason = stale(ready, state);
        if (reason) { events.push({ type: 'model_discarded', reason, investigation: ready.investigation, responseId: ready.response.responseId, atMs: now() }); ready = null; }
      }
      const deterministic = adaptive.decide(state);
      if (!observation.stale) {
        const down = Object.entries(observation.links).filter(([, l]) => l.state !== 'up').map(([id]) => id).sort();
        const trigger = [...down.map(d => `down:${d}`), ...adaptive.degradedFlows().map(f => `degraded:${f}`)].join(',');
        const stillDegraded = adaptive.degradedFlows().length > 0;
        const newIncident = inv && inv.downKey !== downKey(observation);
        if (newIncident) investigate(state, trigger), lastTrigger = trigger;
        else if (trigger && !inv && !ready && mode === 'normal' && (trigger !== lastTrigger || (stillDegraded && now() - lastInvestigationAt > REINVESTIGATE_MS))) {
          if ((remaining.modelCalls ?? 0) < 1) setMode('degraded', 'model_budget_exhausted', now());
          else {
            if (trigger !== lastTrigger) routeChanges = {}; // a new incident resets the per-incident bound
            lastTrigger = trigger; investigate(state, trigger);
          }
        }
      }
      if (deterministic) return { ...deterministic, source: 'deterministic' }; // recovery never waits on the model
      if (ready && !observation.stale) {
        const r = ready; ready = null;
        if (r.decision.stop && r.decision.actions.every(a => a.type === 'retain_policy')) {
          // A decision to change nothing is retained as evidence; it is not an intervention and spends no bundle.
          attempts = 0;
          events.push({ type: 'model_decision', stop: true, selected: r.decision.selected, hypotheses: r.decision.hypotheses, expected: r.decision.expected, actions: r.decision.actions, responseId: r.response.responseId, durationMs: r.response.durationMs, trigger: r.trigger, atMs: now() });
          return null;
        }
        return fromModel(r, state);
      }
      return null;
    },
  };
}
