# LIFELINE Infra P10 Runs 0–1 — Forecast threats with lead time and calibrated uncertainty

**Date:** November 1, 2026. **Task:** P10. **State:** qualified as forecast plumbing with retained forecast-only evidence. One forecaster is **not** calibrated (power overload timing); no forecast has justified autonomous action, and B1 (matched prevention) is not tested here.

| Item | Value |
| --- | --- |
| Code | `src/lifeline/kernel/forecast.mjs` (records, information boundary, lead time, event and interval scoring, consequence ensembles, trend-crossing baseline), `src/lifeline/kernel/threat-inputs.mjs` (admission and reconciliation), `scripts/lifeline-infra-forecast-check.mjs` |
| Tests | `test/lifeline/infra/forecast.test.mjs` (9), `test/lifeline/infra/threat-inputs.test.mjs` (4) |
| Controls | `fixtures/lifeline/infra/forecast-controls.json`: 7 forecast-only controls on the qualified power (CIGRE MV) and water (town) plants |
| Evidence | `artifacts/lifeline/infra/forecast-run-0/` (superseded), `artifacts/lifeline/infra/forecast-run-1/` (`summary.json`, `forecasts.json`) |

## RED → GREEN

The kernel modules were written before their tests, so test power comes from mutations; each one fails the corresponding test:

| Mutation | Failing test |
| --- | --- |
| a forecast issued at or after the loss counts as a warning | the late-warning test |
| no hidden-fault scan | the information-boundary test |
| origin evidence from after the issue time accepted | the origin-time test |
| no injected-fault scan on threat inputs | the input-boundary test |

One test-arithmetic error was corrected (2 of 3 ensemble crossings fell inside a 150 s horizon).

## What a forecast is

A forecast is an `infra-contract-v1` forecast envelope with:

- origin observation IDs and their hash
- configuration revisions and model version
- horizon and issue time
- outcomes with explicit semantics: an `event` probability of a named threat within the horizon, plus a timing interval
- assumptions and validity range
- `supported`/`unsupported` status; unsupported needs a reason

Probabilities are ensemble fractions with declared members (slope ×0.8/1.0/1.25; demand ×0.8/1.0/1.25; hazard inputs weighted by their stated probability). They are not beliefs until scored.

Threat inputs need:

- a registered source authorized for the input type
- an issue time not in the future and within its maximum age
- known assets, valid conditions and windows
- no field or text naming an injected fault

Contradictory reports on the same asset are kept side by side as `contradictory`, never silently resolved.

## Forecast-only results (run 1; scored against later ledger and sensor observations)

| Control | Category | Loss at | First warning (lead) | Hits / false alarms / missed | Brier | Timing interval |
| --- | --- | --- | --- | --- | --- | --- |
| water tank depletion after pump loss | threat | 6,764 s | 3,300 s (3,464 s ahead) | 12 / 0 / 0 | 0.021 | coverage 1.0, mean width 816 s of a 3,600 s horizon: calibrated and sharp |
| water announced outage that never happens | false alarm | none | 2,700 s | 0 / 16 / 0 | 0.133 | — |
| water pressure-sensor anomaly | harmless anomaly | none | none | 0 / 0 / 0 | 0 | — |
| water forecast of an action on an unavailable pump | unsupported | none | — | 7 explicit `unsupported` | — | — |
| power overload progression (stepped load ramp) | threat | 690 s | 300 s (390 s ahead; loss beyond that forecast's 300 s horizon) | 9 / 2 / 1 | 0.101 | coverage 0.40, width 57 s: **not calibrated** (optimistic once) |
| power feeder trip without a precursor | no precursor | 60 s | none | — | — | — |
| site backup battery exhaustion (bess-1 at 300 kW) | threat | 510 s (first reading at 0) | 60 s (450 s ahead) | 15 / 0 / 0 | 0 | coverage 0.93, width 104 s of 600 s: calibrated and sharp |

Boundary checks: 0 violations across all forecasts. Forecasts issued after a loss are excluded from event scoring and counted separately. Two `unsupported` records per trend case come from the first samples (insufficient data).

**Interpretation.**

- The trend baseline gives long, well-timed warnings when the precursor is a smooth drain: tank level and battery energy.
- It is not calibrated for a stepped load ramp. A straight-line fit lags each step and was optimistic once.
- The consequence ensemble correctly warns on an announced outage. When the outage does not come, those warnings are false alarms by construction, and the stated 0.6 probability earns its Brier penalty.
- Without a precursor (an instantaneous trip) there is no warning, and none is claimed.
- A permanently wide interval would fail the sharpness rule (width ≤ 0.5 × horizon); the qualifying intervals are 23% and 17% of their horizons.

## Run 0 → run 1 changes (development controls, before any note)

- The false-alarm control used a 1 h horizon, inside which a full tank cannot empty, so it could not test a false alarm; the horizon is now 2 h.
- The overload forecaster ignored the declared 30 s protection delay between the 1.2 crossing and the loss. It is now added as a known relay setting, and coverage rose from 0.33 to 0.40.
- The first-warning lead is measured against the actual loss even when that loss lies beyond the issuing forecast's horizon.

## Limits

- Seven controls, one run each; calibration bins are sparse.
- The communications backup is a site battery modeled as a plant storage unit, not communications equipment.
- Hazard inputs and their modeled consequences are scenario-supplied.
- Action-enabled experiments are deliberately absent here; they come with B1 (P17+) and must keep forecast-only arms.
