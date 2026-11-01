import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger, verifyLedger } from '../../src/lifeline/ledger.mjs';

const DIR = new URL('../../.work/tmp/ledger-test/', import.meta.url).pathname;
const fresh = name => { mkdirSync(DIR, { recursive: true }); const p = join(DIR, `${name}.jsonl`); rmSync(p, { force: true }); return p; };
const write = (path, n = 4) => { const l = new Ledger(path); for (let i = 0; i < n; i++) l.append('event', { i }); return l.finalize(); };

test('appended records are ordered, hash-chained and verify against the finalized manifest', () => {
  const path = fresh('ok');
  const manifest = write(path);
  assert.equal(manifest.records, 4);
  assert.match(manifest.lastHash, /^[0-9a-f]{64}$/);
  const v = verifyLedger(path, manifest);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l).seq), [1, 2, 3, 4]);
});

test('an altered record breaks the chain at that record', () => {
  const path = fresh('altered');
  const manifest = write(path);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  lines[1] = lines[1].replace('"i":1', '"i":9');
  writeFileSync(path, lines.join('\n') + '\n');
  const v = verifyLedger(path, manifest);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'hash_mismatch');
  assert.equal(v.atSeq, 2);
});

test('duplicate or out-of-order sequence numbers are detected', () => {
  const path = fresh('dup');
  const manifest = write(path);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  writeFileSync(path, [lines[0], lines[1], lines[1], lines[2], lines[3]].join('\n') + '\n');
  assert.equal(verifyLedger(path, manifest).code, 'sequence_error');
  writeFileSync(path, [lines[0], lines[2], lines[1], lines[3]].join('\n') + '\n');
  assert.equal(verifyLedger(path, manifest).code, 'sequence_error');
});

test('a crash-truncated final record is reported with the verified prefix, not accepted', () => {
  const path = fresh('truncated');
  const l = new Ledger(path);
  l.append('event', { i: 0 }); l.append('event', { i: 1 });
  appendFileSync(path, '{"seq":3,"prevHash":"ab');
  const v = verifyLedger(path, null);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'truncated_final_record');
  assert.equal(v.verifiedRecords, 2);
});

test('records removed from the end are caught by the manifest; a missing manifest is incomplete', () => {
  const path = fresh('short');
  const manifest = write(path);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  writeFileSync(path, lines.slice(0, 3).join('\n') + '\n');
  assert.equal(verifyLedger(path, manifest).code, 'manifest_mismatch');
  assert.equal(verifyLedger(path, null).code, 'manifest_missing');
});

test('the ledger refuses appends after finalization and never rewrites earlier records', () => {
  const path = fresh('final');
  const l = new Ledger(path);
  l.append('event', { i: 0 });
  const before = readFileSync(path, 'utf8');
  l.finalize();
  assert.throws(() => l.append('event', { i: 1 }), /finalized/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('event data cannot overwrite the ledger fields', () => {
  const path = fresh('fields');
  const l = new Ledger(path);
  l.append('decision', { type: 'forged', seq: 99, hash: 'x' });
  const rec = JSON.parse(readFileSync(path, 'utf8').trim());
  assert.deepEqual([rec.type, rec.seq], ['decision', 1]);
  assert.equal(rec.data.type, 'forged');
});
