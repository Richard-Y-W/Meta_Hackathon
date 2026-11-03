// Research protocol integrity (P17): structural signatures for split-overlap and derivative-schedule
// detection, a hidden-truth scan of controller prompts, commitment hashes, and the freeze-before-outcomes
// check. The signature describes what a scenario does to the dependency structure, not what it is named.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalRecord } from '../identity.mjs';

const S = 1_000_000;
// CIGRE MV with DER as built for the town: radial feeders from bus 1 and bus 12; ties S1 (14-8), S2 (6-7),
// S3 (11-4) normally open. Public engineering information.
export const GRID = {
  sources: ['bus-1', 'bus-12'],
  lines: { 'line-1-2': ['bus-1', 'bus-2'], 'line-2-3': ['bus-2', 'bus-3'], 'line-3-4': ['bus-3', 'bus-4'], 'line-4-5': ['bus-4', 'bus-5'], 'line-5-6': ['bus-5', 'bus-6'],
    'line-7-8': ['bus-7', 'bus-8'], 'line-8-9': ['bus-8', 'bus-9'], 'line-9-10': ['bus-9', 'bus-10'], 'line-10-11': ['bus-10', 'bus-11'], 'line-3-8': ['bus-3', 'bus-8'],
    'line-12-13': ['bus-12', 'bus-13'], 'line-13-14': ['bus-13', 'bus-14'] },
  ties: { 'sw-S1': ['bus-14', 'bus-8'], 'sw-S2': ['bus-6', 'bus-7'], 'sw-S3': ['bus-11', 'bus-4'] },
  essentialBuses: ['bus-3', 'bus-7', 'bus-9'],
};

export function deenergized(trippedLines, closedTies = []) {
  const adj = new Map();
  const link = (a, b) => { adj.set(a, [...(adj.get(a) ?? []), b]); adj.set(b, [...(adj.get(b) ?? []), a]); };
  for (const [id, [a, b]] of Object.entries(GRID.lines)) if (!trippedLines.includes(id)) link(a, b);
  for (const t of closedTies) link(...GRID.ties[t]);
  const seen = new Set(GRID.sources), queue = [...GRID.sources];
  while (queue.length) for (const n of adj.get(queue.shift()) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  const all = new Set(Object.values(GRID.lines).flat());
  return [...all].filter(b => !seen.has(b)).sort();
}

// Ties that would restore the pump-station bus after the given trips (what a remedy must find).
const remedies = (tripped, bus) => Object.keys(GRID.ties).filter(t => !deenergized(tripped, [t]).includes(bus)).sort();

// Role signature: per fault, the dependency roles it touches and the remedies available; plus order, storage
// bucket, advisory kind and observation faults. Absolute times, asset names and seeds do not enter it.
export function signature(c, layout) {
  const roles = tripped => { const dead = deenergized(tripped);
    return [dead.includes(layout.pumpStationBus), dead.includes(layout.backupPumpBus), dead.includes(layout.substationRouterBus),
      GRID.essentialBuses.filter(b => dead.includes(b)).length, remedies(tripped, layout.pumpStationBus).length]; };
  const tripped = [];
  const faults = [...c.faults].sort((a, b) => a.atUs - b.atUs).map(f => {
    if (f.type === 'line_trip') { tripped.push(f.assetId); return ['trip', ...roles(tripped)]; }
    if (f.type === 'actuator_unavailable') return ['unavailable', f.assetId.startsWith('sw-') ? 'tie' : 'pump'];
    if (f.type === 'line_restore') return ['restore'];
    return [f.type];
  });
  const storage = (c.tankInitialLevels?.T1 ?? 3) < 2 ? 'low' : 'normal';
  // A threat advisory is described by what the threatened trip would do in this layout, not by its line name.
  const threatened = [...new Set((c.advisory?.etaScenarios ?? []).flatMap(s => s.assume.filter(a => a.type === 'line_trip').map(a => a.assetId)))];
  const advisory = c.advisory ? (threatened.length ? ['threat', ...roles(threatened)] : 'eta') : 'none';
  const materialized = c.advisory?.etaScenarios.some(s => s.assume.some(a => a.type === 'line_trip' && c.faults.some(f => f.type === 'line_trip' && f.assetId === a.assetId))) ?? null;
  return canonicalRecord({ faults, storage, advisory, materialized }).sha256;
}

export function overlap(heldOut, development) {
  const dev = new Map(development.map(d => [signature(d.case, d.layout), d.case.caseId]));
  return heldOut.map(h => ({ caseId: h.case.caseId, matches: dev.get(signature(h.case, h.layout)) ?? null })).filter(x => x.matches);
}

// Duplicates inside one split (a derivative schedule: same structure, shifted times or renamed assets).
export function duplicates(cases) {
  const seen = new Map(), out = [];
  for (const h of cases) {
    const sig = signature(h.case, h.layout);
    if (seen.has(sig)) out.push({ caseId: h.case.caseId, duplicateOf: seen.get(sig) });
    else seen.set(sig, h.case.caseId);
  }
  return out;
}

// A controller-facing text must not carry evaluator-private identities or not-yet-occurred event times.
export function hiddenTruthLeaks(text, privateCase, nowUs) {
  const leaks = [];
  for (const f of privateCase.faults) {
    if (text.includes(f.faultId)) leaks.push({ kind: 'fault_id', faultId: f.faultId });
    const announced = privateCase.advisory && nowUs >= privateCase.advisory.issuedAtUs && privateCase.advisory.etaScenarios.some(s => s.assume.some(a => a.atUs === f.atUs && a.assetId === f.assetId));
    if (f.atUs > nowUs && !announced && new RegExp(`\\b${f.atUs / S}\\s*s\\b`).test(text) && new RegExp(f.assetId).test(text)) leaks.push({ kind: 'future_event', faultId: f.faultId });
  }
  return leaks;
}

export const commitment = privateCase => canonicalRecord(privateCase).sha256;
export const suiteHash = protocol => canonicalRecord({ ...protocol, freeze: undefined }).sha256;

// Selection after outcomes: no outcome artifact may mention a held-out case before the freeze time.
export function selectedAfterOutcomes(protocol, artifactsRoot) {
  const ids = protocol.cases.map(c => c.caseId), found = [];
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name), st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.mtimeMs < protocol.freeze.frozenAtUnixMs && /\.(json|jsonl|log)$/.test(name) && st.size < 50e6) {
        const text = readFileSync(p, 'utf8');
        for (const id of ids) if (text.includes(id)) found.push({ file: p, caseId: id });
      }
    }
  };
  walk(artifactsRoot);
  return found;
}

export const sha256 = text => createHash('sha256').update(text).digest('hex');
