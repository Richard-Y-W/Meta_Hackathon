// LIFELINE operations view. Every value comes from the live server snapshot or the recorded results file;
// nothing on this page is invented. Layout follows situation-awareness levels: detect (warning signs),
// predict (simulated spread), coordinate (what LIFELINE armed and did), on a gray map where color marks
// only what is abnormal (red lost, amber threatened) or changed by LIFELINE (blue).
const $ = id => document.getElementById(id);
const S = 1e6, MIN = 60 * S;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tmin = us => (us == null ? '—' : `T+${Math.round(us / MIN)}`);
const pct = v => (v == null ? '—' : `${(v * 100).toFixed(v >= 0.995 ? 0 : 1)}%`);
let meta = null, snap = { state: 'idle' }, view = 'power', results = null;
let selectedAsset = null, zoom = 1, busy = false, connected = false;
const prevTileValue = {};
const icons = {
  water: '<path d="M12 2S5 10 5 14a7 7 0 0 0 14 0c0-4-7-12-7-12Z"/><path d="M8 14a4 4 0 0 0 4 4"/>',
  power: '<path d="m13 2-8 12h6l-1 8 9-13h-7l1-7Z"/>',
  tank: '<path d="M5 5c0-4 14-4 14 0v14c0 4-14 4-14 0V5Zm0 0c0 4 14 4 14 0M5 12c0 4 14 4 14 0"/>',
  comms: '<path d="M12 14v8m-4 0h8M8 7a6 6 0 0 0 0 8m8-8a6 6 0 0 1 0 8M5 4a10 10 0 0 0 0 14M19 4a10 10 0 0 1 0 14"/><circle cx="12" cy="11" r="2"/>'
};
const icon = name => `<svg class="metric-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
function emptyState(title, description) {
  return `<div class="empty-state"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12"/><path d="M4 16h7l3-6 4 12 3-6h7"/></svg><strong>${esc(title)}</strong><p>${esc(description)}</p></div>`;
}
function notice(message = '') { $('notice').hidden = !message; $('notice').textContent = message; }

// Town layout: positions on the map, by bus. Lines and ties follow the simulated CIGRE feeder.
const P = { 'bus-1': [70, 330], 'bus-2': [175, 330], 'bus-3': [290, 330], 'bus-4': [420, 410], 'bus-5': [560, 455], 'bus-6': [700, 470],
  'bus-7': [640, 285], 'bus-8': [500, 205], 'bus-9': [620, 110], 'bus-10': [770, 95], 'bus-11': [905, 150],
  'bus-12': [70, 80], 'bus-13': [185, 105], 'bus-14': [300, 145] };
const LINES = { 'line-1-2': ['bus-1', 'bus-2'], 'line-2-3': ['bus-2', 'bus-3'], 'line-3-4': ['bus-3', 'bus-4'], 'line-4-5': ['bus-4', 'bus-5'], 'line-5-6': ['bus-5', 'bus-6'],
  'line-7-8': ['bus-7', 'bus-8'], 'line-8-9': ['bus-8', 'bus-9'], 'line-9-10': ['bus-9', 'bus-10'], 'line-10-11': ['bus-10', 'bus-11'], 'line-3-8': ['bus-3', 'bus-8'],
  'line-12-13': ['bus-12', 'bus-13'], 'line-13-14': ['bus-13', 'bus-14'] };
const TIES = { 'sw-S1': ['bus-14', 'bus-8'], 'sw-S2': ['bus-6', 'bus-7'], 'sw-S3': ['bus-11', 'bus-4'] };
const PLACES = { 'bus-1': 'Substation A', 'bus-2': 'River crossing', 'bus-3': 'Main St · clinic', 'bus-4': 'School district', 'bus-5': 'East industrial', 'bus-6': 'Bus depot',
  'bus-7': 'Pump station', 'bus-8': 'Ridge junction', 'bus-9': 'Hospital', 'bus-10': 'Fire station', 'bus-11': 'North housing', 'bus-12': 'Substation B', 'bus-13': 'West mall', 'bus-14': 'West housing' };
const ESSENTIAL = new Set(['bus-3', 'bus-7', 'bus-9']);
// Label placement per bus [dx, dy] so names sit clear of lines.
const LABEL = { 'bus-1': [-30, 36], 'bus-2': [-40, -16], 'bus-3': [-110, 30], 'bus-4': [-120, 26], 'bus-5': [-44, 32], 'bus-6': [14, 26], 'bus-7': [18, 26],
  'bus-8': [16, 6], 'bus-9': [-30, -20], 'bus-10': [-36, -18], 'bus-11': [-20, 34], 'bus-12': [-30, -22], 'bus-13': [-26, -16], 'bus-14': [-60, 34] };
const TIE_AT = { 'sw-S1': 0.45, 'sw-S2': 0.5, 'sw-S3': 0.28 };
const TOWER = [395, 245];

// Building sprites: every facility renders in the same visual language as the hospital
// (white shell, a colored icon badge, small windows that go dark with the facility) —
// status reads through the shell's outline/fill, not a recolor of the whole glyph, so
// "what this is" and "is it okay" never compete for the same pixel. Junctions aren't
// real facilities (just electrical connection points), so they stay plain nodes.
const BUS_TYPE = { 'bus-1': 'substation', 'bus-12': 'substation', 'bus-3': 'clinic', 'bus-4': 'school', 'bus-5': 'industrial',
  'bus-6': 'depot', 'bus-7': 'pump', 'bus-8': 'junction', 'bus-2': 'junction', 'bus-10': 'fire', 'bus-11': 'housing', 'bus-13': 'mall', 'bus-14': 'housing' };
