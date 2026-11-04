// LIFELINE v2 brain: the slow layer. It reads plain-language warning signs (crew notes, weather bulletins,
// outage tickets) with the town's asset map and live telemetry, and states threats: which asset may fail,
// in what time window, how confident, and on which reports that rests. It never acts. Threats go to the
// spread predictor and the coordinator, which verify everything in simulation before anything is armed.
import { strictJsonParse } from '../meta-provider.mjs';
import { GRID } from '../kernel/research-protocol.mjs';

// What an operator's map says about each line, in the words field crews and bulletins use.
export const LANDMARKS = {
  'line-1-2': 'Substation A exit cables, from Substation A to the river crossing',
  'line-2-3': 'the river-crossing span, from the river to Main Street',
  'line-3-4': 'Main Street to the school district',
  'line-4-5': 'the school district to the east industrial park',
  'line-5-6': 'the east industrial park to the bus depot',
  'line-7-8': 'the short span from the pump station to the north ridge junction',
  'line-8-9': 'the north ridge junction down to the hospital',
  'line-9-10': 'the hospital to the fire station',
  'line-10-11': 'the fire station to the north housing estate',
  'line-3-8': 'the long overhead span from Main Street up the north ridge, past the water tower',
  'line-12-13': 'Substation B exit, from Substation B to the west mall',
  'line-13-14': 'the west mall to the west housing estate',
  'grid-hv': 'the regional transmission supply that feeds both substations (loss darkens the whole town)',
};
// The brain names an asset; the fault it implies follows from the asset.
export const threatType = assetId => (assetId === 'grid-hv' ? 'source_loss' : 'line_trip');
export const FACILITIES = [
  'the pump station (pump PU1, its control radio rt-pump) sits on bus 7 and fills the water tower (tank T1)',
  'the water tower feeds the hospital (JH), the fire station (JF) and the residential zone (JR)',
  'essential electrical loads: Main Street clinic CI3 (bus 3), pump-station control CI7 (bus 7), hospital CI9 (bus 9)',
  'backup pump PU2 is on bus 14; the portable generator can power the pump station in 10 minutes',
];

const TEXT_LIMIT = 600;
export function buildBrainPrompt({ nowUs, reports, telemetry }) {
  const lines = Object.entries(LANDMARKS).map(([id, text]) => `${id}: ${text}${GRID.lines[id] ? ` (buses ${GRID.lines[id].join(', ')})` : ''}`);
  const rep = reports.map(r => `[${r.id}] t=${Math.round(r.atUs / 60e6)} min, ${r.source}: ${String(r.text).slice(0, TEXT_LIMIT)}`);
  const text = [
    'You are the threat-assessment layer of LIFELINE, which protects a small town\'s power, water and communications.',
    'Read the warning signs below and say which power assets (lines or the regional supply) may fail soon. You do not act; your threats are checked in simulation.',
    `Current time: ${Math.round(nowUs / 60e6)} min.`,
    '', 'Town map (line id: description):', ...lines,
    '', 'Facilities:', ...FACILITIES,
    '', 'Live telemetry:', telemetry,
    '', 'Warning signs received so far:', ...(rep.length ? rep : ['(none)']),
    '', 'Answer with JSON only, no prose, exactly this shape:',
    '{"threats":[{"id":"t1","assetId":"<asset id from the map>","windowMin":[<earliest minutes from now>,<latest minutes from now>],"confidence":<0..1>,"evidence":["<report id>"],"why":"<one sentence>"}],"dismissed":[{"evidence":["<report id>"],"why":"<one sentence>"}]}',
    'Rules: at most 4 threats; use only asset ids from the map; evidence must cite report ids above; a report that rules a threat out goes in "dismissed"; if nothing is threatened return {"threats":[],"dismissed":[]}.',
  ].join('\n');
  return { text, reportIds: new Set(reports.map(r => r.id)) };
}

const bad = code => { throw Object.assign(new Error(code), { code }); };
const exact = (o, keys) => { if (!o || typeof o !== 'object' || Array.isArray(o)) bad('missing_field'); const k = Object.keys(o).sort(); if (k.length !== keys.length || keys.slice().sort().some((x, i) => x !== k[i])) bad('unexpected_field'); };
const cites = (ev, ids) => { if (!Array.isArray(ev) || ev.length < 1 || ev.length > 8 || ev.some(e => !ids.has(e))) bad('evidence_unknown'); };

export function parseBrain(text, { reportIds }) {
  try {
    let raw;
    // Tolerate a Markdown fence around the JSON; nothing else.
    const body = String(text).trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
    try { raw = strictJsonParse(body); } catch { bad('invalid_json'); }
    exact(raw, ['threats', 'dismissed']);
    if (!Array.isArray(raw.threats) || raw.threats.length > 4 || !Array.isArray(raw.dismissed) || raw.dismissed.length > 8) bad('missing_field');
    const seen = new Set();
    for (const t of raw.threats) {
      exact(t, ['id', 'assetId', 'windowMin', 'confidence', 'evidence', 'why']);
      if (typeof t.id !== 'string' || seen.has(t.id)) bad('duplicate_id');
      seen.add(t.id);
      if (!LANDMARKS[t.assetId]) bad('asset_unknown');
      const [lo, hi] = Array.isArray(t.windowMin) && t.windowMin.length === 2 ? t.windowMin : [NaN, NaN];
      if (![lo, hi].every(Number.isFinite) || lo < 0 || hi < lo || hi > 240) bad('invalid_window');
      if (!Number.isFinite(t.confidence) || t.confidence < 0 || t.confidence > 1) bad('invalid_confidence');
      cites(t.evidence, reportIds);
      if (typeof t.why !== 'string' || t.why.length > 400) bad('invalid_text');
    }
    for (const d of raw.dismissed) { exact(d, ['evidence', 'why']); cites(d.evidence, reportIds); if (typeof d.why !== 'string' || d.why.length > 400) bad('invalid_text'); }
    return { ok: true, threats: raw.threats, dismissed: raw.dismissed };
  } catch (error) {
    return { ok: false, code: error.code ?? 'invalid_json' };
  }
}

// What the brain sees of the plant: dead buses, storage, station and generator state. No fault schedule.
export function telemetrySummary({ obs, state }) {
  const dead = obs.readings.filter(r => /^power:v-bus-/.test(r.sensorId) && r.value === 0).map(r => r.assetId);
  const tank = obs.readings.find(r => r.sensorId === 'water:lv-T1')?.value;
  const gen = state.resources?.['gen-portable'];
  return [`de-energized buses: ${dead.length ? dead.join(', ') : 'none'}`, `water tower level: ${tank == null ? 'unknown' : `${tank.toFixed(2)} m`}`,
    `pump station mode: ${state.stationMode}`, `portable generator: ${gen?.allocatedTo ? `at ${gen.allocatedTo}` : 'available'}`].join('; ');
}
