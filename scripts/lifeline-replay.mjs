// Verify a retained run bundle without calling the provider or rerunning traffic:
//   node scripts/lifeline-replay.mjs --run artifacts/lifeline/<run> --verify [--out report.json]
// Checks ledger continuity against the manifest, recomputes every score from raw sender/receiver records,
// replays contract-level proposal validation, and checks decision/execution linkage.
// It does not reproduce kernel timing and does not prove counterfactual causality.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLedger, readEvents } from '../src/lifeline/ledger.mjs';
import { scoreRun } from '../src/lifeline/run-score.mjs';
import { validateProposal } from '../src/lifeline/contracts.mjs';
import { canonicalRecord } from '../src/lifeline/identity.mjs';

// Compare a recorded decision's contract-level check with a replayed validateProposal result. Guard
// checks that need run state (link state, preconditions, transitions, budgets) are not replayable here.
export function compareContractDecision(decision, replayed) {
  const check = (decision.checks ?? []).find(c => c.check === 'contract');
  if (!check) return 'not_comparable';
  if (check.ok) return replayed.ok ? 'agree' : 'disagree';
  return !replayed.ok && replayed.code === check.code && replayed.detail === check.detail ? 'agree' : 'disagree';
}

export function replayRun(dir, repo) {
  const read = p => JSON.parse(readFileSync(p, 'utf8'));
  const manifest = read(join(dir, 'manifest.json'));
  const summary = read(join(dir, 'summary.json'));
  const report = { runId: manifest.runId, checks: {} };
  report.checks.ledger = manifest.ledger ? verifyLedger(join(dir, 'events.jsonl'), manifest.ledger) : { ok: false, code: 'pre_ledger_bundle' };

  const scenario = read(resolve(repo, manifest.scenario.path));
  report.checks.scenarioIdentity = { ok: canonicalRecord(scenario).sha256 === manifest.scenario.sha256 };
  // Windows follow the faults actually applied: scheduled and judge faults are both in the ledger.
  const applied = readEvents(join(dir, 'events.jsonl')).filter(e => e.type === 'admin_fault' || e.type === 'operator_fault').map(e => e.fault);
  const faults = applied.length ? applied.filter(f => f.atMs < manifest.durationMs) : scenario.faults.filter(f => f.atMs < manifest.durationMs);
  const recomputed = scoreRun(join(dir, 'raw'), scenario, BigInt(manifest.workerEpochMonotonicNs), manifest.trafficStartAtMs, manifest.durationMs, faults);
  const strip = r => JSON.stringify(Object.fromEntries(Object.entries(r.results).map(([w, v]) => [w, { offered: v.offered, onTime: v.onTime, late: v.late, lost: v.lost }])));
  report.checks.score = { ok: strip(recomputed) === strip(summary), primary: recomputed.results.primary && { offered: recomputed.results.primary.offered, onTime: recomputed.results.primary.onTime, deliveryRate: recomputed.results.primary.deliveryRate } };

  const events = readEvents(join(dir, 'events.jsonl'));
  const decisions = events.filter(e => e.type === 'decision');
  const executions = events.filter(e => e.type === 'execution');
  const observations = Object.fromEntries(readFileSync(join(dir, 'controller-view.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(o => [o.seq, o]));
  let agreed = 0, compared = 0;
  const disagreements = [];
  if (manifest.policy) {
    const policy = read(resolve(repo, manifest.policy.path));
    const topology = { revision: scenario.topologyRevision, nodes: scenario.topology.switches, links: scenario.topology.links.map(({ linkId, a, b }) => ({ linkId, a, b })), endpoints: Object.fromEntries(scenario.topology.hosts.map(h => [h.hostId, h.switch])) };
    for (const d of decisions) {
      const fresh = observations[d.decision.observationSeq];
      if (!fresh) continue;
      const contract = validateProposal(d.proposal, { runId: manifest.runId, configRevision: d.decision.configRevision, nowMs: d.decision.decidedAtMs, policy, policyId: manifest.policy.sha256, topology,
        freshObservation: { seq: fresh.seq, atMs: fresh.collectedAtMs }, budgets: { remainingBundles: 1, remainingIncidentProbeBytes: Infinity } });
      const verdict = compareContractDecision(d.decision, contract);
      if (verdict === 'not_comparable') continue;
      compared++;
      if (verdict === 'agree') agreed++;
      else disagreements.push({ proposalId: d.proposal.proposalId, recorded: (d.decision.checks.find(c => c.check === 'contract')), replayed: contract });
    }
  }
  report.checks.contracts = { ok: disagreements.length === 0, compared, agreed, disagreements };
  const admitted = new Set(decisions.filter(d => d.decision.admitted).map(d => d.proposal.proposalId));
  const executed = new Set(executions.map(e => e.proposalId));
  report.checks.linkage = { ok: [...admitted].every(id => executed.has(id)) && [...executed].every(id => admitted.has(id)), admitted: admitted.size, executed: executed.size,
    missingExecution: [...admitted].filter(id => !executed.has(id)), unadmittedExecution: [...executed].filter(id => !admitted.has(id)) };
  report.ok = Object.values(report.checks).every(c => c.ok);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const report = replayRun(resolve(arg('--run')), repo);
  if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 1));
  if (argv.includes('--verify') && !report.ok) process.exitCode = 1;
}