const BUS_SIZE = { 'bus-1': [34, 28], 'bus-12': [34, 28], 'bus-3': [28, 22], 'bus-4': [27, 21], 'bus-5': [25, 20], 'bus-6': [25, 20],
  'bus-7': [28, 23], 'bus-10': [27, 22], 'bus-11': [24, 19], 'bus-13': [27, 21], 'bus-14': [24, 19] };
const BWINDOWS = { substation: 0, clinic: 3, school: 3, industrial: 2, depot: 2, pump: 2, fire: 2, housing: 2, mall: 2 };
const BICON = {
  substation: '<path d="M1 -7 L-4 1 L-1 1 L-2 7 L4 -2 L1 -2 Z"/>',
  clinic: '<path d="M-2 -6 L2 -6 L2 -2 L6 -2 L6 2 L2 2 L2 6 L-2 6 L-2 2 L-6 2 L-6 -2 L-2 -2 Z"/>',
  school: '<path d="M-6 -1 L0 -4 L6 -1 L0 2 Z"/><rect x="-1" y="2" width="2" height="5"/>',
  industrial: '<path d="M-2 -5 L2 -5 L5 -2 L5 2 L2 5 L-2 5 L-5 2 L-5 -2 Z"/>',
  depot: '<rect x="-6" y="-4" width="12" height="7" rx="1"/><rect x="-5" y="4" width="3" height="2.5"/><rect x="2" y="4" width="3" height="2.5"/>',
  pump: '<path d="M-3 -5 L5 0 L-3 5 Z"/>',
  fire: '<rect x="-5" y="-6" width="2" height="12"/><rect x="3" y="-6" width="2" height="12"/><rect x="-5" y="-4" width="10" height="1.6"/><rect x="-5" y="0" width="10" height="1.6"/><rect x="-5" y="4" width="10" height="1.6"/>',
  housing: '<path d="M-6 1 L0 -6 L6 1 L4 1 L4 6 L-4 6 L-4 1 Z"/>',
  mall: '<path d="M-5 -2 L5 -2 L4 6 L-4 6 Z"/><rect x="-2" y="-5" width="4" height="3"/>',
};
function spriteBuilding(x, y, w, h, st, type, iconSvg, windows) {
  const dark = st === 'dark';
  const tx = x - w / 2, ty = y - h;
  let wins = '';
  if (windows > 0) {
    const ws = Math.max(4, Math.min(7, Math.floor((w - 10) / windows) - 2));
    const totalW = windows * ws + (windows - 1) * 3;
    const wx0 = tx + (w - totalW) / 2, wy = ty + h - ws - 4;
    for (let i = 0; i < windows; i++) wins += `<rect class="sprite-win ${!dark ? 'lit' : ''}" x="${(wx0 + i * (ws + 3)).toFixed(1)}" y="${wy.toFixed(1)}" width="${ws}" height="${ws}"/>`;
  }
  return `<g class="sprite-bldg ${type} ${dark ? 'dark' : ''}">
    <g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)})">
      <rect class="sprite-shell" width="${w}" height="${h}" rx="3"/>
      <g class="sprite-icon" transform="translate(${(w / 2).toFixed(1)} ${(h * 0.38).toFixed(1)})">${iconSvg}</g>
      ${wins}
    </g></g>`;
}
function isoNode(b, x, y, st) {
  const type = BUS_TYPE[b] ?? 'junction';
  if (type === 'junction') {
    const dark = st === 'dark';
    return `<circle class="junction-dot ${dark ? 'dark' : ''}" cx="${x}" cy="${y}" r="6"/>`;
  }
  const [w, h] = BUS_SIZE[b] ?? [24, 19];
  return spriteBuilding(x, y + h / 4, w, h, st, type, BICON[type], BWINDOWS[type]);
}

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

function busState(s, b) {
  const buses = s.assets?.buses ?? {};
  if (b === 'bus-1' || b === 'bus-12') { const all = Object.values(buses); return all.length && all.every(v => v === 'dark') ? 'dark' : 'live'; }
  return buses[b] ?? 'unknown';
}
const threatened = s => new Set((s.lifeline?.threats ?? []).map(t => t.assetId));
// Lines that have failed in the scenario so far (display only; reported by the server after they happen).
function failedLines(s) {
  const out = new Set();
  for (const e of (s.scenarioEvents ?? []).slice().sort((a, b) => a.atUs - b.atUs)) { if (e.type === 'line_trip') out.add(e.assetId); if (e.type === 'line_restore') out.delete(e.assetId); }
  return out;
}

