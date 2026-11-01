# LIFELINE Forecast Run 0

**Run IDs:** offline replay `artifacts/lifeline/forecast-run-0.json` (12 retained runs); integrated run `run-20261101060113-lfg2`. **Date:** November 1, 2026. **Task:** 8, beliefs and counterfactual prediction.

**Result:** Qualified, and G2 qualified. Beliefs are evidence-linked and refuse unsupported model updates. On the retained development runs the forecast's intervals contained the observed on-time fraction in 99.6% of 1,371 two-second windows. Its known limits are recorded: it cannot anticipate unannounced faults, it is uninformative near capacity, and it does not represent loss without backlog.

| Item | Value |
| --- | --- |
| Code | `b7c4a27` (clean) |
| Files | `src/lifeline/beliefs.mjs`, `src/lifeline/forecast.mjs`, `test/lifeline/{beliefs,forecast}.test.mjs`, `scripts/lifeline-forecast-check.mjs` |
| Forecast version | `forecast-v1` |

## Tests

```text
node --test test/lifeline/beliefs.test.mjs test/lifeline/forecast.test.mjs → 16 pass (RED 8/8 and 8/8 on stubs)
npm test → 182 pass (adaptive controller now uses the shared beliefs; its 23 tests unchanged)
```

Beliefs: nominal start interval with no evidence; saturation narrows the interval and cites `obs-<seq>`; missing measurements change nothing; a measurement above a saturation estimate is a recorded contradiction that reopens the interval, with old revisions retained; a down link is [0, 0] and restoration reopens it. Model-proposed updates must cite retained observations; unknown evidence (`evidence_unknown`) and measurements that do not support the value (`evidence_unsupported`) are refused. Conflicting evidence (lower bound above upper bound) yields `model_inconsistent`.

Forecast: per-link loads equal the hand-summed demands (r1>r2 = 682,240 + 6,727,500 bit/s; r3>r0 = 52,480 + 4,140,000) and total load is conserved; a link measured saturated at 2.95 Mbit/s predicts at most 10% on-time delivery for its flow; a route over a down link predicts [0, 0]; flows are reported in priority order; an inconsistent belief produces no forecast; the utilization-to-interval map is monotone; identical inputs have a stable forecast ID.

## Calibration against packet outcomes

Each retained run's controller view was replayed into beliefs every 2 s. The forecast for the routes and rates actually in effect (route changes from confirmed receipts) was compared with the receivers' on-time fraction for messages created in the next 2 s.

| Runs | Windows | Covered | Optimistic errors | Pessimistic errors |
| --- | --- | --- | --- | --- |
| Cascade: fixed (2 runs), priority, adaptive | 708 | 708 | 0 | 0 |
| No-fault ×2, stale telemetry ×2, transition | 402 | 402 | 0 | 0 |
| Partition ×3 | 261 | 255 | 6 | 0 |
| **All** | **1,371** | **1,365 (99.6%)** | **6** | **0** |

All 6 misses are the 18 s forecast for the 18–20 s window in the partition runs. Observed delivery was about 0.5 because the unannounced partition at 20 s caught messages already in flight. A forecast cannot anticipate a fault it has no evidence of.

The intervals carry little information near capacity. 160 windows (12%) were [0, 1]; most fall in the fixed and priority cascades at peak utilization 1.0–1.1, where the pessimistic and optimistic beliefs straddle the cliff. Mean interval width was 0.16.

## Tolerances set from this development evidence

- The forecast is advisory for conventional controllers and recorded with every decision (`decision.forecastId`, per-flow intervals, links assumed at nominal).
- An AI intervention requires forecast status `ok`. A `model_inconsistent` or unavailable forecast cannot become an AI action (Task 9).
- Predicted and observed intervals are retained for every intervention; a miss is a recorded outcome, not discarded.
- Interval map: peak utilization ≤ 0.95 → [0.95, 1]; ≤ 1.1 → [0.3, 1]; ≤ 1.5 → [0, 0.6]; above → [0, 0.1].

## Integrated run (G2)

`run-20261101060113-lfg2`: adaptive controller, cascade, clean `b7c4a27`. Two probes ran while the forecast for the current configuration was [0.3, 1] for both clinic flows. The two-route move was predicted at [0.95, 1] for every flow; all 24,000 messages arrived on time. Guard, executor, probes, budgets and forecast operated together, with an empty controller-view audit and clean teardown.

## What remains unqualified

- Loss without backlog: beliefs do not represent it (recorded in `ASSUMPTIONS`). The harder development cases test it.
- Calibration covers this topology and these development settings only.

**Next:** predeclare the revised development pilot, then Task 9.
