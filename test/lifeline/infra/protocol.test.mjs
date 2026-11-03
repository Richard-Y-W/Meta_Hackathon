// P17: held-out suite integrity. Leakage controls are tested on constructed violations; the frozen suite
// is then checked for overlap, duplicates, commitment, immutability and prompt leakage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitment, deenergized, duplicates, hiddenTruthLeaks, overlap, selectedAfterOutcomes, signature, suiteHash } from '../../../src/lifeline/kernel/research-protocol.mjs';
import { buildPrompt } from '../../../src/lifeline/controllers/meta-joint.mjs';
import { buildSuite, developmentSet } from '../../../scripts/lifeline-infra-freeze.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const S = 1_000_000;
const A = { pumpStationBus: 'bus-7', backupPumpBus: 'bus-14', substationRouterBus: 'bus-14' };
const B = { pumpStationBus: 'bus-10', backupPumpBus: 'bus-13', substationRouterBus: 'bus-13' };
const dev = developmentSet();
const devCase = dev.find(d => d.case.caseId === 'b-second-fault');

test('the grid model de-energizes the right buses and ties restore them', () => {
  assert.deepEqual(deenergized(['line-3-8']), ['bus-10', 'bus-11', 'bus-7', 'bus-8', 'bus-9']);
  assert.deepEqual(deenergized(['line-3-8'], ['sw-S1']), []);
  assert.deepEqual(deenergized(['line-8-9']), ['bus-10', 'bus-11', 'bus-9']);
});

test('RED: a graph-isomorphic copy of a development case is detected across the split', () => {
  // Same structure in a relabelled layout: the pump station moved to a bus that the moved fault affects the same way.
  const renamed = { case: { ...devCase.case, caseId: 'disguised', faults: devCase.case.faults.map(f => ({ ...f, faultId: `x-${f.faultId}` })) }, layout: { ...A } };
  assert.equal(overlap([renamed], dev).length, 1);
  // A line-8-9 trip de-energizes layout B's pump bus (bus-10) but not layout A's (bus-7): different roles.
  const c89 = { caseId: 'c89', faults: [{ faultId: 'f', type: 'line_trip', assetId: 'line-8-9', atUs: 1800 * S }] };
  assert.notEqual(signature(c89, A), signature(c89, B), 'a genuinely different layout changes the role signature');
  // A line-13-14 trip leaves both pump stations powered; only the backup-pump and router roles differ.
  const c1314 = { caseId: 'c1314', faults: [{ faultId: 'f', type: 'line_trip', assetId: 'line-13-14', atUs: 1800 * S }] };
  assert.notEqual(signature(c1314, A), signature(c1314, B), 'backup-pump and router roles enter the signature');
});

test('RED: a derivative fault schedule (time-shifted copy) is detected', () => {
  const shifted = { ...devCase.case, caseId: 'shifted', faults: devCase.case.faults.map(f => ({ ...f, atUs: f.atUs + 600 * S })) };
  assert.equal(duplicates([{ case: devCase.case, layout: A }, { case: shifted, layout: A }]).length, 1);
});

test('RED: false alarms are told apart by what the threatened trip would do, not by line name', () => {
  const C = { pumpStationBus: 'bus-5', backupPumpBus: 'bus-14', substationRouterBus: 'bus-12' };
  const alarm = line => ({ caseId: line, faults: [], advisory: { issuedAtUs: 0, etaScenarios: [{ label: 't', assume: [{ type: 'line_trip', assetId: line, atUs: 3600 * S }] }] } });
  // B line-8-9 would cut the pump and essential bus 9; C line-4-5 would cut the pump only: different scenarios.
  assert.equal(duplicates([{ case: alarm('line-8-9'), layout: B }, { case: alarm('line-4-5'), layout: C }]).length, 0);
  // The same threatened role in the same layout twice is a duplicate.
  assert.equal(duplicates([{ case: alarm('line-8-9'), layout: B }, { case: { ...alarm('line-8-9'), caseId: 'again' }, layout: B }]).length, 1);
});

