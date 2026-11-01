import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO, 'scripts/lifeline-preflight.py');
const SCRATCH = join(REPO, '.work/tmp/preflight-test');
const SSD = '/Volumes/PortableSSD';
const onSsd = existsSync(SSD) && REPO.startsWith(`${SSD}/`);

function preflight(args) {
  const run = spawnSync('python3', [SCRIPT, '--repo', REPO, ...args], { encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: '' } });
  let report = null;
  try { report = JSON.parse(run.stdout); } catch { /* reported by the assertion below */ }
  assert.ok(report, `preflight printed no JSON report: ${run.stderr}`);
  return { status: run.status, report };
}

function fixture(name, values) {
  mkdirSync(SCRATCH, { recursive: true });
  const path = join(SCRATCH, `${name}.json`);
  writeFileSync(path, JSON.stringify(values));
  return path;
}

const COMPLETE = {
  platform: 'Linux', kernel: '6.8.0-test', netns: true, mininet: '2.3.0', ovs: '3.3.0',
  ovsRunning: true, privileged: true, credential: true, python: '3.12.3',
};

test('storage: an absent SSD mount stops before any output is written', () => {
  const out = join(SCRATCH, 'absent-mount.json');
  rmSync(out, { force: true });
  const { status, report } = preflight(['--ssd-root', '/Volumes/NoSuchLifelineDisk', '--storage-only', '--out', out]);
  assert.equal(report.storage.code, 'storage_unavailable');
  assert.notEqual(status, 0);
  assert.equal(existsSync(out), false);
});

test('storage: a plain directory cannot pretend to be the SSD mount', { skip: !onSsd }, () => {
  const fake = join(SCRATCH, 'PortableSSD');
  mkdirSync(fake, { recursive: true });
  const { status, report } = preflight(['--ssd-root', fake, '--storage-only', '--out', join(SCRATCH, 'fake-mount.json')]);
  assert.equal(report.storage.code, 'storage_unavailable');
  assert.notEqual(status, 0);
});

test('storage: an internal-drive repository fallback is rejected', { skip: !onSsd }, () => {
  const run = spawnSync('python3', [SCRIPT, '--repo', '/Users/Shared', '--storage-only', '--out', '/Users/Shared/lifeline-preflight.json'], { encoding: 'utf8' });
  const report = JSON.parse(run.stdout);
  assert.equal(report.storage.code, 'storage_path_rejected');
  assert.notEqual(run.status, 0);
  assert.equal(existsSync('/Users/Shared/lifeline-preflight.json'), false);
});

test('storage: an output symlink escaping the admitted roots is rejected', { skip: !onSsd }, () => {
  mkdirSync(SCRATCH, { recursive: true });
  const link = join(SCRATCH, 'escape');
  rmSync(link, { force: true });
  symlinkSync('/Users/Shared', link);
  const { status, report } = preflight(['--storage-only', '--out', join(link, 'preflight.json')]);
  assert.equal(report.storage.code, 'storage_path_rejected');
  assert.notEqual(status, 0);
  assert.equal(existsSync('/Users/Shared/preflight.json'), false);
});

test('storage: VM backing outside the SSD is rejected', { skip: !onSsd }, () => {
  const { status, report } = preflight(['--storage-only', '--vm-backing', '/Users/Shared', '--out', join(SCRATCH, 'vm.json')]);
  assert.equal(report.storage.code, 'storage_path_rejected');
  assert.notEqual(status, 0);
});

test('storage: the canonical SSD repository and output root are admitted with free space recorded', { skip: !onSsd }, () => {
  const out = join(SCRATCH, 'admitted.json');
  const { status, report } = preflight(['--storage-only', '--vm-backing', join(REPO, '.work/vm'), '--out', out]);
  assert.equal(status, 0, JSON.stringify(report.storage));
  assert.equal(report.storage.code, 'ok');
  assert.ok(report.storage.repo.startsWith(`${SSD}/`));
  assert.ok(report.storage.freeBytes > 0);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).storage, report.storage);
});

const MISSING = [
  ['linux', { platform: 'Darwin' }, 'linux_unavailable'],
  ['netns', { netns: false }, 'netns_unavailable'],
  ['mininet', { mininet: null }, 'mininet_missing'],
  ['ovs', { ovs: null }, 'ovs_missing'],
  ['ovs', { ovsRunning: false }, 'ovs_not_running'],
  ['workerPrivilege', { privileged: false }, 'privilege_unavailable'],
  ['credential', { credential: false }, 'credential_missing'],
];

