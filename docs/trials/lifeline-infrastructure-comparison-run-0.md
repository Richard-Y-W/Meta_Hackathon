# LIFELINE P18 run 0: held-out comparison (research-v1)

**Date:** November 3, 2026. **Task:** P18. **State:** complete. The gate is a complete, interpretable comparison, and statistical success is not required.

**Result:** The study is negative for the Meta-assisted claims.
- **B2 (Meta adds useful coordination):** not supported. It is contradicted against independent control and inconclusive against coordinated conventional control (hybrid), with a negative point estimate.
- **B5 (benefit survives disturbance):** contradicted.
- **B1 (forecast-guided action prevents loss):** an exploratory positive signal from one group, which cannot qualify the claim.
- **Model participation:** the Meta model changed no decision in any episode.

| Item | Detail |
| --- | --- |
| Protocol | [`protocol-research-v1.json`](../../fixtures/lifeline/infra/protocol-research-v1.json), frozen at `cc9fe67` (suite `0069cd54…`); [dataset card](../research/lifeline-infrastructure-dataset-card.md) |
| Code | `scripts/lifeline-infra-evaluate.mjs`, `runtime/infra/analysis.py` (+ `tests/test_analysis.py`, 14 tests); committed in `55a3ccf` before any held-out outcome |
| Run | `node --env-file-if-exists=.env scripts/lifeline-infra-evaluate.mjs --out artifacts/lifeline/infra/research-v1`, then `--controllers oracle --out …/research-v1-oracle`; `python3 runtime/infra/analysis.py fixtures/lifeline/infra/protocol-research-v1.json artifacts/lifeline/infra/research-v1/rows.json` |
| Evidence | `artifacts/lifeline/infra/research-v1/{rows.json,analysis.json}`, `research-v1-oracle/rows.json`, logs, `p18/mutation-evidence.txt` |
| Execution | 48 of 48 declared first attempts completed. There were no infrastructure-invalid runs and no reruns. Episodes ran one at a time on a quiet host (about 1.9 h), and the oracle ran afterward (about 1.6 h). |
| Provider | 17 calls (cap 96): 16 answered and 1 timed out. Of the answers, 11 parsed; 4 were rejected for invalid units and 1 for citing unknown evidence. Tokens: 38,309 input and 42,063 output. Call time was 15.0–27.4 s (median 22.4 s). 146 decisions skipped the call because there was no incident or no predicted loss, and 3 because the call budget was used up. The credential appears in 0 retained files. |

## TDD evidence

The analysis tests were written first and failed because the module did not exist (an import error, not a behavioral failure). Behavioral RED is therefore shown by mutation: five mutations, all caught (one only after a test was added).
- Resampling groups instead of families.
- Ignoring service regressions in the classification.
- Silently dropping a missing pair.
- Counting an infrastructure-invalid attempt as valid. This one first survived and is caught after adding the "invalid attempt without a rerun" test.
- Not counting timeouts.

## Per-group service score S (%)

| Group | Independent | Hybrid | Meta-assisted | Oracle (headroom) |
| --- | --- | --- | --- | --- |
| B stable | 100.00 | 100.00 | 100.00 | 100.00 |
| B developing threat | 98.55 | **100.00** | 98.55 | 100.00 |
| B abrupt | 98.46 | 98.46 | 98.46 | 100.00 |
| B compound | 98.81 | 98.81 | 98.81 | 99.06 |
| B delayed dependency | 87.54 | 87.54 | **79.40** | 100.00 |
| B partial observation | 99.40 | 99.40 | 99.40 | 100.00 |
| B false alarm | 100.00 | 100.00 | 100.00 | 100.00 |
| B impossible recovery | 71.36 | 67.97 | 70.91 | 66.95 |
| C abrupt | 100.00 | 100.00 | 100.00 | 100.00 |
| C compound | 100.00 | 100.00 | 100.00 | 100.00 |
| C delayed dependency | 100.00 | 99.64 | 100.00 | 100.00 |
| C partial observation | 100.00 | 100.00 | 100.00 | 100.00 |
| C false alarm | 100.00 | 100.00 | 100.00 | 100.00 |
| C no useful coupling | 100.00 | 100.00 | 100.00 | 100.00 |
| C common cause | 100.00 | 97.94 | 99.51 | 100.00 |
| C developing threat | 100.00 | 100.00 | 100.00 | 100.00 |

**About the oracle.** The oracle knows the true future faults and has no latency. It optimizes the frozen lexicographic service order: essential water, then essential power, then non-essential water. In the impossible-recovery group it therefore protects hospital and fire water by shedding residential water, and scores below independent control on S. It is a ceiling for the service order, not for S.

## Pre-specified comparisons

The 95% intervals are family-cluster percentile bootstraps (5,000 replicates, seed 20261103). D is the per-service deficit fraction; a positive regression means the method's D is higher.

