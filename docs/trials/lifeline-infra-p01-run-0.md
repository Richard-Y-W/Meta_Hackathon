# LIFELINE Infra P01 Run 0 — Parallel investigation, clocks and expiry

**Date:** November 1, 2026. **Task:** P01. **State:** qualified (integration). This is not an improvement result.

**Result:** The V1 defects named in the plan are repaired and tested. The conventional layer keeps its full recovery behavior whatever the provider does. Investigations run on the episode clock under a 30 s total deadline that bounds every retry. Fallback holds start when the failure happens, and an answer about a world that has since changed is discarded. Live runs found and fixed two further defects: fractional timeouts made every bounded retry fail locally, and the adaptive layer spent its budget re-proposing a plan the guard had refused.

## Code

| Commit | Change |
| --- | --- |
| `1613f70` | `src/lifeline/investigation-clock.mjs` (new); `meta.mjs`: adaptive rule always on, investigations bound to configuration revision, incident and deadline, cancellation, completion-time holds, `stop()`; provider honors cancellation (`provider_cancelled`); run script passes the episode clock, per-call timeout and signal, and stops the controller at end of run |
| `1c2374e` | Whole-millisecond call timeouts; adaptive withholds a refused plan for 15 s (affects every adaptive-based controller: a baseline revision for v2 comparisons) |

## RED and GREEN

```text
investigation-clock.test.mjs  RED 3/3 on stub → GREEN 3/3; fractional-timeout case RED → GREEN (4 tests)
meta-controller.test.mjs      RED 9 (7 assertions; 2 missing stop()/signal) → GREEN 22/22
meta-provider.test.mjs        cancellation RED → GREEN; fractional timeout RED → GREEN (16 tests)
controllers.test.mjs          refused-plan hold RED → GREEN (26 tests)
npm test                      263 pass, 0 fail
```

Behavior under test (the plan's assertions):
- **Parity:** with the provider hanging, failing or answering, the Meta-assisted controller emits the adaptive controller's recovery action on the same tick.
- **Clocks:** start at 31,000 ms; a timeout at 49,000 starts a retry bounded to 12,000 ms; failure at 67,000 begins a 20,000 ms hold that ends at 87,000, not 69,000. A 30,000 ms deadline started at 31,000 expires at 61,000 with no further call.
- **Binding:** answers are discarded for a changed configuration revision, a new fault, an expired deadline or a stopped run. A superseded call is aborted and its late answer discarded.
- **Ordering:** a same-tick deterministic recovery goes first and the model plan waits.
- **Charging:** each attempt is charged exactly once, including failures.
- **Post-parse rejections** (progress bound, unsupported belief update, unusable forecast) now give up explicitly; before the repair they were silently ignored.

Older tests that assumed the model owned the unexplained-degradation role were updated to look past deterministic intents. Their assertions (evidence-cited model probe, no-change decisions spend nothing, the progress bound, unsupported belief updates) are unchanged.

## Live runs (seen V1 cases; single runs; development evidence only)

Provider configuration and prompt are unchanged from V1 (`lifeline-investigator-v1`, medium effort, 6,000 tokens, 18 s per call, 30 s per decision), so behavior changes come from the controller.

| Run | Code | Controller / provider | On time | Notes |
| --- | --- | --- | --- | --- |
| `p01-run-0/p5-…-real` | `1613f70` | meta / real | 0.9675 | Deterministic recovery 66–74 s, the same times as adaptive. The retry after an 18 s timeout failed in 0.0 s (defect A). From 76.5 s the adaptive layer re-proposed one refused plan until all 12 bundles were spent (defect B); a model answer was discarded as `configuration_changed` |
| `p01-run-0/p5-…-invalid` | `1613f70` | meta / HTTP 401 | 0.9724 | Identical recovery sequence to adaptive |
| `p01-run-0/p6-gray-failure-real` | `1613f70` | meta / real | 0.9936 | V1 meta 0.9846; adaptive (pilot) 0.9934 |
| `p01-run-1/p5-adaptive-real` | `1c2374e` | adaptive | 0.9673 | Current baseline, with the refused-plan hold; 4 refusals |
| `p01-run-1/p5-meta-real` | `1c2374e` | meta / real | 0.9742 | Calls: timeout 18.0 s, then retries answered in 6.2, 15.1 and 15.6 s; 2 answers discarded as `configuration_changed`; 1 model probe executed |
| `p01-run-1/p5-meta-invalid` | `1c2374e` | meta / HTTP 401 | 0.9742 | Exactly the same count as the real-provider run (23,381/24,000) |

For reference, V1 pilot p5: meta 0.9000 (0.935, 0.865), adaptive 0.9724.

Interpretation, kept to what the runs show:
- The repair removes the V1 mechanism of loss: the meta controller's p5 recovery no longer waits on the model.
- On p5 the model contributed nothing measurable: the real-provider and failed-provider runs scored identically.
- The 0.7 pp between `p5-meta` and `p5-adaptive` in run 1 comes from single runs with no model contribution. It reflects run variation or wrapper behavior, not AI benefit. P02 measures with repetitions.

All runs: controller-view audit clean; API key absent from artifacts.

## Remaining limits

- The refused-plan hold changes the conventional baseline; v2 comparisons must use the revised baseline for both arms.
- The 15 s hold is a development setting.