for (const [capability, override, code] of MISSING) {
  test(`capability: ${code} is reported precisely and blocks readiness`, { skip: !onSsd }, () => {
    const probe = fixture(`probe-${code}`, { ...COMPLETE, ...override });
    const { status, report } = preflight(['--probe-fixture', probe, '--out', join(SCRATCH, `${code}.json`)]);
    assert.equal(status, 0);
    assert.equal(report.probeSource, 'fixture');
    assert.equal(report.capabilities[capability].available, false);
    assert.equal(report.capabilities[capability].code, code);
    assert.ok(report.missing.includes(code));
    // A missing credential blocks only provider use; every other gap blocks only packet work.
    assert.equal(report.providerReady, capability !== 'credential');
    assert.equal(report.packetReady, capability === 'credential');
  });
}

test('capability: a complete record is ready, but a fixture is never qualification evidence', { skip: !onSsd }, () => {
  const probe = fixture('probe-complete', COMPLETE);
  const { report } = preflight(['--probe-fixture', probe, '--out', join(SCRATCH, 'complete.json')]);
  assert.deepEqual(report.missing, []);
  assert.equal(report.packetReady, true);
  assert.equal(report.providerReady, true);
  assert.equal(report.qualificationEvidence, false);
  assert.equal(report.versions.mininet, '2.3.0');
});

test('capability: the report never contains the credential value', { skip: !onSsd }, () => {
  const run = spawnSync('python3', [SCRIPT, '--repo', REPO, '--storage-only', '--out', join(SCRATCH, 'secret.json')], {
    encoding: 'utf8', env: { ...process.env, MODEL_API_KEY: 'sk-test-must-not-appear' },
  });
  assert.equal(run.stdout.includes('sk-test-must-not-appear'), false);
  assert.equal(readFileSync(join(SCRATCH, 'secret.json'), 'utf8').includes('sk-test-must-not-appear'), false);
});

// Provider smoke: parsing and failure classification only. A mocked response is never provider evidence.
const { smokeOnce, summarize } = await import('../../scripts/lifeline-provider-smoke.mjs');
const { admitOutputPath } = await import('../../src/lifeline/storage.mjs');
const KEY = 'sk-test-provider-secret';
const VALID = JSON.stringify({ hypothesis: 'r0-r3 outage moved essential traffic onto ring links', action: 'probe_path', evidence: ['obs-3'] });
const reply = (body, init = {}) => async () => ({ ok: init.status ? init.status < 300 : true, status: init.status ?? 200, json: async () => body, text: async () => JSON.stringify(body) });

test('provider: an absent credential is a precise unavailable outcome with no request sent', async () => {
  let calls = 0;
  const record = await smokeOnce({ apiKey: '', model: 'muse-spark-1.3', fetchImpl: async () => { calls++; } });
  assert.equal(record.code, 'provider_unavailable');
  assert.equal(record.reason, 'credential_missing');
  assert.equal(calls, 0);
});

test('provider: a timeout is provider_timeout with measured duration', async () => {
  const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const record = await smokeOnce({ apiKey: KEY, model: 'm', timeoutMs: 40, fetchImpl: hang });
  assert.equal(record.code, 'provider_timeout');
  assert.ok(record.durationMs >= 30);
});

test('provider: an HTTP error is provider_unavailable with status and no credential echo', async () => {
  const record = await smokeOnce({ apiKey: KEY, model: 'm', fetchImpl: reply({ error: `bad key ${KEY}` }, { status: 401 }) });
  assert.equal(record.code, 'provider_unavailable');
  assert.equal(record.httpStatus, 401);
  assert.equal(JSON.stringify(record).includes(KEY), false);
});

test('provider: malformed model output is retained as a parser failure, not a success', async () => {
  const record = await smokeOnce({ apiKey: KEY, model: 'm', fetchImpl: reply({ id: 'r1', output_text: 'not json' }) });
  assert.equal(record.code, 'ok');
  assert.equal(record.parserOutcome, 'invalid_json');
  const missing = await smokeOnce({ apiKey: KEY, model: 'm', fetchImpl: reply({ id: 'r2', output_text: '{"hypothesis":"x"}' }) });
  assert.equal(missing.parserOutcome, 'invalid_fields');
});

test('provider: a valid response records model, response ID, usage and a payload hash without the credential', async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    sent = { url, options };
    return reply({ id: 'resp-9', model: 'muse-spark-1.3', usage: { input_tokens: 210, output_tokens: 44 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: VALID }] }] })();
  };
  const record = await smokeOnce({ apiKey: KEY, model: 'muse-spark-1.3', fetchImpl });
  assert.equal(sent.url, 'https://api.meta.ai/v1/responses');
  assert.equal(record.code, 'ok');
  assert.equal(record.parserOutcome, 'valid');
  assert.equal(record.responseId, 'resp-9');
  assert.deepEqual(record.usage, { input_tokens: 210, output_tokens: 44 });
  assert.match(record.payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(record).includes(KEY), false);
  assert.equal(sent.options.body.includes(KEY), false);
});

