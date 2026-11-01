// Append-only, hash-chained run ledger. Each JSONL record commits to its predecessor, so a retained
// manifest (record count and last hash) detects edits, reordering, duplication and truncation. The
// chain shows the ledger is unchanged since finalization; it is not proof that the experiment was honest.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { canonicalRecord } from './identity.mjs';

const GENESIS = '0'.repeat(64);
const hashOf = ({ seq, prevHash, type, atUnixMs, data }) => canonicalRecord({ seq, prevHash, type, atUnixMs, data }).sha256;

export class Ledger {
  constructor(path) {
    this.path = path;
    this.seq = 0;
    this.lastHash = GENESIS;
    this.finalized = false;
  }

  append(type, data = {}) {
    if (this.finalized) throw new Error('ledger finalized: no further appends');
    const body = { seq: this.seq + 1, prevHash: this.lastHash, type, atUnixMs: Date.now(), data: JSON.parse(JSON.stringify(data ?? {})) };
    const record = { ...body, hash: hashOf(body) };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    this.seq = record.seq;
    this.lastHash = record.hash;
    return record;
  }

  finalize() {
    this.finalized = true;
    return { version: 'LedgerManifestV1', records: this.seq, lastHash: this.lastHash };
  }
}

export function verifyLedger(path, manifest) {
  if (!existsSync(path)) return { ok: false, code: 'ledger_missing', verifiedRecords: 0 };
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const complete = text.endsWith('\n');
  if (complete) lines.pop();
  let prev = GENESIS, seq = 0;
  for (let i = 0; i < lines.length; i++) {
    let record;
    try { record = JSON.parse(lines[i]); } catch { record = null; }
    const last = i === lines.length - 1;
    if (!record) return { ok: false, code: last && !complete ? 'truncated_final_record' : 'malformed_record', verifiedRecords: seq, atLine: i + 1 };
    if (record.seq !== seq + 1) return { ok: false, code: 'sequence_error', verifiedRecords: seq, atSeq: record.seq };
    if (record.prevHash !== prev || record.hash !== hashOf(record)) return { ok: false, code: 'hash_mismatch', verifiedRecords: seq, atSeq: record.seq };
    prev = record.hash;
    seq = record.seq;
  }
  if (!complete && lines.length) return { ok: false, code: 'truncated_final_record', verifiedRecords: seq };
  if (!manifest) return { ok: false, code: 'manifest_missing', verifiedRecords: seq, lastHash: prev };
  if (manifest.records !== seq || manifest.lastHash !== prev) return { ok: false, code: 'manifest_mismatch', verifiedRecords: seq, lastHash: prev };
  return { ok: true, code: 'ok', verifiedRecords: seq, lastHash: prev };
}

// Read a run's events as plain records: ledger entries are unwrapped; pre-ledger bundles are read as is.
export function readEvents(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { const r = JSON.parse(line); return [r.hash && r.data ? { ...r.data, type: r.type, atUnixMs: r.atUnixMs, seq: r.seq } : r]; } catch { return []; }
  });
}
