import test from 'node:test';
import assert from 'node:assert/strict';
import { duplexPair } from 'node:stream';
import { WorkerClient, PROTOCOL, UNITS } from '../../src/lifeline/worker-client.mjs';

// A scripted fake worker on the other end of an in-memory stream.
function fakeWorker({ hello = {}, onRequest } = {}) {
  const [clientSide, workerSide] = duplexPair();
  let seq = 0;
  let buffer = '';
  const worker = {
    stream: workerSide,
    requests: [],
    send(frame) { workerSide.write(`${JSON.stringify(frame)}\n`); },
    raw(text) { workerSide.write(text); },
    reply(id, result, extra = {}) { worker.send({ v: PROTOCOL, id, workerSeq: ++seq, ok: true, result, ...extra }); },
    fail(id, code, detail) { worker.send({ v: PROTOCOL, id, workerSeq: ++seq, ok: false, error: { code, detail } }); },
    exit() { workerSide.end(); }, // EOF, as a real socket peer produces on exit
  };
  workerSide.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      worker.requests.push(frame);
      if (frame.cmd === 'hello') {
        worker.reply(frame.id, { protocol: PROTOCOL, runId: frame.args.runId, role: frame.args.role, units: UNITS, epochMonotonicNs: '123456789', workerPid: 42, ...hello });
      } else onRequest?.(frame, worker);
    }
  });
  return { worker, client: new WorkerClient(clientSide, { runId: 'run-1', role: 'supervisor' }) };
}

test('handshake agrees protocol, run, role, units and records the run epoch', async () => {
  const { client } = fakeWorker();
  const info = await client.hello();
  assert.equal(client.state, 'ready');
  assert.equal(info.epochMonotonicNs, '123456789');
  assert.equal(info.workerPid, 42);
});

for (const [name, hello, detail] of [
  ['protocol version', { protocol: 99 }, 'protocol_mismatch'],
  ['run ID', { runId: 'run-other' }, 'run_mismatch'],
  ['role', { role: 'orchestrator' }, 'role_mismatch'],
  ['units', { units: { ...UNITS, time: 's' } }, 'units_mismatch'],
]) {
  test(`handshake rejects a mismatched ${name}`, async () => {
    const { client } = fakeWorker({ hello });
    await assert.rejects(client.hello(), err => err.code === 'worker_unavailable' && err.detail === detail);
    assert.equal(client.state, 'closed');
  });
}

test('commands before the handshake are rejected without being sent', async () => {
  const { worker, client } = fakeWorker();
  await assert.rejects(client.request('telemetry', {}), err => err.code === 'worker_unavailable' && err.detail === 'not_ready');
  assert.equal(worker.requests.length, 0);
});

test('replies are correlated by ID even when they arrive out of order', async () => {
  const { client } = fakeWorker({
    onRequest(frame, worker) {
      if (frame.args.n === 1) setTimeout(() => worker.reply(frame.id, { n: 1 }), 20);
      else worker.reply(frame.id, { n: 2 });
    },
  });
  await client.hello();
  const [a, b] = await Promise.all([client.request('echo', { n: 1 }), client.request('echo', { n: 2 })]);
  assert.deepEqual([a.n, b.n], [1, 2]);
});

test('request IDs increase monotonically on the wire', async () => {
  const { worker, client } = fakeWorker({ onRequest: (f, w) => w.reply(f.id, {}) });
  await client.hello();
  await client.request('echo', {});
  await client.request('echo', {});
  const ids = worker.requests.map(r => r.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
  assert.equal(new Set(ids).size, ids.length);
});

test('a non-monotonic worker sequence is a protocol error that closes the client', async () => {
  const { client } = fakeWorker({ onRequest: (f, w) => w.send({ v: PROTOCOL, id: f.id, workerSeq: 1, ok: true, result: {} }) });
  await client.hello();
  await assert.rejects(client.request('echo', {}), err => err.code === 'worker_unavailable' && err.detail === 'protocol_error');
  assert.equal(client.state, 'closed');
});

test('a duplicate reply is recorded and cannot resolve a request twice', async () => {
  const { client } = fakeWorker({ onRequest: (f, w) => { w.reply(f.id, { first: true }); w.reply(f.id, { first: false }); } });
  await client.hello();
  const result = await client.request('echo', {});
  await new Promise(r => setImmediate(r));
  assert.equal(result.first, true);
  assert.deepEqual(client.violations.map(v => v.kind), ['duplicate_reply']);
  assert.equal(client.state, 'ready');
});

test('a malformed frame closes the client with protocol_error', async () => {
  const { client } = fakeWorker({ onRequest: (_f, w) => w.raw('{not json}\n') });
  await client.hello();
  await assert.rejects(client.request('echo', {}), err => err.detail === 'protocol_error');
});

test('a truncated final frame is reported as truncated, not as a reply', async () => {
  const { client } = fakeWorker({ onRequest: (f, w) => { w.raw(`{"v":1,"id":${f.id},"workerSeq":9,"ok":tr`); w.exit(); } });
  await client.hello();
  await assert.rejects(client.request('echo', {}), err => err.code === 'worker_unavailable' && err.detail === 'truncated_frame');
});

test('a request timeout rejects, and a late reply is surfaced for reconciliation', async () => {
  const late = [];
  const { client } = fakeWorker({ onRequest: (f, w) => setTimeout(() => w.reply(f.id, { applied: true }), 60) });
  client.onLateReply = reply => late.push(reply);
  await client.hello();
  await assert.rejects(client.request('set_rate', {}, { timeoutMs: 20 }), err => err.code === 'worker_unavailable' && err.detail === 'timeout');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(late.length, 1);
  assert.equal(late[0].result.applied, true);
  assert.equal(client.violations.length, 0);
});

test('worker exit rejects outstanding requests and every later request', async () => {
  const { worker, client } = fakeWorker({ onRequest: () => {} });
  await client.hello();
  const pending = client.request('telemetry', {});
  worker.exit();
  await assert.rejects(pending, err => err.code === 'worker_unavailable' && err.detail === 'exited');
  await assert.rejects(client.request('telemetry', {}), err => err.code === 'worker_unavailable');
  assert.equal(client.state, 'closed');
});

test('a worker-side rejection keeps its code and leaves the client usable', async () => {
  const { client } = fakeWorker({ onRequest: (f, w) => (f.cmd === 'bad' ? w.fail(f.id, 'command_rejected', 'unknown_command') : w.reply(f.id, { ok: 1 })) });
  await client.hello();
  await assert.rejects(client.request('bad', {}), err => err.code === 'command_rejected' && err.detail === 'unknown_command');
  assert.deepEqual(await client.request('good', {}), { ok: 1 });
});

test('an oversized frame is a protocol error', async () => {
  const { client } = fakeWorker({ onRequest: (f, w) => w.raw('x'.repeat(1_100_000)) });
  await client.hello();
  await assert.rejects(client.request('echo', {}), err => err.detail === 'protocol_error');
});
