// P16: verify a retained town bundle without contacting the provider or changing the bundle. Checks the
// receipt chain, the workload and fixture identity, the clock mapping, the score's binding to this run,
// then re-simulates the town by re-issuing the recorded commands at their recorded times and recomputes
// the score.
//   node scripts/lifeline-infra-replay.mjs --run artifacts/lifeline/infra/town-release-run-0/<bundle> --verify
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTownWorker } from '../src/lifeline/domains/town.mjs';
import { canonicalRecord } from '../src/lifeline/identity.mjs';
import { readEvents, verifyLedger } from '../src/lifeline/ledger.mjs';
import { caseHash, FIXTURES, sha } from './lifeline-infra-run.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(readFileSync(p, 'utf8'));

export async function verifyBundle(dir, { makeTown = () => spawnTownWorker({ root: ROOT }) } = {}) {
  const fail = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });
  const manifest = read(join(dir, 'manifest.json'));
  const score = read(join(dir, 'score.json'));
  const c = read(join(dir, 'case.json'));
  const town = read(resolve(ROOT, 'fixtures/lifeline/infra/town/development.json'));
  const policy = read(resolve(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json'));
  const ledger = verifyLedger(join(dir, 'receipts.jsonl'), manifest.ledger);
  if (!ledger.ok) return fail('receipt_ledger_invalid', ledger.code);
  const events = readEvents(join(dir, 'receipts.jsonl'));
  for (let i = 1; i < events.length; i++) if (events[i].atUs < events[i - 1].atUs) return fail('receipt_order', `seq ${events[i].seq}`);
  if (caseHash(c) !== manifest.workload.caseSha256) return fail('workload_changed', 'case differs from the manifest');
  const declared = policy.cases.find(x => x.caseId === manifest.caseId);
  const extra = c.faults.filter(f => !declared?.faults.some(d => JSON.stringify(d) === JSON.stringify(f)));
  if (!declared || declared.faults.some(d => !c.faults.some(f => JSON.stringify(d) === JSON.stringify(f)))) return fail('workload_changed', 'case differs from the protocol fixture');
  for (const [f, h] of Object.entries(manifest.workload.fixtures)) if (sha(f) !== h) return fail('workload_changed', `fixture ${f} changed`);
  const traceClock = read(join(dir, 'trace.json')).clock;
  if (JSON.stringify(manifest.clock) !== JSON.stringify(traceClock) || manifest.clock.mode !== town.clock.mode || manifest.clock.acceleration !== town.clock.acceleration) return fail('clock_mapping_changed');
  if (score.runId !== manifest.runId || score.manifestSha256 !== canonicalRecord(manifest).sha256) return fail('score_provenance', 'score not bound to this manifest');
  // Re-simulate from the recorded commands (no controller, no provider).
  const t = makeTown();
  try {
    await t.initialize({ caseId: 't-no-fault', faults: c.faults, tankInitialLevels: c.tankInitialLevels });
    const mismatches = [];
    for (const e of events.filter(x => x.type === 'command' && x.action && ['delivered', 'rejected', 'unconfirmed'].includes(x.status))) {
      const st = await t.state();
      if (e.atUs > st.nowUs) await t.advance(e.atUs);
      const now = await t.state();
      const r = await t.command(e.action.type === 'set_switch' ? 'power' : e.action.type.endsWith('generator') ? 'resource' : 'water', e.action, e.action.type === 'set_switch' ? now.revisions.power : now.revisions.water);
      if (r.status !== e.status) mismatches.push({ seq: e.seq, recorded: e.status, replayed: r.status });
    }
    await t.advance(manifest.durationUs);
    const truth = await t.evaluatorTruth();
    const recomputed = { waterEssentialUnmetM3: truth.water.essentialUnmetM3, powerEssentialUnservedJ: truth.power.essentialUnservedJ };
    const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (mismatches.length) return fail('receipt_replay_mismatch', mismatches.slice(0, 5));
    if (!same(recomputed.waterEssentialUnmetM3, score.waterEssentialUnmetM3) || !same(recomputed.powerEssentialUnservedJ, score.powerEssentialUnservedJ)) return fail('score_mismatch', { recorded: score, recomputed });
    return { ok: true, code: 'ok', runId: manifest.runId, ledgerRecords: ledger.verifiedRecords, recomputed, extraFaults: extra.length };
  } finally { await t.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await verifyBundle(resolve(process.argv[process.argv.indexOf('--run') + 1]));
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
}
