// Receipt-based deadline scoring. The offered manifest is the denominator; receipts only add evidence.

export class ScoreError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; }
}

const time = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const invalid = detail => { throw new ScoreError('workload_invalid', detail); };

// Offered: {id, createdAtMs, deadlineMs (relative), flowId?}. Receipts: {id, receivedAtMs}.
// Messages created in [fromMs, toMs) are scored; the capture must extend through every included deadline.
export function scoreMessages({ offered, receipts, fromMs, toMs, captureThroughMs = toMs, senderManifest }) {
  if (!time(fromMs) || !time(toMs) || toMs < fromMs || !time(captureThroughMs)) invalid('bad_window');
  if (senderManifest) {
    if (!senderManifest.complete) throw new ScoreError('run_incomplete', 'sender_manifest_incomplete');
    if (senderManifest.count !== offered.length) throw new ScoreError('run_incomplete', 'sender_manifest_mismatch');
  }

  const known = new Map();
  for (const m of offered) {
    if (typeof m.id !== 'string' || !m.id || !time(m.createdAtMs) || !time(m.deadlineMs)) invalid('bad_offered_record');
    if (known.has(m.id)) invalid('duplicate_offered_id');
    known.set(m.id, m);
  }
  for (const r of receipts) if (typeof r.id !== 'string' || !time(r.receivedAtMs)) invalid('bad_receipt_record');

  const scored = offered.filter(m => m.createdAtMs >= fromMs && m.createdAtMs < toMs);
  const finalizeAt = Math.max(toMs, ...scored.map(m => m.createdAtMs + m.deadlineMs));
  if (captureThroughMs < finalizeAt) throw new ScoreError('run_incomplete', 'receiver_capture_incomplete');

  const inWindow = new Set(scored.map(m => m.id));
  const earliest = new Map();
  let duplicateReceipts = 0, invalidReceipts = 0, unknownReceipts = 0;
  for (const r of receipts) {
    const m = known.get(r.id);
    if (!m) { unknownReceipts++; continue; }
    if (!inWindow.has(r.id)) continue;
    if (r.receivedAtMs < m.createdAtMs) { invalidReceipts++; continue; }
    if (earliest.has(r.id)) {
      duplicateReceipts++;
      if (r.receivedAtMs < earliest.get(r.id)) earliest.set(r.id, r.receivedAtMs);
    } else earliest.set(r.id, r.receivedAtMs);
  }

  const tally = () => ({ offered: 0, onTime: 0, late: 0, lost: 0 });
  const total = tally();
  const byFlow = {};
  for (const m of scored) {
    const outcome = !earliest.has(m.id) ? 'lost' : earliest.get(m.id) <= m.createdAtMs + m.deadlineMs ? 'onTime' : 'late';
    const groups = [total];
    if (m.flowId !== undefined) groups.push(byFlow[m.flowId] ??= tally());
    for (const g of groups) { g.offered++; g[outcome]++; }
  }
  const rate = g => ({ ...g, deliveryRate: g.offered ? g.onTime / g.offered : null });
  return {
    ...rate(total), duplicateReceipts, invalidReceipts, unknownReceipts,
    byFlow: Object.fromEntries(Object.entries(byFlow).map(([flow, g]) => [flow, rate(g)])),
    window: { fromMs, toMs, finalizeAtMs: finalizeAt, captureThroughMs },
  };
}

// Background demand is scored against its independent schedule, so throttling cannot shrink the denominator.
export function scoreBackground({ offered, delivered, fromMs, toMs }) {
  if (!time(fromMs) || !time(toMs) || toMs < fromMs) invalid('bad_window');
  const sum = records => records.reduce((total, r) => {
    if (!time(r.atMs) || !time(r.bytes)) invalid('bad_background_record');
    return r.atMs >= fromMs && r.atMs < toMs ? total + r.bytes : total;
  }, 0);
  const offeredBytes = sum(offered), deliveredBytes = sum(delivered);
  return { offeredBytes, deliveredBytes, deliveredFraction: offeredBytes ? deliveredBytes / offeredBytes : null };
}
