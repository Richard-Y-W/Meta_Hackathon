import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInventory } from '../../src/lifeline/controllers/common.mjs';
import { CapacityBeliefs } from '../../src/lifeline/beliefs.mjs';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const INV = buildInventory(read('../../fixtures/lifeline/development/cascade.json'), read('../../fixtures/lifeline/policy-v1.json'));
const IDS = INV.topology.links.map(l => l.linkId);
const obs = (seq, down = []) => ({ seq, collectedAtMs: seq * 500, links: Object.fromEntries(IDS.map(id => [id, { state: down.includes(id) ? 'down' : 'up' }])) });
const rates = links => ({ links });
const sat = tx => ({ txBps: tx, backlogBytes: 150_000, dropsPerS: 40 });
const idle = tx => ({ txBps: tx, backlogBytes: 0, dropsPerS: 0 });

test('beliefs start at the nominal interval, unmeasured, with no evidence', () => {
  const b = new CapacityBeliefs(INV);
  assert.deepEqual(b.interval('r1>r2'), [0, 8_000_000]);
  assert.equal(b.measured('r1>r2'), false);
  assert.deepEqual(b.record('r1>r2').evidence, []);
  assert.equal(b.status(), 'ok');
});

test('saturation narrows the interval and links the evidence observation', () => {
  const b = new CapacityBeliefs(INV);
  b.update(obs(10), rates({ 'r1-r2': { r1: sat(2_950_000) } }));
  const r = b.record('r1>r2');
  assert.ok(r.lo > 2_600_000 && r.hi < 3_300_000);
  assert.deepEqual(r.evidence, ['obs-10']);
  assert.equal(b.revision, 1);
});

test('missing measurements leave the belief unchanged, not zero', () => {
  const b = new CapacityBeliefs(INV);
  b.update(obs(10), rates({ 'r1-r2': { r1: { txBps: null, backlogBytes: null, dropsPerS: null } } }));
  assert.deepEqual(b.interval('r1>r2'), [0, 8_000_000]);
  assert.equal(b.revision, 0);
});

test('a measurement above a saturation estimate is a recorded contradiction that reopens the interval', () => {
  const b = new CapacityBeliefs(INV);
  b.update(obs(10), rates({ 'r1-r2': { r1: sat(2_950_000) } }));
  b.update(obs(20), rates({ 'r1-r2': { r1: idle(6_000_000) } }));
  assert.equal(b.record('r1>r2').hi, 8_000_000);
  assert.ok(b.record('r1>r2').lo >= 6_000_000);
  assert.equal(b.contradictions.length, 1);
  assert.deepEqual(b.contradictions[0].evidence, ['obs-10', 'obs-20']);
  assert.equal(b.history.length >= 2, true); // old revisions retained
});

test('a down link is zero capacity with its evidence; restoration reopens it', () => {
  const b = new CapacityBeliefs(INV);
  b.update(obs(5, ['r0-r3']), rates({}));
  assert.deepEqual(b.interval('r0>r3'), [0, 0]);
  b.update(obs(6), rates({}));
  assert.deepEqual(b.interval('r0>r3'), [0, 20_000_000]);
});

test('model-proposed updates need existing evidence whose measurement supports the value', () => {
  const b = new CapacityBeliefs(INV);
  const evidence = { 'obs-10': { links: { 'r1-r2': { r1: sat(2_950_000) } } }, 'obs-11': { links: { 'r1-r2': { r1: idle(1_000_000) } } } };
  assert.equal(b.applyProposedUpdate({ link: 'r1>r2', hiBps: 3_000_000, evidence: ['obs-99'] }, evidence).code, 'evidence_unknown');
  assert.equal(b.applyProposedUpdate({ link: 'r1>r2', hiBps: 3_000_000, evidence: ['obs-11'] }, evidence).code, 'evidence_unsupported');
  assert.equal(b.applyProposedUpdate({ link: 'r1>r2', hiBps: 500_000, evidence: ['obs-10'] }, evidence).code, 'evidence_unsupported');
  assert.equal(b.applyProposedUpdate({ link: 'r9>r2', hiBps: 3_000_000, evidence: ['obs-10'] }, evidence).code, 'unknown_link');
  const ok = b.applyProposedUpdate({ link: 'r1>r2', hiBps: 3_100_000, evidence: ['obs-10'] }, evidence);
  assert.equal(ok.code, 'ok');
  assert.equal(b.record('r1>r2').hi, 3_100_000);
  assert.deepEqual(b.record('r1>r2').evidence, ['obs-10']);
});

test('an inconsistent belief (lower bound above upper bound) is model_inconsistent', () => {
  const b = new CapacityBeliefs(INV);
  b.update(obs(10), rates({ 'r1-r2': { r1: idle(5_000_000) } }));
  b.applyProposedUpdate({ link: 'r1>r2', hiBps: 3_000_000, evidence: ['obs-10'] }, { 'obs-10': { links: { 'r1-r2': { r1: sat(3_000_000) } } } });
  assert.equal(b.status(), 'model_inconsistent');
});

test('a snapshot is a BeliefV1 record without mutating state', () => {
  const b = new CapacityBeliefs(INV);
  b.update(obs(10), rates({ 'r1-r2': { r1: sat(2_950_000) } }));
  const s = b.snapshot(5_500);
  assert.equal(s.version, 'BeliefV1');
  assert.equal(s.revision, 1);
  assert.ok(s.assumptions.length > 0);
  assert.equal(s.ageMs, 500);
  s.links['r1>r2'].hi = 1;
  assert.notEqual(b.record('r1>r2').hi, 1);
});