test('provider: the summary keeps every attempt and reports the raw latency distribution', () => {
  const s = summarize([{ code: 'ok', parserOutcome: 'valid', durationMs: 900 }, { code: 'provider_timeout', durationMs: 6000 }, { code: 'ok', parserOutcome: 'invalid_json', durationMs: 1200 }]);
  assert.equal(s.attempts, 3);
  assert.equal(s.succeeded, 2);
  assert.equal(s.validDecisions, 1);
  assert.deepEqual(s.okDurationsMs, [900, 1200]);
  assert.equal(s.p95Claimed, false);
});

test('provider: outputs are admitted only under artifacts/ or .work/ after resolving symlinks', { skip: !onSsd }, () => {
  assert.equal(admitOutputPath(REPO, join(REPO, 'artifacts/lifeline/provider-smoke.json')).ok, true);
  assert.equal(admitOutputPath(REPO, '/Users/Shared/smoke.json').code, 'storage_path_rejected');
  assert.equal(admitOutputPath(REPO, join(SCRATCH, 'escape/smoke.json')).code, 'storage_path_rejected');
  assert.equal(admitOutputPath('/Users/Shared', '/Users/Shared/artifacts/x.json').code, 'storage_path_rejected');
});

test('storage: guest-role outputs must stay in the guest workspace repository', () => {
  assert.equal(admitOutputPath('/Users/Shared', '/Users/Shared/artifacts/x.json', { role: 'guest', workspace: '/workspace' }).code, 'storage_path_rejected');
});

// P00: caches, capacity admission and disk-image-backed VM storage.
test('P00 storage: an explicit cache path on the internal drive is rejected', { skip: !onSsd }, () => {
  const { status, report } = preflight(['--storage-only', '--cache', '/Users/Shared/lifeline-cache', '--out', join(SCRATCH, 'cache.json')]);
  assert.equal(report.storage.code, 'storage_path_rejected');
  assert.equal(report.storage.detail, 'cache_off_ssd');
  assert.notEqual(status, 0);
});

test('P00 storage: a tool cache configured through the environment is checked too', { skip: !onSsd }, () => {
  const run = spawnSync('python3', [SCRIPT, '--repo', REPO, '--storage-only', '--out', join(SCRATCH, 'env-cache.json')], {
    encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/Users/Shared/ms-playwright' },
  });
  const report = JSON.parse(run.stdout);
  assert.equal(report.storage.detail, 'cache_off_ssd');
  assert.match(report.storage.path, /PLAYWRIGHT_BROWSERS_PATH/);
});

test('P00 storage: admission fails when free space cannot hold the projected batch plus reserve', { skip: !onSsd }, () => {
  const { status, report } = preflight(['--storage-only', '--projected-bytes', String(10 ** 15), '--reserve-bytes', '1000000000', '--out', join(SCRATCH, 'cap.json')]);
  assert.equal(report.storage.code, 'storage_insufficient');
  assert.notEqual(status, 0);
  const ok = preflight(['--storage-only', '--projected-bytes', '1000', '--reserve-bytes', '1000', '--out', join(SCRATCH, 'cap-ok.json')]);
  assert.equal(ok.report.storage.code, 'ok');
  assert.equal(ok.report.storage.capacity.requiredBytes, 2000);
});

test('P00 storage: a VM disk on a mounted image is admitted only when the image file lies on the SSD', { skip: !onSsd }, () => {
  const images = fixture('hdiutil', { '/Volumes/LifelineVM': join(REPO, '.work/vm/lifeline-apfs.sparsebundle'), '/Volumes/Elsewhere': '/Users/Shared/disk.sparsebundle' });
  const good = preflight(['--storage-only', '--disk-image-fixture', images, '--vm-backing', '/Volumes/LifelineVM/lima/lifeline/disk', '--out', join(SCRATCH, 'img-ok.json')]);
  assert.equal(good.report.storage.code, 'ok', JSON.stringify(good.report.storage));
  assert.equal(good.report.storage.vmBacking[0].image, join(REPO, '.work/vm/lifeline-apfs.sparsebundle'));
  const bad = preflight(['--storage-only', '--disk-image-fixture', images, '--vm-backing', '/Volumes/Elsewhere/vm/disk', '--out', join(SCRATCH, 'img-bad.json')]);
  assert.equal(bad.report.storage.code, 'storage_path_rejected');
  assert.equal(bad.report.storage.detail, 'vm_backing_off_ssd');
});

test('P00 storage: the report names physical environment, cache and temporary roots with free capacity', { skip: !onSsd }, () => {
  const { report } = preflight(['--storage-only', '--out', join(SCRATCH, 'roots.json')]);
  for (const root of ['environments', 'cache', 'tmp', 'logs', 'vm']) assert.ok(report.storage.roots[root].startsWith(`${SSD}/`), root);
  assert.ok(report.storage.capacity.freeBytes > 0);
});
