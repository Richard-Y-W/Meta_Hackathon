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

const CONTRACT_CODES = new Set(['proposal_invalid', 'policy_mismatch', 'configuration_stale', 'observation_stale', 'route_unavailable', 'action_rejected']);

export function replayRun(dir, repo) {
  const read = p => JSON.parse(readFileSync(p, 'utf8'));
  const manifest = read(join(dir, 'manifest.json'));
  const summary = read(join(dir, 'summary.json'));
  const report = { runId: manifest.runId, checks: {} };
  report.checks.ledger = manifest.ledger ? verifyLedger(join(dir, 'events.jsonl'), manifest.ledger) : { ok: false, code: 'pre_ledger_bundle' };

  const scenario = read(resolve(repo, manifest.scenario.path));
  report.checks.scenarioIdentity = { ok: canonicalRecord(scenario).sha256 === manifest.scenario.sha256 };
  const faults = scenario.faults.filter(f => f.atMs < manifest.durationMs);
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
      const recordedContract = d.decision.admitted || CONTRACT_CODES.has(d.decision.code) ? (d.decision.admitted ? 'ok' : d.decision.code) : null;
      if (recordedContract === null) continue; // decided by preconditions or budgets, which need run state
      compared++;
      const replayed = contract.ok ? 'ok' : contract.code;
      if (replayed === recordedContract || (!contract.ok && !d.decision.admitted)) agreed++;
      else if (d.decision.admitted && contract.ok) agreed++;
      else disagreements.push({ proposalId: d.proposal.proposalId, recorded: recordedContract, replayed });
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