function powerMap(s) {
  const th = threatened(s), failed = failedLines(s), out = [];
  out.push('<rect class="district" x="38" y="48" width="325" height="165" rx="18"/><text class="district-label" x="58" y="186">WEST FEEDER</text><rect class="district" x="566" y="50" width="390" height="150" rx="18"/><text class="district-label" x="590" y="177">NORTH RIDGE</text><path class="district" d="M42 278H345L466 380H750V520H42Z"/><text class="district-label" x="65" y="493">MAIN STREET FEEDER</text>');
  for (const [id, [a, b]] of Object.entries(LINES)) {
    const [x1, y1] = P[a], [x2, y2] = P[b];
    const mid = id === 'line-3-8' ? `Q ${TOWER[0] - 20} ${TOWER[1] - 10} ${x2} ${y2}` : `L ${x2} ${y2}`;
    const down = failed.has(id);
    const dark = down || busState(s, a) === 'dark' || busState(s, b) === 'dark';
    const isThreat = th.has(id) && !dark;
    if (isThreat) out.push(`<path class="halo" d="M ${x1} ${y1} ${mid}"/>`);
    out.push(`<path class="ln ${dark ? 'dark' : isThreat ? 'threat' : ''}" id="ln-${id}" d="M ${x1} ${y1} ${mid}"><title>${esc(id)}: ${esc(meta?.landmarks?.[id] ?? '')}</title></path>`);
    if (!dark && !isThreat && s.assets && busState(s, b) === 'live') {
      out.push(`<path class="flow-overlay" d="M ${x1} ${y1} ${mid}"/>`);
      out.push(`<circle class="flow-pulse" r="3"><animateMotion dur="2.6s" repeatCount="indefinite"><mpath href="#ln-${id}"/></animateMotion></circle>`);
    }
    if (down) { const mx = id === 'line-3-8' ? TOWER[0] - 10 : (x1 + x2) / 2, my = id === 'line-3-8' ? TOWER[1] + 30 : (y1 + y2) / 2 + 22; out.push(`<text class="lbl lost" x="${mx}" y="${my}">✕ ${esc(id)} FAILED</text>`); }
  }
  for (const [id, [a, b]] of Object.entries(TIES)) {
    const closed = s.assets?.switches?.[id] === 'closed';
    const [x1, y1] = P[a], [x2, y2] = P[b];
    out.push(`<path class="tie ${closed ? 'closed' : ''}" id="ln-${id}" d="M ${x1} ${y1} L ${x2} ${y2}"><title>tie ${esc(id)} ${closed ? 'closed' : 'open'}</title></path>`);
    if (closed) {
      out.push(`<path class="flow-overlay intervention" d="M ${x1} ${y1} L ${x2} ${y2}"/>`);
      out.push(`<circle class="flow-pulse intervention" r="3"><animateMotion dur="2.2s" repeatCount="indefinite"><mpath href="#ln-${id}"/></animateMotion></circle>`);
    }
    const f = TIE_AT[id];
    out.push(`<text class="lbl ${closed ? 'acted' : ''}" x="${x1 + (x2 - x1) * f + 8}" y="${y1 + (y2 - y1) * f - 8}">${esc(id.replace('sw-', 'tie '))}${closed ? ' · closed by LIFELINE' : ''}</text>`);
  }
  // water tower beside the ridge line
  out.push(`<rect class="bus" x="${TOWER[0] - 9}" y="${TOWER[1] - 26}" width="18" height="22" rx="3"/><text class="lbl" x="${TOWER[0] - 104}" y="${TOWER[1] - 12}">water tower</text>`);
  for (const [b, [x, y]] of Object.entries(P)) {
    const st = busState(s, b);
    if (ESSENTIAL.has(b)) out.push(`<circle class="essential-halo ${st === 'dark' ? 'dark' : ''}" cx="${x}" cy="${y}" r="20"/>`);
    out.push(`<g class="asset-hit ${selectedAsset === b ? 'selected' : ''}" data-asset="${b}" role="button" tabindex="0" aria-label="Inspect ${esc(PLACES[b])}"><title>${esc(PLACES[b])} · ${esc(b)} · ${st === 'unknown' ? 'Awaiting telemetry' : st === 'dark' ? 'No power' : 'Energized'}</title><circle class="hit" cx="${x}" cy="${y}" r="23"/>`);
    if (b === 'bus-9') {
      out.push(`<g transform="translate(${x - 15} ${y - 18})"><rect class="hospital-bldg ${st === 'dark' ? 'dark' : ''}" width="30" height="32" rx="2"/>
        <path class="hospital-cross" d="M13 6h4v4h4v4h-4v4h-4v-4H9v-4h4z"/>
        <rect class="hwin ${st !== 'dark' ? 'lit' : ''}" x="5" y="21" width="5" height="6"/><rect class="hwin ${st !== 'dark' ? 'lit' : ''}" x="13" y="21" width="5" height="6"/><rect class="hwin ${st !== 'dark' ? 'lit' : ''}" x="21" y="21" width="5" height="6"/></g>`);
    } else {
      out.push(isoNode(b, x, y, st));
    }
    const strong = ESSENTIAL.has(b) || b === 'bus-1' || b === 'bus-12';
    const [dx, dy] = LABEL[b];
    out.push(`<text class="lbl ${st === 'dark' ? 'lost' : strong ? 'strong' : ''}" x="${x + dx}" y="${y + dy}">${esc(PLACES[b])}${st === 'dark' ? ' · NO POWER' : ''}</text>`);
    out.push('</g>');
  }
  return out.join('');
}