test('RED: hidden truth in a controller prompt is detected', () => {
  const c = buildSuite().find(x => x.family === 'abrupt');
  const trip = c.faults.find(f => f.type === 'line_trip');
  const obs = { atUs: 600 * S, routers: {}, readings: [] };
  const state = { stationMode: 'auto', resources: { 'gen-portable': { allocatedTo: null, fuelJ: 120e6 } }, layout: c.layout };
  const clean = buildPrompt({ nowUs: 600 * S, obs, state, advisory: null, candidates: [], deadline: { simUs: null, wallS: 18 } });
  assert.deepEqual(hiddenTruthLeaks(clean.text, c, 600 * S), []);
  const leaked = `${clean.text}\nnote: ${trip.assetId} will trip at ${trip.atUs / S} s (${trip.faultId})`;
  assert.ok(hiddenTruthLeaks(leaked, c, 600 * S).length >= 1);
});

test('RED: a case referenced by outcome artifacts before the freeze is detected', () => {
  const dir = join(ROOT, '.work/tmp/selected-after');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const p = { cases: [{ caseId: 'rv1-99-B-test' }], freeze: { frozenAtUnixMs: Date.now() } };
  writeFileSync(join(dir, 'outcome.json'), JSON.stringify({ caseId: 'rv1-99-B-test', meta: 'won' }));
  utimesSync(join(dir, 'outcome.json'), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  assert.equal(selectedAfterOutcomes(p, dir).length, 1);
  writeFileSync(join(dir, 'outcome.json'), JSON.stringify({ caseId: 'other' }));
  assert.equal(selectedAfterOutcomes(p, dir).length, 0);
});

const PUBLIC = join(ROOT, 'fixtures/lifeline/infra/protocol-research-v1.json');
const PRIVATE = join(ROOT, 'fixtures/lifeline/infra/research-v1/private-cases.json');
const frozen = existsSync(PUBLIC) ? false : 'research-v1 not frozen yet';

test('the frozen suite: no overlap, no duplicates, commitments match, suite hash immutable, prompts clean', { skip: frozen }, () => {
  const protocol = JSON.parse(readFileSync(PUBLIC, 'utf8'));
  const priv = JSON.parse(readFileSync(PRIVATE, 'utf8'));
  assert.equal(protocol.status, 'frozen');
  assert.equal(suiteHash(protocol), protocol.freeze.suiteSha256);
  const held = priv.cases.map(c => ({ case: c, layout: c.layout }));
  assert.deepEqual(overlap(held, dev), []);
  assert.deepEqual(duplicates(held), []);
  for (const c of priv.cases) assert.equal(protocol.cases.find(x => x.caseId === c.caseId).commitmentSha256, commitment(c), c.caseId);
  assert.ok(!JSON.stringify(protocol).includes('"faults"'), 'the public protocol carries no fault schedule');
  for (const fam of ['stable', 'developing-threat', 'abrupt', 'compound', 'delayed-dependency', 'partial-observation', 'false-alarm', 'impossible-recovery', 'no-useful-coupling', 'common-cause']) assert.ok(protocol.families.includes(fam), fam);
  for (const c of priv.cases) {
    const state = { stationMode: 'auto', resources: { 'gen-portable': { allocatedTo: null, fuelJ: 120e6 } }, layout: c.layout };
    for (const now of [0, 1800 * S, 5400 * S]) {
      const visible = c.advisory && now >= c.advisory.issuedAtUs ? c.advisory : null;
      const p = buildPrompt({ nowUs: now, obs: { atUs: now, routers: {}, readings: [] }, state, advisory: visible, candidates: [], deadline: { simUs: null, wallS: 18 } });
      assert.deepEqual(hiddenTruthLeaks(p.text, c, now), [], `${c.caseId} at ${now / S}s`);
    }
  }
});

const ABLATION = join(ROOT, 'fixtures/lifeline/infra/protocol-ablation-v1.json');
test('the frozen ablation protocol is immutable, bound to research-v1 and drawn from its groups', { skip: existsSync(ABLATION) ? false : 'not frozen' }, () => {
  const a = JSON.parse(readFileSync(ABLATION, 'utf8')), base = JSON.parse(readFileSync(PUBLIC, 'utf8'));
  assert.equal(suiteHash(a), a.freeze.suiteSha256);
  assert.equal(a.basedOn.suiteSha256, base.freeze.suiteSha256);
  for (const c of a.cases) assert.ok(base.cases.some(b => b.caseId === c.caseId), c.caseId);
  assert.ok(a.matchedDelayMs > 0 && Object.keys(a.variants).includes('meta-latency-matched'));
});
