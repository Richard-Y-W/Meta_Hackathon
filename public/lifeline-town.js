// LIFELINE town view. Polls one live session; every value shown comes from the server snapshot.
const $ = id => document.getElementById(id);
const S = 1e6;
let meta = null, snap = { state: 'idle' };
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const t = us => (us === null || us === undefined ? '—' : `${(us / S / 60).toFixed(1)} min`);
const pct = v => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await r.json();
  if (!r.ok) throw new Error(data.error === 'stale_run' ? `This page was showing an old run; the current run is ${data.current ?? 'none'}.` : data.error);
  return data;
}

function spark(values, lo, hi) {
  const pts = values.filter(v => v !== null && v !== undefined);
  if (pts.length < 2) return '';
  const xy = pts.map((v, i) => `${(i / (pts.length - 1)) * 100},${30 - ((v - lo) / (hi - lo || 1)) * 28}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><polyline points="${xy}"/></svg>`;
}
function strip(label, value, fraction, series, lo, hi, note = '') {
  const cls = fraction === null ? '' : fraction >= 0.99 ? '' : fraction >= 0.5 ? 'warn' : 'bad';
  return `<div class="strip"><div class="row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>
    <div class="bar ${cls}" role="img" aria-label="${esc(label)} ${esc(value)}"><span data-w="${Math.max(0, Math.min(1, fraction ?? 0)) * 100}"></span></div>
    ${spark(series, lo, hi)}${note ? `<div class="muted">${esc(note)}</div>` : ''}</div>`;
}

function render() {
  const s = snap;
  $('state').textContent = s.state === 'idle' ? 'idle' : `${s.state} · ${s.runId}`;
  $('state').className = `badge ${s.state}`;
  $('mode').textContent = s.clock ? `${s.clock.mode.replace('_', ' ')} ${s.clock.acceleration}× · modeled communications · ${s.provider?.state ?? ''}` : 'accelerated modeled 60× · modeled communications';
  $('clock').textContent = s.state === 'idle' ? '' : `simulated ${t(s.nowUs)} of ${t(s.durationUs)} · controller ${s.controller}`;
  const running = s.state === 'running';
  $('start').disabled = running; $('stop').disabled = !running; $('inject').disabled = !running;
  const ex = $('export');
  if (s.runId) { ex.href = `/api/town/live/export?runId=${encodeURIComponent(s.runId)}`; ex.classList.remove('disabled'); ex.removeAttribute('aria-disabled'); }
  if (s.state === 'disconnected') $('fault-note').textContent = `Worker lost (${s.error?.code}): the run did not finish; no further results.`;
  const series = s.series ?? [];
  const last = series.at(-1) ?? {};
  const a = s.assets ?? {};
  const gen = a.resources?.['gen-portable'];
  $('services').innerHTML = s.state === 'idle' ? '<p class="muted">Start a run to see measured services.</p>'
    : strip('Hospital water delivered', pct(last.hospitalWaterFraction), last.hospitalWaterFraction ?? null, series.map(x => x.hospitalWaterFraction), 0, 1)
    + strip('Essential electricity served', pct(last.essentialPowerFraction), last.essentialPowerFraction ?? null, series.map(x => x.essentialPowerFraction), 0, 1, 'emergency centre, water pumping, hospital feeders')
    + strip('Tank T1 level (reserve)', last.tankLevelM === undefined ? '—' : `${last.tankLevelM.toFixed(2)} m`, last.tankLevelM === undefined ? null : (last.tankLevelM - 0.5) / 4.5, series.map(x => x.tankLevelM), 0.5, 5, 'usable 0.5–5.0 m')
    + (gen ? strip('Portable generator fuel', `${(gen.fuelJ / 1e6).toFixed(0)} MJ`, gen.fuelJ / 120e6, [], 0, 1, gen.allocatedTo ? `allocated to ${gen.allocatedTo}${gen.tripped ? ' · TRIPPED' : ''}` : 'not dispatched') : '')
    + (s.truth ? `<p><strong>Final measured result:</strong> essential water unmet ${s.truth.water.essentialUnmetM3.toFixed(2)} m³ · essential electricity unserved ${(s.truth.power.essentialUnservedJ / 1e6).toFixed(0)} MJ</p>` : '');
  // CSP forbids inline style attributes; widths are set through the CSSOM.
  for (const el of $('services').querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
  const pumps = last.pumps ?? {};
  const routers = last.routers ?? {};
  $('assets').innerHTML = s.state === 'idle' ? '' : `<table><thead><tr><th>Asset</th><th>State</th><th>Depends on</th></tr></thead><tbody>
    ${Object.entries(a.switches ?? {}).map(([k, v]) => `<tr><td>Tie ${esc(k)}</td><td class="${v === 'closed' ? 'good' : ''}">${esc(v)}</td><td>substation link (rt-sub)</td></tr>`).join('')}
    ${Object.entries(pumps).map(([k, v]) => `<tr><td>Pump ${esc(k)}</td><td class="${v.running ? 'good' : 'bad'}">${v.running ? 'running' : 'stopped'}${v.powered === false ? ' · no supply' : ''}${v.commanded ? '' : ' · commanded off'}</td><td>${k === 'PU1' ? 'bus 7 or generator' : 'bus 14'}</td></tr>`).join('')}
    <tr><td>Pump station</td><td>${esc(a.stationMode ?? '—')}</td><td>local control (station power only)</td></tr>
    <tr><td>Residential valve PZ</td><td>${(a.closedLinks ?? []).includes('PZ') ? '<span class="warnc">closed (zone shed)</span>' : 'open'}</td><td>tank T1</td></tr>
    ${Object.entries(routers).map(([k, v]) => `<tr><td>Router ${esc(k)}</td><td class="${v.up ? 'good' : 'bad'}">${v.up ? 'up' : 'down'}${v.onMains ? '' : ` · battery ${(v.batteryJ / 1e3).toFixed(0)} kJ`}</td><td>${k === 'rt-pump' ? 'bus 7' : k === 'rt-sub' ? 'bus 14' : 'bus 12'}</td></tr>`).join('')}
    </tbody></table>`;
  $('timeline').innerHTML = (s.timeline ?? []).slice().reverse().map(e => {
    if (e.kind === 'judge_fault') return `<li><span class="tag">judge</span>${esc(e.fault.type)} ${esc(e.fault.assetId)} · requested ${t(e.requestedAtUs)}, effective ${t(e.effectAtUs)}</li>`;
    if (e.kind === 'event') return `<li><span class="tag">observed</span>${esc(e.type.replaceAll('_', ' '))} ${esc(e.assetId ?? '')} at ${t(e.atUs)}</li>`;
    if (e.kind === 'decision') return `<li><span class="tag">${esc(e.layer)}</span>plan ${esc(e.plan)} (asked ${t(e.requestedAtUs)}, ready ${t(e.availableUs)})${e.predicted ? ` · <em>predicted</em> (${esc(e.predicted.scenario)}): essential water unmet ${e.predicted.waterEssentialUnmetM3.toFixed(1)} m³, electricity ${(e.predicted.powerEssentialUnservedJ / 1e6).toFixed(0)} MJ` : ''}</li>`;
    if (e.kind === 'command') return `<li><span class="tag">action</span>${esc(e.action ? `${e.action.type} ${JSON.stringify(e.action.params)}` : e.id)} → <strong class="${e.status === 'delivered' ? 'good' : 'bad'}">${esc(e.status)}</strong>${e.reason ? ` (${esc(e.reason)})` : ''} at ${t(e.atUs)}</li>`;
    return `<li>${esc(JSON.stringify(e))}</li>`;
  }).join('');
  $('raw').textContent = JSON.stringify({ runId: s.runId, state: s.state, clock: s.clock, layers: s.layers, error: s.error, nowUs: s.nowUs }, null, 2);
}

async function poll() {
  try { snap = await api('/api/town/live'); render(); } catch (e) { $('state').textContent = `server unreachable: ${e.message}`; $('state').className = 'badge disconnected'; }
}

async function init() {
  meta = await api('/api/town/cases');
  $('case').innerHTML = meta.cases.map(c => `<option>${esc(c.caseId)}</option>`).join('');
  $('controller').innerHTML = meta.controllers.map(c => `<option>${esc(c)}</option>`).join('');
  $('fault-type').innerHTML = Object.keys(meta.judgeFaults).map(k => `<option>${esc(k)}</option>`).join('');
  const assets = () => { $('fault-asset').innerHTML = meta.judgeFaults[$('fault-type').value].map(a => `<option>${esc(a)}</option>`).join(''); };
  $('fault-type').addEventListener('change', assets); assets();
  $('start').addEventListener('click', async () => { try { snap = await api('/api/town/live/start', { caseId: $('case').value, controller: $('controller').value }); $('fault-note').textContent = ''; render(); } catch (e) { $('fault-note').textContent = e.message; } });
  $('stop').addEventListener('click', async () => { try { snap = await api('/api/town/live/stop', { runId: snap.runId }); render(); } catch (e) { $('fault-note').textContent = e.message; } });
  $('inject').addEventListener('click', async () => {
    try { const r = await api('/api/town/live/fault', { runId: snap.runId, fault: { type: $('fault-type').value, assetId: $('fault-asset').value } }); $('fault-note').textContent = `Injected; takes effect at ${t(r.injected.effectAtUs)}.`; }
    catch (e) { $('fault-note').textContent = e.message; }
  });
  await poll();
  setInterval(poll, 1000);
}
init();