function waterMap(s) {
  const last = (s.series ?? []).at(-1) ?? {};
  const pumps = last.pumps ?? {};
  const level = last.tankLevelM, hosp = last.hospitalWaterFraction;
  const pz = (s.assets?.closedLinks ?? []).includes('PZ');
  const T = { x: 470, y: 300, w: 120, h: 210 };
  const fill = level == null ? 0 : Math.max(0, Math.min(1, (level - 0.5) / 4.5));
  const fillCls = level != null && level < 0.8 ? 'empty' : level != null && level < 1.5 ? 'low' : '';
  const deliver = hosp == null ? '' : hosp >= 0.99 ? 'flow' : 'dry';
  const pipe = (d, cls) => `<path class="pipe ${cls}" d="${d}"/>`;
  const pump = (id, x, y, name, bus) => {
    const p = pumps[id] ?? {};
    const powered = busState(s, bus) !== 'dark' && p.powered !== false;
    const state = !s.assets ? 'awaiting telemetry' : p.running ? 'running' : powered ? 'idle' : 'NO POWER';
    return `<circle class="pump ${p.running ? '' : powered ? 'maint' : 'off'}" cx="${x}" cy="${y}" r="26"/>
      <text class="lbl strong" x="${x - 15}" y="${y + 6}">${id}</text>
      <text class="lbl strong" x="${x - 70}" y="${y - 40}">${esc(name)}</text>
      <text class="lbl ${state === 'NO POWER' ? 'lost' : ''}" x="${x - 70}" y="${y + 50}">${state}</text>
      <text class="lbl" x="${x - 70}" y="${y + 70}">power: ${esc(PLACES[bus])}${!s.assets ? '' : powered ? ' ✓' : ' ✕'}</text>`;
  };
  const out = (y, name, value, cls) => `<rect class="bus" x="800" y="${y - 24}" width="170" height="48" rx="6"/>
      <text class="lbl strong" x="814" y="${y - 3}">${esc(name)}</text><text class="lbl ${cls}" x="814" y="${y + 16}">${esc(value)}</text>`;
  return [
    `<text class="lbl" x="40" y="40">Water: pumps fill the tower; the tower feeds the town. Pumps need power: this is where the two networks meet.</text>`,
    pipe(`M 196 190 H 410 V ${T.y - 60} H ${T.x - T.w / 2}`, pumps.PU2?.running ? 'flow' : 'shut'),
    pipe(`M 196 410 H 410 V ${T.y + 60} H ${T.x - T.w / 2}`, pumps.PU1?.running ? 'flow' : 'shut'),
    pipe(`M ${T.x + T.w / 2} ${T.y - 60} H 700 V 150 H 800`, deliver),
    pipe(`M ${T.x + T.w / 2} ${T.y} H 800`, deliver),
    pipe(`M ${T.x + T.w / 2} ${T.y + 60} H 700 V 450 H 800`, pz ? 'shut' : deliver),
    `<rect class="tankshell" x="${T.x - T.w / 2}" y="${T.y - T.h / 2}" width="${T.w}" height="${T.h}" rx="10"/>`,
    `<clipPath id="tank-clip"><rect x="${T.x - T.w / 2 + 4}" y="${T.y - T.h / 2 + 4}" width="${T.w - 8}" height="${T.h - 8}" rx="6"/></clipPath>`,
    `<g clip-path="url(#tank-clip)"><rect class="tankfill ${fillCls}" x="${T.x - T.w / 2 + 4}" y="${T.y + T.h / 2 - 4 - (T.h - 8) * fill}" width="${T.w - 8}" height="${(T.h - 8) * fill + 20}" rx="6"/>
      ${level != null ? `<path class="tank-ripple" d="M ${T.x - T.w / 2 - 10} ${T.y + T.h / 2 - 4 - (T.h - 8) * fill} q 15 -5 30 0 t 30 0 t 30 0 t 30 0 v 6 h -120 Z"/>` : ''}</g>`,
    `<text class="lbl strong" x="${T.x - 70}" y="${T.y - T.h / 2 - 14}">Water tower T1</text>`,
    `<text class="lbl strong" x="${T.x - 40}" y="${T.y + T.h / 2 + 26}">${level == null ? '—' : `${level.toFixed(2)} m`}</text>`,
    pump('PU2', 170, 190, 'Backup pump', 'bus-14'), pump('PU1', 170, 410, 'Pump station', 'bus-7'),
    `<rect class="bus" x="676" y="438" width="48" height="24" rx="4"/><text class="lbl ${pz ? 'acted' : ''}" x="660" y="485">valve PZ ${pz ? 'shut' : 'open'}</text>`,
    out(150, 'Hospital', `${pct(hosp)} delivered`, hosp != null && hosp < 0.99 ? 'lost' : ''),
    out(300, 'Fire station', hosp == null ? '—' : hosp >= 0.99 ? 'supplied' : 'pressure low', hosp != null && hosp < 0.99 ? 'lost' : ''),
    out(450, 'Residential', !s.assets ? 'awaiting telemetry' : pz ? 'shed to save the hospital' : 'supplied', pz ? 'acted' : ''),
  ].join('');
}

function tile(id, label, value, sub, cls) {
  $(id).className = `tile ${cls}`;
  const key = id.replace('tile-', '');
  const field = { water: 'hospitalWaterFraction', power: 'essentialPowerFraction', tank: 'tankLevelM' }[key];
  const values = field ? (snap.series ?? []).map(p => p[field]).filter(Number.isFinite) : [];
  let spark = '';
  if (values.length > 1) {
    const lo = key === 'tank' ? 0.5 : 0, hi = key === 'tank' ? 5 : 1;
    spark = `<svg class="spark" viewBox="0 0 80 25" aria-hidden="true"><path d="${values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1) * 80).toFixed(1)},${(24 - Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 22).toFixed(1)}`).join(' ')}"/></svg>`;
  }
  $(id).innerHTML = `<div class="label">${esc(label)}${icon(key)}</div><div class="value ${String(value).length > 9 ? 'long' : ''}">${esc(value)}</div><div class="sub">${esc(value === '—' ? 'Awaiting telemetry' : sub)}</div>${spark}`;
  const changed = prevTileValue[id] !== undefined && prevTileValue[id] !== value && value !== '—';
  prevTileValue[id] = value;
  if (changed) {
    const v = $(id).querySelector('.value');
    v.classList.remove('flash'); void v.offsetWidth; v.classList.add('flash');
  }
}

