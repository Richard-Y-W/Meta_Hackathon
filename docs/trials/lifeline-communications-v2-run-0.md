# LIFELINE Communications v2 Run 0 — Repaired Meta controller, frozen protocol revision 2

**Date:** November 1, 2026. **Task:** P02. **State:** qualified as a trustworthy exploratory comparison with an explicit outcome. **The repair removes the V1 regression. The model's added value is not shown.**

| Item | Value |
| --- | --- |
| Protocol | `fixtures/lifeline/protocol-v2.json`, revision 2, SHA-256 `47de7ea1…`, frozen at `718f3a9` before any v2 run (base `2208c10`); run code `cb119c8` (adds only the guest preflight batch/scratch split) |
| Cases | 7 fresh v2 cases (`fixtures/lifeline/v2/`): no fault, gray then capacity, outage then silent loss, capacity then outage, stale data, unrecoverable, timeout control; V1 cases remain seen development data |
| Arms | adaptive, priority, meta (repaired; live `muse-spark-1.3`, medium effort), meta-disabled (same controller, provider forced to time out) |
| Design | 2 repetitions, randomized arm order per block (seed 20261102), paired workloads, same receipt scorer as V1 |
| Platform | Lima `lifeline` guest (Ubuntu 24.04, Mininet 2.3.0, OVS 3.3.9), SSD-backed disk |
| Evidence | `artifacts/lifeline/guest/communications-v2/` (`comparison.{md,json}`, `index.jsonl`, `schedule.json`, 60 bundles; 1.5 GB); key scan of the copied evidence found no credential |

## Validity

- 60 attempts: 56 scheduled first attempts, 1 infrastructure-invalid, and a 4-episode paired rerun of that block (`.a2`, all valid). The audit (protocol identity, arm identity, first attempts present, fixed denominators) is `ok` with no problems.
- **Invalid episode:** `v2-f-unrecoverable.r1.meta`, replay `linkage` failure. The model proposed two `probe_path` actions with no explicit path (default-route probes). The guard admitted them and the executor confirmed them. Then the adaptive controller's `applied()` hook called `path.join()` on the missing path and threw, so no execution record was written. The frozen rule classifies this as infrastructure-invalid; the whole block was rerun. The defect was fixed after the run (`src/lifeline/controllers/adaptive.mjs`), with a RED → GREEN regression test in `test/lifeline/controllers.test.mjs`. The v2 numbers come from the code as frozen; future runs with the fix need a new protocol identity.
- Scheduling: per-episode local-control lag p95 ≤ 5.81 ms (maximum over episodes) and single-tick maximum 48.9 ms. This input froze the P04 budget.

## Results (on-time delivery %, mean of 2 repetitions)

| Case | adaptive | priority | meta | meta-disabled |
| --- | --- | --- | --- | --- |
| no fault | 100.00 | 100.00 | 100.00 | 100.00 |
| gray then capacity | 99.90 | 98.03 | 99.92 | 99.90 |
| outage then silent loss | 99.85 | 99.94 | 99.83 | 99.83 |
| capacity then outage | 100.00 | 55.77 | 100.00 | 100.00 |
| stale data | 100.00 | 99.94 | 100.00 | 100.00 |
| unrecoverable (control) | 63.34 | 63.34 | 63.34 | 63.34 |
| timeout control | 99.85 | 99.94 | 99.85 | 99.83 |

| Pair over 5 recoverable failure cases | Mean (pp) | 95% bootstrap over cases (pp) | Worst case (pp) |
| --- | --- | --- | --- |
| meta − adaptive | −0.003 | −0.018 to +0.010 | −0.03 |
| meta − meta-disabled | +0.005 | −0.003 to +0.015 | −0.01 |
| meta-disabled − adaptive | −0.008 | −0.015 to −0.0004 | −0.02 |
| adaptive − priority | +9.20 | −0.03 to +26.89 | −0.09 |

Cost: meta made 33 model calls, of which 18 failed (`provider_timeout`), for 441 s of model time and 41,090 output tokens. 7 completed answers were discarded as `configuration_changed` and 5 as `run_stopped`. Meta's 46 interventions compare with adaptive's 44; probe bytes were 468 kB against 416 kB. Spend stayed inside the frozen budget (56 episodes, ≤ 144 calls).

## Frozen decision rules applied

| Rule | Criterion | Measured | Outcome |
| --- | --- | --- | --- |
| Repair removes the regression | mean meta − adaptive ≥ −0.5 pp and no case below −2 pp | −0.003 pp; worst −0.03 pp | **met** (V1 was −1.35 pp) |
| AI adds value | 95% interval of meta − meta-disabled entirely above 0 | −0.003 to +0.015 pp | **not met** |

**Interpretation.**

- The P01 repair works: conventional recovery now runs in parallel with the investigation, so the model's 12–18 s latency no longer costs service.
- The model adds nothing measurable here, and the headroom is small. Adaptive already reaches 99.85–100% on every recoverable case, leaving at most 0.15 pp to win.
- meta-disabled sits slightly below adaptive (−0.008 pp; the interval excludes zero but is practically negligible). This is consistent with the disabled investigation path adding a little execution churn.
- More than half of live model calls hit the 18 s per-call limit.

Per the plan, work moves to power/water without an AI benefit. Communications headroom for a future AI claim needs harder cases on which adaptive itself falls short.

## Limits

Exploratory: 5 recoverable cases × 2 repetitions. Intervals are over cases, not packets. The cases are fresh but development-scale; they are not a held-out evaluation suite.
