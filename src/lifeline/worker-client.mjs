// Typed transport to the privileged network worker: newline-delimited JSON over a private stream.
// Request: {v, id, cmd, args}. Reply: {v, id, workerSeq, ok, result | error: {code, detail}}.

export const PROTOCOL = 1;
export const UNITS = { time: 'ms', rate: 'bit/s', size: 'byte', clock: 'CLOCK_MONOTONIC' };
const MAX_FRAME_BYTES = 1 << 20;
const DEFAULT_TIMEOUT_MS = 5000;

export class WorkerError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; }
}

export class WorkerClient {
  constructor(stream, { runId, role }) {
    this.stream = stream;
    this.runId = runId;
    this.role = role;
    this.state = 'connecting';
    this.violations = [];
    this.onLateReply = null;
    this.nextId = 1;
    this.lastWorkerSeq = 0;
    this.pending = new Map();
    this.timedOut = new Set();
    this.answered = new Set();
    this.buffer = '';
    stream.setEncoding?.('utf8');
    stream.on('data', chunk => this.#receive(chunk));
    // A worker that dies mid-frame may emit only 'close'; leftover bytes mean a truncated frame either way.
    const ended = () => this.#close(this.buffer.length ? 'truncated_frame' : 'exited');
    stream.on('end', ended);
    stream.on('close', ended);
    stream.on('error', ended);
  }

  async hello({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const info = await this.#send('hello', { protocol: PROTOCOL, runId: this.runId, role: this.role, units: UNITS }, timeoutMs);
    const mismatch = info.protocol !== PROTOCOL ? 'protocol_mismatch'
      : info.runId !== this.runId ? 'run_mismatch'
        : info.role !== this.role ? 'role_mismatch'
          : JSON.stringify(info.units) !== JSON.stringify(UNITS) ? 'units_mismatch' : null;
    if (mismatch) { this.#close(mismatch); throw new WorkerError('worker_unavailable', mismatch); }
    this.info = info;
    this.state = 'ready';
    return info;
  }

  request(cmd, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.state !== 'ready') return Promise.reject(new WorkerError('worker_unavailable', this.state === 'closed' ? this.closedReason : 'not_ready'));
    return this.#send(cmd, args, timeoutMs);
  }

  close() { this.#close('client_closed'); this.stream.destroy?.(); }

  #send(cmd, args, timeoutMs) {
    if (this.state === 'closed') return Promise.reject(new WorkerError('worker_unavailable', this.closedReason));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timedOut.add(id);
        reject(new WorkerError('worker_unavailable', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, cmd });
      this.stream.write(`${JSON.stringify({ v: PROTOCOL, id, cmd, args })}\n`);
    });
  }

  #receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.#frame(line)) return;
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) this.#protocolError('oversized_frame');
  }

  #frame(line) {
    let reply;
    try { reply = JSON.parse(line); } catch { return this.#protocolError('malformed_frame'); }
    if (!reply || reply.v !== PROTOCOL || !Number.isInteger(reply.id) || !Number.isInteger(reply.workerSeq) || typeof reply.ok !== 'boolean') {
      return this.#protocolError('malformed_frame');
    }
    if (reply.workerSeq <= this.lastWorkerSeq) return this.#protocolError('non_monotonic_sequence');
    this.lastWorkerSeq = reply.workerSeq;
    const entry = this.pending.get(reply.id);
    if (!entry) {
      // A timed-out command may still have taken effect; hand its reply to reconciliation.
      if (this.timedOut.delete(reply.id)) { this.answered.add(reply.id); this.onLateReply?.(reply); }
      else this.violations.push({ kind: this.answered.has(reply.id) ? 'duplicate_reply' : 'unknown_reply', id: reply.id });
      return true;
    }
    this.pending.delete(reply.id);
    this.answered.add(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new WorkerError(reply.error?.code ?? 'command_rejected', reply.error?.detail ?? 'unspecified'));
    return true;
  }

  #protocolError(kind) {
    this.violations.push({ kind });
    this.#close('protocol_error');
    this.stream.destroy?.();
    return false;
  }

  #close(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closedReason = reason;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new WorkerError('worker_unavailable', reason));
    }
    this.pending.clear();
  }
}
