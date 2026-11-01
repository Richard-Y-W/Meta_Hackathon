// Unprivileged domain worker over stdio: newline-delimited JSON, same framing as the network worker.
// Request {v, id, cmd, args}; reply {v, id, workerSeq, ok, result | error: {code, detail}}.
import { spawn } from 'node:child_process';
import { WorkerError } from '../worker-client.mjs';

const PROTOCOL = 1;
const MAX_FRAME_BYTES = 16 << 20;

export function spawnStdioWorker({ command, args = [], cwd, env, timeoutMs = 30_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const violations = [];
  let buffer = '', stderr = '', nextId = 1, lastSeq = 0, closedReason = null;

  const close = reason => {
    if (closedReason) return;
    closedReason = reason;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new WorkerError('worker_unavailable', reason)); }
    pending.clear();
  };
  const protocolError = kind => { violations.push({ kind }); close('protocol_error'); child.kill('SIGKILL'); };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { return protocolError('malformed_frame'); }
      if (!reply || reply.v !== PROTOCOL || !Number.isInteger(reply.id) || !Number.isInteger(reply.workerSeq) || typeof reply.ok !== 'boolean') return protocolError('malformed_frame');
      if (reply.workerSeq <= lastSeq) return protocolError('non_monotonic_sequence');
      lastSeq = reply.workerSeq;
      const entry = pending.get(reply.id);
      if (!entry) { violations.push({ kind: 'unknown_reply', id: reply.id }); continue; }
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      if (reply.ok) entry.resolve(reply.result);
      else entry.reject(new WorkerError(reply.error?.code ?? 'command_rejected', reply.error?.detail ?? 'unspecified'));
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) protocolError('oversized_frame');
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => { close(buffer.length ? 'truncated_frame' : `exited:${code ?? signal}`); resolve({ code, signal }); }));
  child.on('error', error => close(`spawn_failed:${error.code ?? error.message}`));

  function request(cmd, requestArgs = {}, { timeoutMs: limit = timeoutMs } = {}) {
    if (closedReason) return Promise.reject(new WorkerError('worker_unavailable', closedReason));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new WorkerError('worker_unavailable', 'timeout')); }, limit);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ v: PROTOCOL, id, cmd, args: requestArgs })}\n`);
    });
  }

  return {
    request,
    violations,
    get stderr() { return stderr; },
    get closedReason() { return closedReason; },
    async shutdown({ graceMs = 2000 } = {}) {
      if (!closedReason) await request('shutdown', {}, { timeoutMs: graceMs }).catch(() => {});
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      const result = await exited;
      clearTimeout(timer);
      return result;
    },
  };
}
