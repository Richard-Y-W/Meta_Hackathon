import { createHash } from 'node:crypto';

export class RecordError extends Error {
  constructor(detail) { super(`record_invalid: ${detail}`); this.code = 'record_invalid'; this.detail = detail; }
}

// Canonical form: object keys sorted by UTF-16 code unit, arrays in order, only JSON values.
function encode(value, path) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RecordError(`nonfinite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new RecordError(`unsupported array at ${path}`);
    const items = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new RecordError(`sparse array at ${path}[${i}]`);
      items.push(encode(value[i], `${path}[${i}]`));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new RecordError(`unsupported object at ${path}`);
    if (Object.getOwnPropertySymbols(value).length) throw new RecordError(`symbol key at ${path}`);
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${encode(value[k], `${path}.${k}`)}`).join(',')}}`;
  }
  throw new RecordError(`unsupported ${typeof value} at ${path}`);
}

export function canonicalRecord(value) {
  const json = encode(value, '$');
  return { json, sha256: createHash('sha256').update(json).digest('hex') };
}
