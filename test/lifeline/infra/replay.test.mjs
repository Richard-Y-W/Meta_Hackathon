// P16: replay recomputes the score from a retained bundle without the provider and without changing the
// bundle, and detects a changed workload, a reordered receipt, an altered clock mapping and a copied score.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runBundle } from '../../../scripts/lifeline-infra-run.mjs';
import { verifyBundle } from '../../../scripts/lifeline-infra-replay.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const skip = existsSync(`${ROOT}.work/environments/town/bin/python`) ? false : 'town environment not found';
const BASE = join(ROOT, '.work/tmp/replay-test');
const digest = dir => createHash('sha256').update(readdirSync(dir).sort().map(f => readFileSync(join(dir, f))).join('|')).digest('hex');
const copy = name => { const d = join(BASE, name); rmSync(d, { recursive: true, force: true }); cpSync(join(BASE, 'good'), d, { recursive: true }); return d; };
const edit = (dir, file, fn) => { const p = join(dir, file); writeFileSync(p, fn(readFileSync(p, 'utf8'))); };

test('replay', { skip }, async t => {
  await runBundle({ caseId: 'b-tie-available', controller: 'priority', out: join(BASE, 'good') });
  await runBundle({ caseId: 'b-tie-available', controller: 'independent', out: join(BASE, 'other') });

  await t.test('GREEN: an untouched bundle verifies, the score is recomputed, and the bundle is unchanged', async () => {
    const before = digest(join(BASE, 'good'));
    const r = await verifyBundle(join(BASE, 'good'));
    assert.equal(r.ok, true, JSON.stringify(r));
    const score = JSON.parse(readFileSync(join(BASE, 'good/score.json'), 'utf8'));
    assert.equal(r.recomputed.powerEssentialUnservedJ, score.powerEssentialUnservedJ);
    assert.equal(digest(join(BASE, 'good')), before);
  });

  await t.test('RED: a changed workload is detected', async () => {
    const d = copy('workload');
    edit(d, 'case.json', s => s.replace('"atUs": 1800000000', '"atUs": 2400000000'));
    assert.equal((await verifyBundle(d)).code, 'workload_changed');
  });

  await t.test('RED: a reordered action receipt is detected', async () => {
    const d = copy('reordered');
    edit(d, 'receipts.jsonl', s => { const l = s.trim().split('\n'); [l[1], l[2]] = [l[2], l[1]]; return `${l.join('\n')}\n`; });
    assert.equal((await verifyBundle(d)).code, 'receipt_ledger_invalid');
  });

  await t.test('RED: an altered clock mapping is detected', async () => {
    const d = copy('clock');
    edit(d, 'manifest.json', s => s.replace('"acceleration": 60', '"acceleration": 30'));
    assert.equal((await verifyBundle(d)).code, 'clock_mapping_changed');
  });

  await t.test('RED: a score copied from another run is detected', async () => {
    const d = copy('copied');
    cpSync(join(BASE, 'other/score.json'), join(d, 'score.json'));
    assert.equal((await verifyBundle(d)).code, 'score_provenance');
  });

  await t.test('RED: a score edited in place is detected by recomputation', async () => {
    const d = copy('edited');
    edit(d, 'score.json', s => s.replace(/"powerEssentialUnservedJ": [0-9.]+/, '"powerEssentialUnservedJ": 1'));
    assert.equal((await verifyBundle(d)).code, 'score_mismatch');
  });
});
