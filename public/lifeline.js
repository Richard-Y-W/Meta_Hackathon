// LIFELINE operator display. Everything shown comes from retained or live run records: receipts,
// controller-visible observations and the ledger. Model text is untrusted and always escaped.
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = v => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${(100 * v).toFixed(1)}%`);
const FLOW_COLORS = { 'dispatch-clinic': '#58a6ff', 'field-clinic': '#a371f7', 'dispatch-shelter': '#3fb950' };
const POS = { r0: [130, 190], r1: [230, 70], r2: [410, 70], r3: [510, 190], r4: [410, 310], r5: [230, 310] };
const HOST_POS = { dispatch: [40, 190], field: [230, 18], clinic: [600, 190], shelter: [410, 362] };

const state = { view: null, mode: 'idle', cursor: 0, live: null, timer: null, playing: null };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

function banner(text, kind = 'error') {
  const b = $('banner');
  b.hidden = !text;
  b.className = `banner ${kind === 'info' ? 'info' : ''}`;
  b.textContent = text ?? '';
}

function setMode(mode, runId) {
  state.mode = mode;
  const m = $('mode');
  m.className = `badge mode-${mode}`;
  m.textContent = { 'live-meta': 'LIVE · META-ASSISTED', 'live-deterministic': 'LIVE · DETERMINISTIC', 'recorded-replay': 'RECORDED REPLAY', idle: 'NO RUN' }[mode] ?? mode.toUpperCase();
  $('run-id').textContent = runId ?? '—';
}

const start = () => state.view?.manifest?.trafficStartAtMs ?? 0;
const tOf = ms => (ms - start()) / 1000;

// Events on a common time axis (seconds since traffic start), from ledger records.
function timelineEvents(events) {
  const items = [];
  for (const e of events) {
    if (e.type === 'admin_fault' || e.type === 'operator_fault') {
      const f = e.fault;
      items.push({ t: tOf(e.appliedAtMs), cls: 'admin', chip: e.type === 'operator_fault' ? 'JUDGE FAULT' : 'SCHEDULED FAULT', title: `${f.kind.replace('_', ' ')} ${f.linkId ?? f.switchId ?? ''}${f.bwMbit ? ` → ${f.bwMbit} Mbit/s` : ''}${f.lossPercent ? ` (${f.lossPercent}% loss)` : ''}`, text: 'Administrative event, hidden from every controller.' });
    } else if (e.type === 'decision') {
      const src = e.source === 'meta' ? 'meta' : 'det';
      const acts = e.proposal.actions.map(a => `${a.type.replace(/_/g, ' ')} ${a.flowId ?? a.sourceId ?? ''} ${a.path ? a.path.join('→') : ''}${a.bitsPerSecond ? ` ${(a.bitsPerSecond / 1e6).toFixed(1)} Mbit/s` : ''}`).join('; ');
      const mt = e.modelTrace;
      const hyp = mt ? mt.hypotheses.map(h => `${h.id === mt.selected ? '★ ' : ''}${h.statement} [${h.evidence.join(', ')}]`).join(' · ') : (e.rationale ?? '');
      const expect = mt?.expected?.length ? `Expected: ${mt.expected.map(x => `${x.flowId} ${pct(x.onTimeFraction[0])}–${pct(x.onTimeFraction[1])}`).join(', ')}` : '';
      const guard = e.decision.admitted ? 'Guard: admitted' : `Guard: rejected (${e.decision.code}${e.decision.detail ? `/${e.decision.detail}` : ''})`;
      items.push({ t: tOf(e.decision.decidedAtMs), cls: e.decision.admitted ? src : 'bad', chip: src === 'meta' ? 'META' : 'DETERMINISTIC', title: acts, text: [hyp, expect, guard].filter(Boolean).join('\n') });
    } else if (e.type === 'execution') {
      for (const r of e.receipts ?? []) {
        const m = r.measurement;
        items.push({ t: tOf(r.endedAtMs ?? r.startedAtMs), cls: r.status === 'confirmed' ? 'det' : 'bad', chip: 'RECEIPT', title: `${r.type.replace(/_/g, ' ')}: ${r.status}`, text: m ? `Probe ${m.path?.join('→')}: ${m.received}/${m.sent} returned (${pct(m.lossFraction)} loss), median RTT ${m.rttMs?.median?.toFixed?.(1) ?? '—'} ms` : (r.detail ?? '') });
      }
    } else if (e.type === 'controller_provider_call') {
      items.push({ t: tOf(e.atMs), cls: e.code === 'ok' ? 'meta' : 'bad', chip: 'MODEL CALL', title: `${e.code} in ${((e.durationMs ?? 0) / 1000).toFixed(1)} s`, text: `${e.responseId ?? ''} · ${e.usage?.output_tokens ?? '—'} output tokens · trigger ${e.trigger}` });
    } else if (e.type === 'controller_model_decision') {
      items.push({ t: tOf(e.atMs), cls: 'meta', chip: 'META', title: 'No change warranted', text: e.hypotheses.map(h => h.statement).join(' · ') });
    } else if (e.type === 'controller_model_rejected') {
      items.push({ t: tOf(e.atMs), cls: 'bad', chip: 'REJECTED', title: `Model decision refused: ${e.detail}`, text: 'Nothing the model proposed was applied.' });
    } else if (e.type === 'controller_mode') {
      items.push({ t: tOf(e.atMs), cls: e.mode === 'degraded' ? 'bad' : 'det', chip: 'MODE', title: e.mode === 'degraded' ? 'Deterministic takeover (investigator unavailable)' : 'Investigator restored', text: e.reason });
    } else if (e.type === 'service_unavailable' && e.flows?.length) {
      items.push({ t: tOf(e.atMs), cls: 'bad', chip: 'UNAVAILABLE', title: `No feasible path: ${e.flows.join(', ')}`, text: 'Reported as unavailable; no recovery is claimed.' });
    }
  }
  return items.filter(i => Number.isFinite(i.t)).sort((a, b) => a.t - b.t);
}

function observationAt(t) {
  const obs = state.view?.observations ?? [];
  let best = null, prev = null;
  for (const o of obs) { if (tOf(o.collectedAtMs) <= t) { prev = best; best = o; } }
  return { cur: best, prev };
}

function routesAt(t) {
  const routes = {};
  for (const f of state.view?.topology?.flows ?? []) routes[f.flowId] = null;
  for (const e of state.view?.events ?? []) {
    if (e.type !== 'execution') continue;
    const proposal = (state.view.events.find(d => d.type === 'decision' && d.proposal.proposalId === e.proposalId) ?? {}).proposal;
    for (const r of e.receipts ?? []) {
      const a = proposal?.actions.find(x => x.actionId === r.actionId);
      if (a?.type === 'set_route' && r.status === 'confirmed' && tOf(r.startedAtMs) <= t) routes[a.flowId] = a.path;
    }
  }
  return routes;
}

function drawMap(t) {
  const svg = $('map');
  const topo = state.view?.topology;
  if (!topo) { svg.innerHTML = ''; return; }
  const { cur, prev } = observationAt(t);
  const parts = [];
  for (const l of topo.links) {
    const [x1, y1] = POS[l.a], [x2, y2] = POS[l.b];
    const link = cur?.links?.[l.linkId];
    const ends = Object.keys(link?.txBytes ?? {});
    const unreported = link && ends.some(e => link.txBytes[e] === null);
    let mbps = null;
    if (cur && prev && !unreported) {
      const dt = (cur.collectedAtMs - prev.collectedAtMs) / 1000;
      mbps = Math.max(...ends.map(e => ((link.txBytes[e] - (prev.links?.[l.linkId]?.txBytes?.[e] ?? link.txBytes[e])) * 8) / dt / 1e6));
    }
    const down = link?.state && link.state !== 'up';
    const color = down ? 'var(--down)' : unreported ? 'var(--dark)' : 'var(--up)';
    const width = 3 + Math.min(9, ((mbps ?? 0) / l.nominalMbps) * 9);
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${unreported ? 'stroke-dasharray="6 6"' : ''} opacity="${down ? 0.9 : 0.75}"><title>${esc(l.linkId)} · ${l.nominalMbps} Mbit/s nominal</title></line>`);
    const label = down ? 'DOWN' : unreported ? 'no counters' : mbps === null ? '' : `${mbps.toFixed(1)} Mb/s`;
    const at = { 'r0-r3': 0.3, 'r1-r4': 0.72 }[l.linkId] ?? 0.5; // the two crossing links are labelled off-centre
    parts.push(`<text x="${x1 + (x2 - x1) * at}" y="${y1 + (y2 - y1) * at - 8}" class="lbl" fill="${down ? '#ffb3ad' : '#8b98a8'}" font-size="11" text-anchor="middle">${esc(label)}</text>`);
  }
  const routes = routesAt(t);
  Object.entries(routes).forEach(([flowId, path], i) => {
    if (!path) return;
    const pts = path.map(n => POS[n].map((v, k) => v + (k ? (i - 1) * 5 : (i - 1) * 5)).join(',')).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="${FLOW_COLORS[flowId] ?? '#58a6ff'}" stroke-width="2" stroke-dasharray="2 4" opacity="0.95"><title>${esc(flowId)} route</title></polyline>`);
  });
  for (const h of topo.hosts) {
    const [hx, hy] = HOST_POS[h.hostId] ?? [0, 0], [sx, sy] = POS[h.switch];
    parts.push(`<line x1="${hx}" y1="${hy}" x2="${sx}" y2="${sy}" stroke="#30363d" stroke-width="2"/><rect x="${hx - 34}" y="${hy - 11}" width="68" height="22" rx="5" fill="#21262d" stroke="#30363d"/><text x="${hx}" y="${hy + 4}" fill="#e6edf3" font-size="11" text-anchor="middle">${esc(h.hostId)}</text>`);
  }
  for (const [n, [x, y]] of Object.entries(POS)) parts.push(`<circle cx="${x}" cy="${y}" r="17" fill="#0d1117" stroke="#58a6ff" stroke-width="2"/><text x="${x}" y="${y + 4}" fill="#e6edf3" font-size="12" text-anchor="middle">${n}</text>`);
  svg.innerHTML = parts.join('');
  $('map-time').textContent = `t = ${t.toFixed(1)} s`;
}

function sparkline(points) {
  if (!points.length) return '<svg class="spark"></svg>';
  const w = 300, h = 36, max = Math.max(1, points.length - 1);
  const d = points.map((v, i) => `${(i / max) * w},${h - 2 - v * (h - 4)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h - 2 - 0.95 * (h - 4)}" x2="${w}" y2="${h - 2 - 0.95 * (h - 4)}" stroke="#30363d" stroke-dasharray="3 3"/><polyline points="${d}" fill="none" stroke="#58a6ff" stroke-width="1.5"/></svg>`;
}

function drawServices(t) {
  const flows = state.view?.topology?.flows ?? [];
  const live = state.mode.startsWith('live');
  const series = state.view?.summary?.series;
  let html = '';
  for (const f of flows) {
    let points = [], current = null;
    if (series && !live) {
      const s = series[f.flowId] ?? {};
      for (let i = 0; i <= Math.floor(t); i++) { const b = s[String(i)]; points.push(b && b.offered ? b.onTime / b.offered : null); }
      const recent = [Math.floor(t) - 2, Math.floor(t) - 1, Math.floor(t)].map(i => s[String(i)]).filter(Boolean);
      const off = recent.reduce((a, b) => a + b.offered, 0);
      current = off ? recent.reduce((a, b) => a + b.onTime, 0) / off : null;
    } else {
      const obs = state.view?.observations ?? [];
      for (let i = 4; i < obs.length; i++) {
        const a = obs[i - 4].services?.[f.flowId], b = obs[i].services?.[f.flowId];
        const d = b && a ? b.resolvedOffered - a.resolvedOffered : 0;
        points.push(d > 0 ? (b.resolvedOnTime - a.resolvedOnTime) / d : null);
      }
      current = points.filter(v => v !== null).at(-1) ?? null;
    }
    html += `<div class="service"><div><strong>${esc(f.source)} → ${esc(f.destination)}</strong><small>${f.deadlineMs} ms deadline</small></div>${sparkline(points.filter(v => v !== null))}<b class="${current !== null && current < 0.95 ? 'neg' : ''}">${pct(current)}</b></div>`;
  }
  $('services').innerHTML = html;
  $('service-basis').textContent = live ? 'sender-reported, live' : 'receiver receipts, per second';
  const p = state.view?.summary?.results?.primary;
  $('totals').textContent = !live && p ? `Scored window: ${p.onTime.toLocaleString()} of ${p.offered.toLocaleString()} essential messages on time (${pct(p.deliveryRate)}); ${p.late} late, ${p.lost} lost.` : live ? 'Final receipt-based score is computed when the run ends.' : '';
}

function drawTimeline(t) {
  const items = timelineEvents(state.view?.events ?? []);
  $('event-count').textContent = `${items.length} events`;
  $('timeline').innerHTML = items.map(i => `<li class="${i.cls}${i.t > t ? ' future' : ''}"><span class="t">${i.t.toFixed(1)}s</span><span class="chip ${i.cls}">${esc(i.chip)}</span><strong>${esc(i.title)}</strong>${i.text ? `<p>${esc(i.text).replace(/\n/g, '<br>')}</p>` : ''}</li>`).join('');
}

function render() {
  const t = state.cursor;
  drawMap(t); drawServices(t); drawTimeline(t);
}

async function loadComparison() {
  try {
    const c = await api('/api/lifeline/comparison');
    const rows = Object.entries(c.cases).map(([id, k]) => {
      const raw = k.diff.metaMinusAdaptive;
      const d = raw === null ? null : Math.abs(raw) < 5e-5 ? 0 : raw; // differences below 0.005 pp are rounding, not results
      return `<tr><td>${esc(id)}</td><td>${pct(k.mean.priority)}</td><td>${pct(k.mean.adaptive)}</td><td>${pct(k.mean.meta)}</td><td class="${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d === null ? '—' : `${d > 0 ? '+' : ''}${(100 * d).toFixed(2)} pp`}</td></tr>`;
    }).join('');
    $('comparison').innerHTML = `<table><thead><tr><th>Case</th><th>Priority</th><th>Adaptive</th><th>LIFELINE</th><th>vs adaptive</th></tr></thead><tbody>${rows}</tbody></table><p class="mono">${c.episodes.total} episodes attempted, ${c.episodes.valid} valid. Two repetitions per case: exploratory, no significance claimed.</p>`;
  } catch { $('comparison').textContent = 'No retained pilot comparison yet.'; }
}

async function loadRuns() {
  const { runs, scenarios } = await api('/api/lifeline/runs');
  $('runs').innerHTML = runs.map(r => `<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.controller)} · ${pct(r.deliveryRate)}</option>`).join('');
  $('scenario').innerHTML = scenarios.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

async function loadRun(id) {
  stopPolling();
  const view = await api(`/api/lifeline/run?id=${encodeURIComponent(id)}`);
  state.view = view;
  setMode('recorded-replay', view.manifest.runId);
  $('connection').textContent = view.manifest.terminal;
  $('connection').className = `badge ${view.manifest.terminal === 'completed' ? 'conn-ok' : 'conn-bad'}`;
  $('export').href = `/api/lifeline/export?id=${encodeURIComponent(id)}`;
  const end = view.manifest.durationMs / 1000;
  $('cursor').max = end; $('cursor').value = end; state.cursor = end;
  $('fault-link').innerHTML = view.topology.links.map(l => `<option>${esc(l.linkId)}</option>`).join('');
  banner(view.manifest.terminal === 'completed' ? null : `This recorded run ended as ${view.manifest.terminal}; its score may be incomplete.`, 'info');
  render();
}

function stopPolling() { clearTimeout(state.timer); state.timer = null; state.live = null; $('stop').disabled = true; $('inject').disabled = true; }

async function pollLive() {
  if (!state.live) return;
  try {
    const s = await api(`/api/lifeline/live?liveId=${encodeURIComponent(state.live.liveId)}&after=${state.live.lastSeq}`);
    state.view.events.push(...s.events);
    if (s.events.length) state.live.lastSeq = s.events.at(-1).seq;
    const built = state.view.events.find(e => e.type === 'traffic_started');
    if (built) state.view.manifest.trafficStartAtMs = built.startAtMs;
    if (s.observations.length) {
      const seen = new Set(state.view.observations.map(o => o.seq));
      state.view.observations.push(...s.observations.filter(o => !seen.has(o.seq)));
    }
    const last = state.view.observations.at(-1);
    state.cursor = last ? tOf(last.collectedAtMs) : 0;
    const healthy = s.state === 'running' && last && Date.now() - (s.startedAtUnixMs ?? 0) > 0;
    $('connection').textContent = s.state.toUpperCase();
    $('connection').className = `badge ${s.state === 'running' ? 'conn-ok' : 'conn-bad'}`;
    if (s.state !== 'running') {
      const ended = s.terminal === 'completed' ? 'Live run finished and scored from receipts: select it under Recorded run.'
        : s.terminal === 'stopped' ? 'Run stopped by the operator: the partial capture is retained but not scored.'
          : s.state === 'finished' ? `Live run ended (${s.terminal ?? 'unknown'}); see its recorded bundle.`
            : 'Live run disconnected: the display below is stale and no longer reflects the network.';
      banner(ended, s.state === 'finished' ? 'info' : 'error');
      stopPolling(); render(); await loadRuns(); return;
    }
    banner(healthy ? null : 'Waiting for the first observation…', 'info');
    render();
  } catch (error) {
    $('connection').textContent = 'DISCONNECTED';
    $('connection').className = 'badge conn-bad';
    banner(`Lost contact with the server: ${error.message}. The display is stale.`);
  }
  state.timer = setTimeout(pollLive, 1000);
}

async function startLive() {
  try {
    const s = await api('/api/lifeline/live/start', { scenario: $('scenario').value, controller: $('controller').value });
    state.view = { manifest: { runId: s.liveId, trafficStartAtMs: Infinity, durationMs: 180000 }, events: [], observations: [], topology: (await api(`/api/lifeline/live?liveId=${encodeURIComponent(s.liveId)}`)).topology, summary: null };
    state.live = { liveId: s.liveId, lastSeq: 0 };
    setMode(s.mode, s.liveId);
    $('fault-link').innerHTML = state.view.topology.links.map(l => `<option>${esc(l.linkId)}</option>`).join('');
    $('stop').disabled = false; $('inject').disabled = false;
    banner('Building the emulated network and starting traffic…', 'info');
    pollLive();
  } catch (error) { banner(error.data?.code === 'provider_unavailable' ? 'The Meta-assisted controller needs MODEL_API_KEY on the server.' : `Could not start: ${error.message}`); }
}

async function inject() {
  const kind = $('fault-kind').value;
  const body = { liveId: state.live?.liveId, kind, linkId: $('fault-link').value, ...(kind === 'link_rate' ? { bwMbit: 3 } : {}), ...(kind === 'link_loss' ? { lossPercent: 40 } : {}) };
  try { await api('/api/lifeline/live/fault', body); banner(`Queued ${kind.replace('_', ' ')} on ${body.linkId}; it will appear in the timeline when applied.`, 'info'); }
  catch (error) { banner(`Fault refused: ${error.message}`); }
}

$('load').addEventListener('click', () => loadRun($('runs').value).catch(e => banner(e.message)));
$('start').addEventListener('click', startLive);
$('stop').addEventListener('click', () => api('/api/lifeline/live/stop', { liveId: state.live?.liveId }).catch(e => banner(e.message)));
$('inject').addEventListener('click', inject);
$('cursor').addEventListener('input', e => { if (!state.live) { state.cursor = Number(e.target.value); render(); } });
$('play').addEventListener('click', () => {
  if (state.playing) { clearInterval(state.playing); state.playing = null; $('play').textContent = '▶ Play'; return; }
  state.cursor = 0; $('play').textContent = '❚❚ Pause';
  state.playing = setInterval(() => {
    state.cursor = Math.min(Number($('cursor').max), state.cursor + 1);
    $('cursor').value = state.cursor; render();
    if (state.cursor >= Number($('cursor').max)) { clearInterval(state.playing); state.playing = null; $('play').textContent = '▶ Play'; }
  }, 250);
});

(async () => {
  await loadRuns().catch(e => banner(e.message));
  await loadComparison();
  const first = $('runs').value;
  if (first) await loadRun(first).catch(e => banner(e.message));
})();