function renderTiles(s) {
  const last = (s.series ?? []).at(-1) ?? {};
  const threats = s.lifeline?.threats ?? [];
  const riskW = threats.some(t => t.spread?.waterEssentialUnmetM3 > 0.01 && !t.actNow);
  const riskP = threats.some(t => t.spread?.powerEssentialUnservedJ > 1e6 && !t.actNow);
  const guarded = threats.some(t => t.actNow);
  const w = last.hospitalWaterFraction, p = last.essentialPowerFraction, lv = last.tankLevelM;
  tile('tile-water', 'Hospital water', pct(w), w != null && w < 0.99 ? 'service lost' : riskW ? 'at risk: predicted loss' : guarded ? 'protected by LIFELINE' : 'normal', w != null && w < 0.99 ? 'lost' : riskW ? 'threat' : guarded ? 'acted' : '');
  tile('tile-power', 'Essential power', pct(p), p != null && p < 0.99 ? 'clinic, pump station or hospital dark' : riskP ? 'at risk: predicted loss' : guarded ? 'protected by LIFELINE' : 'clinic · pump station · hospital', p != null && p < 0.99 ? 'lost' : riskP ? 'threat' : guarded ? 'acted' : '');
  tile('tile-tank', 'Water reserve', lv == null ? '—' : `${lv.toFixed(2)} m`, 'water tower T1, usable 0.5–5 m', lv != null && lv < 0.8 ? 'lost' : lv != null && lv < 1.5 ? 'threat' : '');
  const routers = last.routers ?? {};
  const down = Object.entries(routers).filter(([, r]) => !r.up).map(([k]) => k);
  const battery = Object.entries(routers).filter(([, r]) => r.up && !r.onMains).map(([k]) => k);
  tile('tile-comms', 'Control radios', down.length ? `${down.length} down` : battery.length ? `${battery.length} on battery` : Object.keys(routers).length ? 'all on mains' : '—',
    down.length ? `remote control lost: ${down.join(', ')}` : battery.length ? `${battery.join(', ')} running on battery` : 'pump station · substations', down.length ? 'lost' : battery.length ? 'threat' : '');
}

const band = c => (c >= 0.7 ? 'high confidence' : c >= 0.4 ? 'medium confidence' : 'low confidence');
const mj = j => `${Math.round(j / 1e6).toLocaleString()} MJ`;

function renderBrain(s) {
  const lf = s.lifeline;
  if (!lf) {
    const idle = s.state === 'idle';
    $('warnings').innerHTML = `<li class="empty">${idle ? 'Incoming reports appear here when a simulation starts.' : 'Conventional controller active. Warning reports are not interpreted.'}</li>`;
    $('threats').innerHTML = emptyState(idle ? 'Ready when you are' : 'Rules-based operation', idle ? 'Start a scenario to trace a threat across the network and watch LIFELINE respond.' : 'Switch to LIFELINE on the next run to see evidence-backed forecasts.');
    $('actions').innerHTML = `<li class="empty">${idle ? 'No interventions yet.' : 'Conventional control actions are available in the engineering view.'}</li>`; return;
  }
  const log = lf.log ?? [];
  $('warnings').innerHTML = log.filter(e => e.kind === 'warning').map(e => {
    const i = e.text.indexOf(': ');
    return `<li class="warnline"><span class="when">${tmin(e.atUs)}</span><span class="src">${esc(e.text.slice(0, i))}</span><q>${esc(e.text.slice(i + 2))}</q></li>`;
  }).join('') || '<li class="empty">No warning signs yet. Reflexes are armed for any line that fails.</li>';
  $('threats').innerHTML = (lf.threats ?? []).map(t => {
    const sp = t.spread;
    const name = meta?.landmarks?.[t.assetId] ?? t.assetId;
    return `<div class="threat-card"><div class="head"><span class="asset">${esc(t.assetId)}</span><span class="band">${band(t.confidence)}</span></div>
      <div class="muted">${esc(name)} · may fail between ${tmin(t.assessedAtUs + t.windowMin[0] * MIN)} and ${tmin(t.assessedAtUs + t.windowMin[1] * MIN)}</div>
      <p class="why">${esc(t.why)} <span class="muted">(from ${esc(t.evidence.join(', '))})</span></p>
      ${(t.actNow?.chain ?? sp?.chain) ? `<div class="muted">Predicted spread with no action${t.actNow ? ` (assessed ${tmin(t.actNow.atUs)})` : ''}:</div><ol class="chain">${(t.actNow?.chain ?? sp.chain).map(x => `<li><span class="t">${tmin(x.atUs)}</span><span>${esc(x.text)}</span></li>`).join('')}</ol>` : ''}
      <div class="verdict">${t.actNow ? `<span class="acted">${t.actNow.done ? 'Protected: ' : 'Act now: '}${esc(t.actNow.label)}${t.actNow.done ? ` at ${tmin(t.actNow.atUs)}` : ''}</span>
        <div class="cmp"><div>If it fails, no action<br><span class="bad">${t.actNow.without.waterEssentialUnmetM3.toFixed(1)} m³ water · ${mj(t.actNow.without.powerEssentialUnservedJ)}</span></div>
        <div>If it fails, with LIFELINE<br><span class="good">${t.actNow.ifThreat.waterEssentialUnmetM3.toFixed(1)} m³ water · ${mj(t.actNow.ifThreat.powerEssentialUnservedJ)}</span></div></div>`
        : sp && sp.waterEssentialUnmetM3 <= 0.01 && sp.powerEssentialUnservedJ <= 1e6 ? 'Predicted: no essential loss even if it fails.'
        : t.reflex?.length ? `Armed: if it fails → close ${esc(t.reflex.join(', then '))}; generator if the pump station stays dark` : 'Monitoring: no switching can help; generator stands by'}</div></div>`;
  }).join('') || emptyState('No active forecast', 'Monitoring incoming signals. Predictions appear when the evidence supports a threat.');
  const cls = { 'act-now': 'act', armed: 'act', 'reflex-fire': 'fire', reflex: 'act', dismissed: 'dismiss', threat: 'warnline', brain: '' };
  $('actions').innerHTML = log.filter(e => e.kind !== 'warning' && e.kind !== 'threat').slice().reverse().map(e =>
    `<li class="${cls[e.kind] ?? ''}"><span class="when">${tmin(e.atUs)}</span>${esc(e.text)}</li>`).join('') || '<li class="empty">Armed and watching.</li>';
}

