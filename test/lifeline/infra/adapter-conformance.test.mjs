import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createCommunicationsAdapter } from '../../../src/lifeline/domains/communications.mjs';
import { validateEnvelope } from '../../../src/lifeline/kernel/contracts.mjs';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const SCENARIO = read('../../../fixtures/lifeline/development/cascade.json');
const POLICY = read('../../../fixtures/lifeline/policy-v1.json');
const LINKS = SCENARIO.topology.links.map(l => l.linkId);

function fakeClient() {
  const applied = [];
  let seq = 0;
  const client = {
    applied,
    async request(cmd, args) {
      if (cmd === 'telemetry') {
        seq++;
        return { version: 'ObservationV1', runId: 'run-1', seq, collectedAtMs: 1000 + seq * 500, configRevision: 1, sampleIntervalMs: 500,
          links: Object.fromEntries(LINKS.map(id => [id, { state: id === 'r0-r3' ? 'down' : 'up', txBytes: Object.fromEntries(id.split('-').map(e => [e, id === 'r1-r2' ? null : 1000 * seq])) }])),
          services: {} };
      }
      applied.push(cmd);
      if (cmd === 'prepare_route') return { status: 'prepared', version: 1, effects: [] };
      if (cmd === 'commit_route') return { status: 'committed', version: 1, configRevision: 2, effects: [] };
      if (cmd === 'verify_route') return { version: args.version, packets: { r3: applied.length * 10 } };
      if (cmd === 'retire_route') return { status: 'retired', remaining: 0 };
      if (cmd === 'set_rate') return { status: 'applied', sourceId: args.sourceId, priorBps: 6_500_000, appliedBps: args.bitsPerSecond, readBackBps: args.bitsPerSecond };
      return { status: 'unknown' };
    },
  };
  return client;
}

async function ready(o = {}) {
  const client = fakeClient();
  const adapter = createCommunicationsAdapter({ client, now: () => 5000, sleep: async () => {}, ...o });
  const init = await adapter.initialize({ runId: 'run-1', scenario: SCENARIO, policy: POLICY });
  assert.equal(init.ok, true);
  return { adapter, client };
}

const action = (o = {}) => ({ schemaVersion: 'infra-contract-v1', runId: 'run-1', domainId: 'communications', sequence: 1, tickUs: 5_000_000, kind: 'action',
  actionId: 'act-1', capabilityId: 'comms.set_route', parameters: { flowId: 'dispatch-clinic', path: ['r0', 'r5', 'r4', 'r3'], ackPath: ['r3', 'r4', 'r5', 'r0'] },
  preconditions: [], effectDeadlineUs: 20_000_000, lockSet: ['r0', 'r5', 'r4', 'r3'], authorityGrant: 'grant-sim-1', compensation: 'rollback', ...o });

test('describe reports exact operations, explicit limitations and valid capability records', () => {
  const d = createCommunicationsAdapter({ client: fakeClient() }).describe();
  assert.equal(d.domainId, 'communications');
  assert.deepEqual(Object.entries(d.operations).filter(([, v]) => !v).map(([k]) => k).sort(), ['advance', 'checkpoint', 'restore']);
  assert.ok(d.limitations.some(l => /checkpoint/.test(l)));
  assert.deepEqual(d.capabilities.map(c => c.actionType).sort(), ['probe_path', 'retain_policy', 'set_background_rate', 'set_route']);
  for (const c of d.capabilities) assert.equal(validateEnvelope(c).ok, true, JSON.stringify(validateEnvelope(c)));
});

test('operations before initialize are refused', async () => {
  const adapter = createCommunicationsAdapter({ client: fakeClient() });
  assert.equal((await adapter.observe({})).code, 'not_initialized');
});

test('observe returns canonical observation envelopes; missing counters are null with a reason', async () => {
  const { adapter } = await ready();
  const r = await adapter.observe({});
  assert.equal(r.ok, true);
  for (const o of r.observations) assert.equal(validateEnvelope(o).ok, true, JSON.stringify([o, validateEnvelope(o)]));
  const missing = r.observations.find(o => o.assetId === 'r1-r2:r1' && o.metric === 'comms.bytes');
  assert.deepEqual(missing.quantity, { value: null, unit: 'B', missingReason: 'counter_unreported' });
  assert.equal(missing.quality, 'missing');
  const down = r.observations.find(o => o.assetId === 'r0-r3' && o.metric === 'link.state');
  assert.equal(down.quantity.value, 0);
});

test('unsupported operations say so instead of succeeding', async () => {
  const { adapter } = await ready();
  for (const op of ['checkpoint', 'restore', 'advance']) assert.deepEqual(await adapter[op]({}), { ok: false, code: 'unsupported_operation', operation: op });
});

test('validate applies the communications contract to typed actions', async () => {
  const { adapter } = await ready();
  assert.deepEqual(await adapter.validate(action(), {}), { ok: true, code: 'ok' });
  assert.equal((await adapter.validate(action({ capabilityId: 'comms.reboot' }), {})).code, 'unknown_capability');
  assert.equal((await adapter.validate(action({ parameters: { flowId: 'dispatch-clinic', path: ['r0', 'r2', 'r3'], ackPath: ['r3', 'r2', 'r0'] } }), {})).code, 'route_unavailable');
  assert.equal((await adapter.validate(action({ runId: 'run-9' }), {})).code, 'cross_run_reference');
});

test('execute returns a receipt envelope; a duplicate action ID returns the same receipt without a second effect', async () => {
  const { adapter, client } = await ready();
  const first = await adapter.execute(action(), {});
  assert.equal(first.ok, true);
  assert.equal(validateEnvelope(first.receipt).ok, true, JSON.stringify(validateEnvelope(first.receipt)));
  assert.equal(first.receipt.status, 'success');
  const effects = client.applied.length;
  const again = await adapter.execute(action(), {});
  assert.deepEqual(again.receipt, first.receipt);
  assert.equal(again.duplicate, true);
  assert.equal(client.applied.length, effects);
  assert.deepEqual((await adapter.readback('act-1')).receipt, first.receipt);
  assert.equal((await adapter.readback('act-9')).code, 'unknown_action');
});

test('close isolates: a closed adapter refuses work and a fresh adapter is unaffected', async () => {
  const { adapter } = await ready();
  await adapter.close();
  assert.equal((await adapter.observe({})).code, 'adapter_closed');
  assert.equal((await adapter.execute(action(), {})).code, 'adapter_closed');
  const { adapter: fresh } = await ready();
  assert.equal((await fresh.observe({})).ok, true);
});

const BUNDLE = new URL('../../../artifacts/lifeline/guest/recovery-run-0/', import.meta.url).pathname;
test('measurement through the adapter reproduces the original receipt scorer on a retained run', { skip: !existsSync(`${BUNDLE}manifest.json`) }, async () => {
  const manifest = JSON.parse(readFileSync(`${BUNDLE}manifest.json`, 'utf8'));
  const summary = JSON.parse(readFileSync(`${BUNDLE}summary.json`, 'utf8'));
  const adapter = createCommunicationsAdapter({ client: fakeClient() });
  const m = await adapter.measure({ bundleDir: BUNDLE, manifest, scenario: SCENARIO });
  assert.equal(m.ok, true);
  assert.equal(m.score.results.primary.onTime, summary.results.primary.onTime);
  assert.equal(m.score.results.primary.offered, summary.results.primary.offered);
  for (const rec of m.measurements) assert.equal(validateEnvelope(rec).ok, true, JSON.stringify(validateEnvelope(rec)));
});
