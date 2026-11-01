import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSchedule, classifyRun, compare, verifyProtocol } from '../../src/lifeline/evaluation.mjs';

const PROTOCOL = JSON.parse(readFileSync(new URL('../../fixtures/lifeline/protocol-v1.json', import.meta.url), 'utf8'));

test('schedule: 48 paired episodes, each case and repetition running every controller exactly once', () => {
  const s = buildSchedule(PROTOCOL);
  assert.equal(s.length, 48);
  for (const c of PROTOCOL.cases) for (const r of [1, 2]) {
    const block = s.filter(e => e.caseId === c.caseId && e.repetition === r);
    assert.deepEqual(block.map(e => e.controller).sort(), ['adaptive', 'meta', 'priority']);
    assert.equal(new Set(block.map(e => e.block)).size, 1);
  }
  assert.equal(new Set(s.map(e => e.episodeId)).size, 48);
  assert.equal(new Set(s.map(e => e.tag)).size, 48);
  assert.ok(s.every(e => /^lf[a-z0-9]{2}$/.test(e.tag)));
});

test('schedule: controller order is randomized per block and reproducible from the seed', () => {
  const a = buildSchedule(PROTOCOL), b = buildSchedule(PROTOCOL);
  assert.deepEqual(a.map(e => e.episodeId), b.map(e => e.episodeId));
  const orders = new Set(PROTOCOL.cases.flatMap(c => [1, 2].map(r => a.filter(e => e.caseId === c.caseId && e.repetition === r).map(e => e.controller).join())));
  assert.ok(orders.size > 1, 'not every block uses the same order');
  const other = buildSchedule({ ...PROTOCOL, orderSeed: 7 });
  assert.notDeepEqual(a.map(e => e.controller), other.map(e => e.controller));
});

test('protocol: an unfrozen protocol or a changed case file is refused', () => {
  assert.equal(verifyProtocol(PROTOCOL, p => readFileSync(new URL(`../../${p}`, import.meta.url))).ok, true);
  assert.equal(verifyProtocol({ ...PROTOCOL, status: 'draft' }, () => Buffer.from('')).code, 'protocol_not_frozen');
  assert.equal(verifyProtocol(PROTOCOL, () => Buffer.from('changed')).code, 'case_identity_mismatch');
});

const manifest = (o = {}) => ({ terminal: 'completed', workerExitCode: 0, ledger: { records: 10 }, ...o });
const replay = (o = {}) => ({ ok: true, checks: { ledger: { ok: true }, score: { ok: true }, contracts: { ok: true }, linkage: { ok: true }, scenarioIdentity: { ok: true } }, ...o });
const summary = (rate, o = {}) => ({ status: 'scored', results: { primary: { offered: 100, onTime: rate * 100, deliveryRate: rate } }, controllerViewAudit: { findings: [] }, ...o });

test('classification: worker crash, missing capture and information leaks are infrastructure-invalid; model failures are method outcomes', () => {
  assert.equal(classifyRun({ manifest: manifest(), replay: replay(), summary: summary(1) }).status, 'valid');
  assert.equal(classifyRun({ manifest: manifest({ terminal: 'run_incomplete', failure: { code: 'worker_unavailable' } }), replay: null, summary: null }).status, 'infrastructure_invalid');
  assert.equal(classifyRun({ manifest: manifest(), replay: replay(), summary: summary(1, { status: 'run_incomplete' }) }).status, 'infrastructure_invalid');
  assert.equal(classifyRun({ manifest: manifest(), replay: replay(), summary: summary(1, { controllerViewAudit: { findings: [{ key: 'bwMbit' }] } }) }).reason, 'controller_view_leak');
  const scorer = classifyRun({ manifest: manifest(), replay: replay({ ok: false, checks: { ...replay().checks, score: { ok: false } } }), summary: summary(1) });
  assert.deepEqual([scorer.status, scorer.reason], ['infrastructure_invalid', 'scorer_disagreement']);
  // A run in which every model call timed out is still a valid method outcome.
  assert.equal(classifyRun({ manifest: manifest({ provider: {} }), replay: replay(), summary: summary(0.8), providerFailures: 12 }).status, 'valid');
});

function index() {
  const rows = [];
  const add = (caseId, controller, repetition, rate, extra = {}) => rows.push({ caseId, controller, repetition, status: 'valid', primary: { deliveryRate: rate, offered: 100 }, recoverable: caseId !== 'p8', noFault: caseId === 'p1', cost: { modelCalls: controller === 'meta' ? 3 : 0, probeBytes: 16000, interventions: 1 }, ...extra });
  for (const r of [1, 2]) {
    add('p1', 'priority', r, 1); add('p1', 'adaptive', r, 1); add('p1', 'meta', r, 0.995);
    add('p5', 'priority', r, 0.90); add('p5', 'adaptive', r, 0.97); add('p5', 'meta', r, r === 1 ? 0.99 : 0.97);
    add('p8', 'priority', r, 1 / 3); add('p8', 'adaptive', r, 1 / 3); add('p8', 'meta', r, 1 / 3);
  }
  return rows;
}

test('comparison: per-case means over repetitions and paired differences, hand-checked', () => {
  const c = compare(index());
  assert.equal(c.cases.p5.mean.meta, 0.98);
  assert.ok(Math.abs(c.cases.p5.diff.metaMinusAdaptive - 0.01) < 1e-12);
  assert.ok(Math.abs(c.cases.p5.diff.metaMinusPriority - 0.08) < 1e-12);
  // Recoverable failure cases exclude the no-fault and partition controls.
  assert.deepEqual(c.recoverableCases, ['p5']);
  assert.ok(Math.abs(c.summary.meanPairedDiffMetaMinusAdaptive - 0.01) < 1e-12);
  assert.ok(Math.abs(c.summary.noFaultRegressionMetaVsAdaptive - 0.005) < 1e-12);
  assert.ok(Math.abs(c.summary.worstCaseDiffMetaMinusAdaptive - 0.01) < 1e-12);
});

test('comparison: every scheduled episode stays in the index count, including invalid ones', () => {
  const rows = [...index(), { caseId: 'p5', controller: 'meta', repetition: 1, status: 'infrastructure_invalid', reason: 'worker_crash', superseded: true }];
  const c = compare(rows);
  assert.equal(c.episodes.total, 19);
  assert.equal(c.episodes.infrastructureInvalid, 1);
  assert.equal(c.cases.p5.mean.meta, 0.98); // the superseding valid rerun is used, the invalid attempt is reported
});

test('comparison: a missing controller result is reported as incomplete, not dropped', () => {
  const rows = index().filter(r => !(r.caseId === 'p5' && r.controller === 'meta'));
  const c = compare(rows);
  assert.equal(c.cases.p5.mean.meta, null);
  assert.equal(c.cases.p5.diff.metaMinusAdaptive, null);
  assert.deepEqual(c.incomplete, ['p5/meta']);
});

test('comparison: model and probe costs are accounted per controller', () => {
  const c = compare(index());
  assert.equal(c.cost.meta.modelCalls, 18);
  assert.equal(c.cost.adaptive.modelCalls, 0);
  assert.equal(c.cost.meta.probeBytes, 6 * 16000);
});