function renderTimeline(s) {
  const D = s.durationUs ?? 240 * MIN, X = us => 40 + (us / D) * 940;
  const out = [`<line class="axis" x1="40" x2="980" y1="60" y2="60"/>`];
  for (let m = 0; m <= D / MIN; m += 30) out.push(`<text class="tick" x="${X(m * MIN) - 8}" y="76">${m}</text>`);
  const lf = s.lifeline;
  for (const t of lf?.threats ?? []) {
    const a = X(t.assessedAtUs + t.windowMin[0] * MIN), b = X(Math.min(D, t.assessedAtUs + t.windowMin[1] * MIN));
    out.push(`<rect class="win" x="${a}" y="14" width="${Math.max(2, b - a)}" height="40"/><line class="winedge" x1="${a}" x2="${a}" y1="14" y2="54"/><text class="tick" x="${a + 4}" y="27">${esc(t.assetId)} window</text>`);
  }
  for (const e of lf?.log ?? []) {
    const x = X(e.atUs);
    if (e.kind === 'warning') out.push(`<path class="warnmark" d="M ${x} 38 l 6 6 l -6 6 l -6 -6 z"><title>${esc(e.text)}</title></path>`);
    if (e.kind === 'act-now' || e.kind === 'reflex-fire') out.push(`<path class="actmark" d="M ${x} 34 l 7 12 l -14 0 z"><title>${esc(e.text)}</title></path>`);
  }
  for (const e of s.scenarioEvents ?? []) if (e.type !== 'actuator_unavailable') out.push(`<path class="failmark" d="M ${X(e.atUs)} 50 l 7 -12 l -14 0 z"><title>${esc(e.type.replace('_', ' '))} ${esc(e.assetId)}</title></path><text class="tick lostt" x="${X(e.atUs) + 9}" y="48">${esc(e.assetId)} fails</text>`);
  const series = s.series ?? [];
  const Y = v => 150 - v * 56;
  const path = key => series.filter(p => p[key] != null).map((p, i) => `${i ? 'L' : 'M'} ${X(p.atUs).toFixed(1)} ${Y(p[key]).toFixed(1)}`).join(' ');
  let start = null;
  for (const p of series) {
    const low = (p.essentialPowerFraction ?? 1) < 0.99 || (p.hospitalWaterFraction ?? 1) < 0.99;
    if (low && start === null) start = p.atUs;
    if (!low && start !== null) { out.push(`<rect class="lossband" x="${X(start)}" y="92" width="${Math.max(2, X(p.atUs) - X(start))}" height="60"/>`); start = null; }
  }
  if (start !== null) out.push(`<rect class="lossband" x="${X(start)}" y="92" width="${Math.max(2, X(series.at(-1).atUs) - X(start))}" height="60"/>`);
  out.push(`<path class="trace" d="${path('essentialPowerFraction')}"/><path class="trace water" d="${path('hospitalWaterFraction')}"/>`);
  out.push(`<text class="tick" x="984" y="104" text-anchor="end">essential power ─ · hospital water ─ (100% at top)</text><line class="axis" x1="40" x2="980" y1="150" y2="150"/>`);
  if (s.nowUs != null && s.state !== 'idle') out.push(`<line class="now" x1="${X(s.nowUs)}" x2="${X(s.nowUs)}" y1="8" y2="156"/>`);
  $('time').innerHTML = out.join('');
}

function renderResults() {
  if (!results?.rows?.length) { $('results').innerHTML = '<p class="empty">No recorded comparison yet.</p>'; return; }
  $('res-src').textContent = `recorded run · brain: ${results.brain === 'live' ? 'Meta model, live' : results.brain}`;
  const names = { independent: 'Rules only (each utility alone)', hybrid: 'Conventional coordinated', lifeline: 'LIFELINE' };
  const stories = [...new Set(results.rows.map(r => r.storyline))];
  const ctrls = ['independent', 'hybrid', 'lifeline'];
  const cell = r => (r ? r.waterEssentialUnmetM3 * 1e3 + r.powerEssentialUnservedJ / 1e6 : null);
  const body = stories.map(st => {
    const rs = Object.fromEntries(ctrls.map(c => [c, results.rows.find(r => r.storyline === st && r.controller === c)]));
    const best = Math.min(...ctrls.map(c => cell(rs[c])).filter(v => v != null));
    const title = meta?.cases?.find(c => c.caseId === st)?.title ?? st;
    return `<tr><td>${esc(title)}</td>${ctrls.map(c => { const r = rs[c]; if (!r) return '<td class="n">—</td>';
      const lost = r.waterEssentialUnmetM3 > 0.01 || r.powerEssentialUnservedJ > 1e6;
      // Blue only where LIFELINE is best and either lost nothing or did strictly better than every other controller.
      const others = ctrls.filter(k => k !== c).map(k => cell(rs[k])).filter(v => v != null);
      const win = c === 'lifeline' && cell(r) === best && (!lost || others.every(v => cell(r) < v));
      return `<td class="n ${win ? 'best' : lost ? 'lost' : ''}">${r.waterEssentialUnmetM3.toFixed(1)} m³ · ${mj(r.powerEssentialUnservedJ)}</td>`; }).join('')}</tr>`;
  }).join('');
  $('results').innerHTML = `<table><thead><tr><th>Scenario (essential loss: hospital/fire water · essential power)</th>${ctrls.map(c => `<th class="n">${names[c]}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}

