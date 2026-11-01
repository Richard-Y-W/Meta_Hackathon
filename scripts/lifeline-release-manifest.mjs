// Evidence snapshot: code identity, dirty files, frozen protocol and retained run bundles, with the pilot's
// first attempts separated from withdrawn reruns. Read-only over artifacts; writes one manifest.
//   node scripts/lifeline-release-manifest.mjs --out artifacts/lifeline/infra/p00-run-0/release-manifest.json
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitOutputPath } from '../src/lifeline/storage.mjs';

// The corrected rule applies to first attempts; a rerun counts only if its block's first attempt stays invalid.
export function classifyPilotAttempts(index, reclassification) {
  const after = Object.fromEntries(reclassification.filter(r => r.attempt === 1).map(r => [r.episodeId, r.after]));
  const firstAttempts = index.filter(r => r.attempt === 1).map(r => (after[r.episodeId] ? { ...r, ...after[r.episodeId], reason: after[r.episodeId].reason } : r));
  const invalidBlocks = new Set(firstAttempts.filter(r => r.status !== 'valid').map(r => r.block));
  const reruns = index.filter(r => r.attempt > 1);
  return {
    firstAttempts,
    withdrawn: reruns.filter(r => !invalidBlocks.has(r.block)),
    scoredReruns: reruns.filter(r => invalidBlocks.has(r.block)),
    reclassified: reclassification.filter(r => r.attempt === 1 && r.before.status !== r.after.status).map(r => r.episodeId),
  };
}

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function bundle(dir, root) {
  const files = Object.fromEntries(['manifest.json', 'summary.json', 'events.jsonl', 'controller-view.jsonl', 'checksums.txt']
    .filter(f => existsSync(join(dir, f))).map(f => [f, sha(join(dir, f))]));
  const m = existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : {};
  return { path: relative(root, dir), runId: m.runId ?? null, terminal: m.terminal ?? null, commit: m.code?.commit ?? null, ledger: m.ledger ?? null, files };
}

function findBundles(root, dir = root, depth = 0) {
  if (depth > 3 || !existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) return [];
    return existsSync(join(path, 'manifest.json')) ? [path] : findBundles(root, path, depth + 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const argv = process.argv.slice(2);
  const out = resolve(argv[argv.indexOf('--out') + 1]);
  const admitted = admitOutputPath(repo, out);
  if (!admitted.ok) { console.log(JSON.stringify(admitted)); process.exit(2); }
  const git = (...a) => execFileSync('git', ['-C', repo, ...a]).toString().trim();
  const evidence = join(repo, 'artifacts/lifeline/guest');
  const lines = p => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const pilot = classifyPilotAttempts(lines(join(evidence, 'pilot-v1/index.jsonl')), lines(join(evidence, 'pilot-v1/reclassification.jsonl')));
  const bundles = findBundles(evidence).map(d => bundle(d, repo));
  const manifest = {
    version: 'LifelineReleaseManifestV1', createdAtUnixMs: Date.now(),
    code: { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: git('status', '--porcelain').split('\n').filter(Boolean) },
    frozen: Object.fromEntries(['fixtures/lifeline/protocol-v1.json', 'fixtures/lifeline/policy-v1.json', 'docs/superpowers/plans/2026-10-31-lifeline-communications-v1-archive.md']
      .map(p => [p, sha(join(repo, p))])),
    pilot: {
      firstAttempts: pilot.firstAttempts.map(r => ({ episodeId: r.episodeId, status: r.status, runId: r.runId })),
      withdrawnReruns: pilot.withdrawn.map(r => ({ episodeId: r.episodeId, attempt: r.attempt, status: r.status, reason: r.reason, runId: r.runId })),
      scoredReruns: pilot.scoredReruns.map(r => r.episodeId), reclassified: pilot.reclassified,
      originalOutputs: existsSync(join(evidence, 'pilot-v1-original/index.jsonl')) ? sha(join(evidence, 'pilot-v1-original/index.jsonl')) : null,
    },
    bundles,
  };
  writeFileSync(admitted.path, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ commit: manifest.code.commit, dirty: manifest.code.dirty.length, bundles: bundles.length, firstAttempts: pilot.firstAttempts.length, valid: pilot.firstAttempts.filter(r => r.status === 'valid').length, withdrawn: pilot.withdrawn.length, scoredReruns: pilot.scoredReruns.length, reclassified: pilot.reclassified }));
}