| Comparison | Groups | Mean ΔS (pp) | 95% interval | Relative essential-deficit reduction | Mean regression in D (pp) JH / JF / power / JR | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| B2: Meta vs independent | 16 | −0.57 | [−1.64, 0.00] | −12.6% | +0.58 / +0.58 / 0.00 / +3.34 | **contradicted**: the upper bound is below the 0.5 pp margin |
| B2: Meta vs hybrid | 16 | −0.30 | [−1.37, +0.64] | −20.8% | +0.74 / +0.74 / +0.29 / −4.13 | **inconclusive** |
| B5: per critical group, Meta vs hybrid | 16 | JH and JF −0.74, power −0.29 | lower bounds JH/JF −2.22, power −0.87 | — | — | **contradicted**: the lower bound is below −0.5 pp |
| B1: hybrid vs independent, developing threat | 2 (1 family) | +0.73 | [+0.73, +0.73] (one cluster) | 100% | 0 / 0 / −2.32 / 0 | **exploratory signal only** (see below) |
| Coordination: hybrid vs independent (reported, not a claim test) | 16 | −0.27 | [−0.93, +0.14] | +6.8% | −0.16 / −0.16 / −0.29 / +7.47 | margin excluded |

B2 requires a qualifying benefit against **each** comparator, so B2 is **not supported**. Within this scope, the evidence is against it.

**Definitions fixed before outcomes.** The verdict boundaries were set in `analysis.py` before any outcome (commit `55a3ccf`):
- **Contradicted:** the interval's upper bound is below the practical margin.
- **Incomplete:** a declared pair is missing.

**B1 classification.** The rule mechanically passes, but the protocol froze B1 as "at most exploratory" with two anticipatory groups. Both groups are in one family, so the cluster interval is degenerate.
- **The positive group (B developing threat).** The advisory was issued 45 min before the trip. Hybrid's planner closed tie S3 at minute 41, 22 min before the trip at minute 63, and avoided 585 MJ of essential power loss. The warning preceded the loss by more than the execution time.
- **The other group (C).** There was nothing to prevent, under any controller.

B1 stays unproven.

## What happened

**1. The Meta model never changed a decision.** None of the 16 answered calls (and none of the 11 parsed answers) altered the chosen plan; participation is 0 of 17.
- Its own proposals were dominated in the ranking. In B delayed-dependency it proposed starting PU2, which was under maintenance, and shedding zone PZ.
- Four answers were rejected for units and one for unknown evidence.

So every service difference between Meta-assisted control and hybrid comes from **timing**:
- **B developing threat.** Both chose to close S3. Hybrid's decision took 22 s of wall time, charged as 23 min, so its action was available at minute 41. Meta's took 63 s (a 26.6 s call plus search), charged as 64 min, so its action was available at minute 84. The trip at minute 63 changed the grid and expired the pending step, and 585 MJ was lost.
- **B delayed dependency.** Both followed the same pause-then-resume plan. Meta's decisions were charged 71 and 47 min, so the pause came at minute 159 instead of 112 and the resume step expired. The tank reached its minimum, and the hospital and fire station lost 10.2 m³.
- **B impossible recovery and C common cause.** Meta scores above hybrid here, but only on non-essential residential water, and again from different decision timing.

P19 tests this attribution directly with a matched-latency variant.

**2. Coordination by itself is not a net gain on this suite.**
- **Essential gains:** hybrid improves essential service in two groups: the anticipatory tie closure above, and 2.3 m³ of hospital and fire water in impossible recovery.
- **Non-essential costs:** it sheds residential water in three groups (144, 57 and 10 m³).

The weighted mean is −0.27 pp. This matches the P13–P16 finding that coordination removes essential loss in some cases at a non-essential cost.

**3. There is headroom, and no implementable controller used it.** With perfect foresight the oracle reaches zero essential deficit in B abrupt, B delayed dependency and B partial observation, and S 99.06 in B compound. In those groups every controller lost 241–5,026 MJ of essential power, plus 10.2 m³ of water for Meta. The remaining gap is foresight about abrupt faults, which no admitted observation provides.

**4. The suite was less discriminating than P17 stated.** In all 8 layout-C groups, no controller and not the oracle had any essential deficit. The C trips leave essential power unaffected, as noted before the freeze, and storage covers the pump outages. Those groups can only reveal non-essential differences and harm. The effective population for essential service is the 8 layout-B groups, 6 of which have headroom. This lowers the study's power below the frozen precision statement, which assumed 16 informative groups. The P17 run note carries a correction.

## Accounting (valid attempts)

| | Independent | Hybrid | Meta-assisted |
| --- | --- | --- | --- |
| Delivered / refused commands | 37 / 3 | 50 / 2 | 51 / 3 |
| Expired planned steps | 0 | 1 | 3 |
| Unrecovered at end | 1 (impossible recovery) | 1 (same) | 1 (same) |
| Generator fuel (MJ, all groups) | 480.0 | 302.4 | 457.1 |
| Planner decision charge (median / max, model minutes) | — | 13.5 / 85 | 16 / 79 |
| Provider calls / timeouts / parsed / participated | — | — | 17 / 1 / 11 / 0 |

No episode had a power constraint event (0 voltage or thermal event-seconds) or a generator overload. All 8 refusals were `actuator_unavailable` on a tie declared unavailable in the case. No stale command executed: steps pending at a world change expired.

## Decision

Under the request ("if this positive execute P23–P25"), this result is **not positive**: B2 is not supported, and B5 is contradicted. P23–P25 are therefore not started. P19–P22 continue as studies with their own outcomes, and P31 will release these results as measured.
