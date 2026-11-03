import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelStore } from '../../../src/lifeline/kernel/model-store.mjs';

const S = 1_000_000;
const ids = new Set(['obs:a', 'obs:b']);
const store = () => createModelStore({ evidenceIds: () => ids });

test('an unknown value reads as unknown, never a default', () => {
  const s = store();
  assert.deepEqual(s.read('tank.netDraw', 0), { status: 'unknown', value: null });
  assert.equal(s.add({ key: 'eta', value: null, unit: 's', evidence: ['obs:a'], nowUs: 0, ttlUs: 60 * S }).ok, true);
  assert.equal(s.read('eta', 1).status, 'unknown');
});

test('entries need admitted evidence and an expiry, and expire', () => {
  const s = store();
  assert.equal(s.add({ key: 'k', value: 1, unit: 'm', evidence: ['obs:z'], nowUs: 0, ttlUs: S }).code, 'evidence_unknown');
  assert.equal(s.add({ key: 'k', value: 1, unit: 'm', evidence: [], nowUs: 0, ttlUs: S }).code, 'evidence_required');
  assert.equal(s.add({ key: 'k', value: 1, unit: 'm', evidence: ['obs:a'], nowUs: 0 }).code, 'expiry_required');
  s.add({ key: 'k', value: 1, unit: 'm', evidence: ['obs:a'], nowUs: 0, ttlUs: 10 * S });
  assert.deepEqual([s.read('k', 5 * S).status, s.read('k', 5 * S).value], ['supported', 1]);
  assert.equal(s.read('k', 10 * S).status, 'unknown');
});

test('contradictions are detected, kept and read as contradictory; retraction resolves them; versions increase', () => {
  const s = store();
  const a = s.add({ key: 'eta', value: 10800, unit: 's', evidence: ['obs:a'], nowUs: 0, ttlUs: 3600 * S });
  const b = s.add({ key: 'eta', value: 12600, unit: 's', evidence: ['obs:b'], nowUs: 1, ttlUs: 3600 * S });
  assert.deepEqual([b.code, b.contradicts], ['contradiction', [a.version]]);
  assert.equal(s.read('eta', 2).status, 'contradictory');
  s.retract(a.version, 'superseded by crew report');
  assert.deepEqual([s.read('eta', 2).status, s.read('eta', 2).value], ['supported', 12600]);
  assert.ok(b.version > a.version);
});