function render() {
  const s = snap;
  $('state').textContent = connected ? (s.state === 'idle' ? 'Ready' : s.state) : 'Offline';
  $('state').className = `chip ${s.state === 'running' ? 'running' : s.state === 'disconnected' ? 'bad' : ''}`;
  if (!connected) $('state').className = 'chip bad';
  $('clock').innerHTML = `T+${String(Math.round((s.nowUs ?? 0) / MIN)).padStart(3, '0')} <small>min</small>`;
  $('mode').textContent = `simulated town · ${s.clock?.acceleration ?? 60}× clock`;
  $('brainchip').textContent = s.provider?.state ?? meta?.brain ?? 'Controller unavailable';
  $('brainchip').className = `brain-label ${/live/i.test(s.provider?.state ?? meta?.brain ?? '') ? 'live' : ''}`;
  const chosen = meta?.cases.find(c => c.caseId === $('case').value);
  const story = s.state !== 'idle' ? s : chosen;
  $('story').textContent = story?.story ?? 'Select a scenario and start a simulation to see live service measurements.';
  const running = s.state === 'running';
  $('start').disabled = running || busy || !connected || !meta; $('stop').disabled = !running || busy || !connected;
  $('start').innerHTML = busy ? 'Please wait…' : '<span aria-hidden="true">▶</span> Start simulation';
  $('case').disabled = running || busy; $('controller').disabled = running || busy;
  const threats = s.lifeline?.threats ?? [];
  $('incident-count').textContent = threats.length ? `${threats.length} FORECAST${threats.length > 1 ? 'S' : ''}` : running ? 'MONITORING' : 'STANDBY';
  $('warning-count').textContent = String((s.lifeline?.log ?? []).filter(e => e.kind === 'warning').length);
  $('brain-status').textContent = !connected ? 'Connection lost · reconnecting automatically' : running ? 'Receiving simulation snapshots · 1s interval' : s.state === 'idle' ? 'Waiting for a simulation' : `Simulation ${s.state} · last snapshot retained`;
  $('map-subtitle').textContent = view === 'power' ? '14 BUSES / 2 SUBSTATIONS' : '2 PUMPS / 1 WATER TOWER';
  renderTiles(s);
  renderMap();
  renderBrain(s);
  renderTimeline(s);
}

async function poll() {
  try {
    const next = await api('/api/town/live');
    // A start/stop request owns its resulting snapshot until it has settled.
    if (!busy) snap = next;
    connected = true;
    render();
  } catch {
    connected = false;
    render();
  }
}

function renderMap() {
  // Keep focused SVG controls alive across one-second polls when the map has not changed.
  const markup = view === 'power' ? powerMap(snap) : waterMap(snap);
  if ($('map').innerHTML !== markup) {
    const focused = document.activeElement?.getAttribute('data-asset');
    $('map').innerHTML = markup;
    if (focused) $('map').querySelector(`[data-asset="${focused}"]`)?.focus();
  }
  const width = 1000 / zoom, height = 560 / zoom;
  $('map').setAttribute('viewBox', `${(1000 - width) / 2} ${(560 - height) / 2} ${width} ${height}`);
  $('zoom-in').disabled = zoom >= 1.8;
  $('zoom-out').disabled = zoom <= 1;
  renderInspector();
}

