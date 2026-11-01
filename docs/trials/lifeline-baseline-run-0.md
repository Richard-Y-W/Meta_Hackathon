# LIFELINE Baseline Run 0

**Run IDs:** `artifacts/lifeline/guest/baseline-run-0/*` (9 runs, each with its `manifest.json` run ID). **Date:** October 31, 2026. **Task:** 7, conventional controllers before the AI.

**Result:** Qualified, and G1 qualified. Both conventional controllers react to real faults through the shared guard and executor, preserve essential traffic where a path exists, take no action without a fault, report partitions as unavailable, and do not act on stale telemetry. On the development cascade the adaptive supervisor delivered every essential message on time. That leaves no headroom for an AI improvement on this scenario.

## Identity

| Item | Value |
| --- | --- |
| Code | `f465d5f`, clean tree for all 9 runs of record |
| Policy | `policy-v1.json`, `f7baa4fa…dd25` |
| Controllers | `fixed` (reference routes, fast-failover), `priority` (`src/lifeline/controllers/priority.mjs`), `adaptive` (`src/lifeline/controllers/adaptive.mjs`) |
| Shared boundary | Same observations, inventory, guard, executor, budgets and probe operation for both adaptive methods |
| Development runs | `artifacts/lifeline/guest/dev-controllers/` on the pre-fix code; superseded, retained |

## Controller configuration (tuning history)

| Setting | Value | Reason |
| --- | --- | --- |
| On-time target, degradation persistence | 0.95, two consecutive samples (priority); same-plan-twice (adaptive) | Hysteresis against one noisy sample |
| Hold-off after a confirmed change | 5 s per flow or source | Oscillation control |
| Hold-off after a rejected proposal | 2 s (run loop) | Every attempt is charged; a persistent rejection must not drain the budget |
| Candidate paths | At most 3 simple paths over links observed up, ordered by hops then lexicographically | Plan limit; deterministic ties |
| Background rate grid | Scheduled, 1/2, 1/4, policy minimum, current | Plan limit |
| Adaptive objective | Priority-weighted feasible flows; background kept; lowest peak essential-path utilization; fewest changes; candidate order | Standard traffic-engineering ranking |
| Utilization limit | 0.95 of planning capacity | At 0.9 the healthy no-fault network would already count as overloaded (r1>r2 7.41 of 8 Mbit/s) |
| Capacity belief | Saturated (backlog > 20 KB or drops): ≈ measured throughput; carried load ≥ 10% of nominal: lower bound; otherwise unmeasured | An idle link reporting 0 bit/s is not capacity evidence |
| Probe before a non-outage move | 16 × 1,000 B at 10 ms on the target path if any link is unmeasured | Bounded active measurement |
| Inventory | Topology, nominal link ratings, declared workload, reference routes; identical for every controller | Operators know their equipment; impaired capacity stays hidden |

Changes made during development, each found in a test or run: headroom alone no longer triggers a change (no-fault regression in tests). An idle link no longer counts as measured (cascade run skipped its probe). The on-time fraction now uses the sender's resolved counters: priority shed background after traffic ended because acknowledgements and offered messages were mis-paired at the boundary. Priority no longer sheds for flows with no path.

## Unit qualification

```text
node --test test/lifeline/controllers.test.mjs   → 23 pass (RED 14/18 on stubs)
npm test                                         → 166 pass
python3 -m unittest … test_*.py (host)           → all pass, 2 integration skipped with reason
```

`fixtures/lifeline/development/controller-oracles.json` holds hand calculations for the outage, overload and double-outage cases. Four of my hand calculations were wrong and the tests caught them: I enumerated candidates over the full topology instead of up links; I missed bulk-field's failover load on r1>r0; and I treated a two-change minimum-peak plan as one change. The fixture now records each corrected derivation. A separately written exhaustive search over the same candidates and objective matches the adaptive planner's essential and background scores on four known-capacity instances.

## Packet results (runs of record)

| Scenario (duration) | Controller | Offered | On time | Late | Lost | On-time rate | Decisions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cascade (120 s) | fixed | 24,000 | 15,148 | 2,767 | 6,085 | 0.631 | none |
| Cascade (120 s) | priority | 24,000 | 23,963 | 20 | 17 | 0.9985 | 49.5 s: bulk-field → 0.5 Mbit/s |
| Cascade (120 s) | adaptive | 24,000 | 24,000 | 0 | 0 | 1.000 | 20.5 s, 23.0 s: probes; 25.0 s: both clinic flows → r1-r4-r3 paths |
| No-fault (60 s) | priority | 9,600 | 9,600 | 0 | 0 | 1.000 | none |
| No-fault (60 s) | adaptive | 9,600 | 9,600 | 0 | 0 | 1.000 | none |
| Partition (60 s) | priority | 9,600 | 3,201 | 0 | 6,399 | 0.333 | none; clinic flows reported unavailable at 20.0 s |
| Partition (60 s) | adaptive | 9,600 | 3,201 | 0 | 6,399 | 0.333 | none; same report |
| Stale telemetry (60 s) | priority | 9,720 | 9,701 | 11 | 8 | 0.998 | none during the 19.5–25.5 s hold; 48.5 s shed |
| Stale telemetry (60 s) | adaptive | 9,720 | 9,720 | 0 | 0 | 1.000 | none during the hold; 26.5 s and 29.0 s probes; 31.0 s move |

Primary windows run from the first incident (or 20 s) to the horizon. All 9 runs: controller-view audit clean, teardown clean, every admitted action confirmed. Background delivered fraction in the cascade: bulk-field 0.632 (fixed), 0.341 (priority), 0.695 (adaptive). Bulk-shelter is blackholed in all three runs by the reference route weakness recorded in packet run 0; no controller may reroute background under the V1 action contract. The fixed cascade reproduces packet runs 0–2 (0.630–0.631).

## What this supports

G1: receipt-based scoring of real packets, a causal cascade, and a competent conventional baseline that reacts, wins the easy cases and passes the no-fault, partition and stale-telemetry controls.

## What it implies for the AI comparison

The adaptive supervisor is at the ceiling on `dev-cascade-1`, so this case cannot show an AI improvement in essential delivery. Per the plan's risk table ("strong baseline matches or wins"), the comparison suite for Task 11 needs development cases where conventional measurement-driven control is misled or slow. Candidates: a capacity loss on the path the baseline just moved to; impairments that appear as loss without backlog; or competing explanations a probe must discriminate. They must be chosen before any AI results are seen. This is an owner decision for the protocol.

## Remaining limits

- One run per cell; no variance estimate.
- The cascade fixture rates are development settings.
- Background rerouting is outside the V1 action contract for every controller.

**Next:** Task 8 (beliefs and forecast qualification). Task 9 needs `MODEL_API_KEY`.