function hospitalXray(dark, hasTelemetry) {
  const off = dark ? 'off' : '';
  return `<svg class="xray" viewBox="0 0 220 120" role="img" aria-label="Cross-section of the hospital's power and water connections">
    <path class="xray-roof" d="M4 4 L110 -12 L216 4"/>
    <rect class="xray-shell" x="4" y="4" width="212" height="112" rx="6"/>
    <line class="xray-floor" x1="4" y1="62" x2="216" y2="62"/>
    <g class="xray-bed"><rect x="18" y="18" width="24" height="14" rx="2"/><rect x="54" y="18" width="24" height="14" rx="2"/><rect x="90" y="18" width="24" height="14" rx="2"/><rect x="126" y="18" width="24" height="14" rx="2"/><rect x="170" y="18" width="30" height="14" rx="2"/></g>
    <g class="xray-bed"><rect x="18" y="76" width="34" height="18" rx="2"/><rect x="66" y="76" width="34" height="18" rx="2"/><rect x="114" y="76" width="34" height="18" rx="2"/><rect x="162" y="76" width="38" height="18" rx="2"/></g>
    <path class="xray-power ${off}" d="M-6 100 L30 100 L30 70"/>
    ${hasTelemetry && !dark ? `<circle class="xray-power-pulse" r="3"><animateMotion dur="1.6s" repeatCount="indefinite"><mpath href="#xray-power-path"/></animateMotion></circle><path id="xray-power-path" d="M-6 100 L30 100 L30 70" opacity="0"/>` : ''}
    <path class="xray-water" d="M226 100 L190 100 L190 70"/>
    <text class="xray-label" x="30" y="114">POWER</text><text class="xray-label" x="190" y="114" text-anchor="end">WATER</text>
  </svg>`;
}
function renderInspector() {
  const box = $('asset-inspector');
  box.hidden = !selectedAsset || view !== 'power';
  if (box.hidden) return;
  const state = busState(snap, selectedAsset);
  const neighbors = Object.entries(LINES).filter(([, ends]) => ends.includes(selectedAsset)).map(([id]) => id);
  const row = `<div class="row"><div><strong>${esc(PLACES[selectedAsset])}</strong><small>${esc(selectedAsset)}${ESSENTIAL.has(selectedAsset) ? ' · ESSENTIAL SERVICE' : ''}</small></div><div class="asset-reading">${snap.assets ? state === 'dark' ? 'No power' : state === 'unknown' ? 'Unknown' : 'Energized' : 'Awaiting telemetry'}<small>${neighbors.length} feeder connection${neighbors.length === 1 ? '' : 's'}</small></div><button type="button" id="close-inspector" aria-label="Close facility details">×</button></div>`;
  box.innerHTML = selectedAsset === 'bus-9' ? row + hospitalXray(state === 'dark', Boolean(snap.assets)) : row;
}

function setView(v) {
  view = v;
  $('view-power').setAttribute('aria-selected', String(v === 'power'));
  $('view-water').setAttribute('aria-selected', String(v === 'water'));
  zoom = 1;
  render();
}

async function init() {
  // Wire local controls even if the server is temporarily unavailable.
  $('view-power').addEventListener('click', () => setView('power'));
  $('view-water').addEventListener('click', () => setView('water'));
  document.querySelector('.toggle').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    setView(e.key === 'Home' ? 'power' : e.key === 'End' ? 'water' : view === 'power' ? 'water' : 'power');
    $(`view-${view}`).focus();
  });
  $('zoom-in').addEventListener('click', () => { zoom = Math.min(1.8, +(zoom + 0.2).toFixed(1)); renderMap(); });
  $('zoom-out').addEventListener('click', () => { zoom = Math.max(1, +(zoom - 0.2).toFixed(1)); renderMap(); });
  $('zoom-reset').addEventListener('click', () => { zoom = 1; renderMap(); });
  const focusMap = expand => {
    document.querySelector('.mapwrap').classList.toggle('expanded', expand);
    $('focus-map').setAttribute('aria-label', expand ? 'Collapse network map' : 'Expand network map');
    $('focus-map').setAttribute('aria-pressed', String(expand));
    $('focus-map').title = expand ? 'Collapse network map (Escape)' : 'Expand network map';
  };
  $('focus-map').addEventListener('click', () => focusMap(!document.querySelector('.mapwrap').classList.contains('expanded')));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') focusMap(false); });
  const selectAsset = e => {
    const node = e.target.closest('[data-asset]');
    if (!node) return;
    selectedAsset = node.dataset.asset;
    renderMap();
  };
  $('map').addEventListener('click', selectAsset);
  $('map').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAsset(e); } });
  $('asset-inspector').addEventListener('click', e => { if (e.target.closest('#close-inspector')) { const previous = selectedAsset; selectedAsset = null; renderMap(); $('map').querySelector(`[data-asset="${previous}"]`)?.focus(); } });
  $('results-toggle').addEventListener('click', () => {
    const open = $('results-body').hidden;
    $('results-body').hidden = !open;
    $('results-toggle').setAttribute('aria-expanded', String(open));
    $('results-toggle').innerHTML = `${open ? 'Hide measured results' : 'View measured results'} <span aria-hidden="true">${open ? '−' : '↗'}</span>`;
  });
  $('case').addEventListener('change', render);
  render();
  await loadMeta();
  try { results = await api('/api/town/v2-results'); } catch { results = null; }
  renderResults();
  await poll();
  // Poll sequentially to prevent overlapping requests on a slow connection.
  const refresh = async () => { if (!meta) await loadMeta(); await poll(); setTimeout(refresh, 1000); };
  setTimeout(refresh, 1000);
}

async function loadMeta() {
  try {
  meta = await api('/api/town/cases');
  const stories = meta.cases.filter(c => c.storyline);
  $('case').innerHTML = stories.map(c => `<option value="${esc(c.caseId)}">${esc(c.title)}</option>`).join('');
  const labels = { lifeline: 'LIFELINE', hybrid: 'Conventional coordinated', priority: 'Rules only' };
  $('controller').innerHTML = meta.controllers.map(c => `<option value="${esc(c)}">${esc(labels[c] ?? c)}</option>`).join('');
  notice();
  } catch { notice('The town server is unavailable. Reconnecting automatically.'); }
}

async function runRequest(action) {
  if (busy) return;
  busy = true; notice(); render();
  try {
    snap = await api(`/api/town/live/${action}`, action === 'start' ? { caseId: $('case').value, controller: $('controller').value } : { runId: snap.runId });
    connected = true;
    if (snap.error) notice(`Simulation disconnected: ${snap.error.detail ?? snap.error.code}`);
  } catch (e) { notice(`Could not ${action} the simulation. ${e.message}`); }
  finally { busy = false; render(); }
}
$('start').addEventListener('click', () => runRequest('start'));
$('stop').addEventListener('click', () => runRequest('stop'));
init();
