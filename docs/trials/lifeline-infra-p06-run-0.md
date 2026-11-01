# LIFELINE Infra P06 Run 0 — Electrical adapter and trusted measurements

**Date:** November 1, 2026. **Task:** P06. **State:** qualified for steady-state electrical behavior, private service accounting and restart/fork. No transient stability, protection coordination, black start or switching-safety claim is made.

| Item | Value |
| --- | --- |
| Environment | `.work/environments/infra` (CPython 3.9.6, pandapower 3.2.2, numpy 2.0.2, scipy 1.13.1, pandas 2.3.3); pinned in `runtime/infra/requirements.lock`; pip cache on the SSD (`.work/cache/pip`); none written to the internal pip cache |
| Worker | `runtime/infra/power_pandapower.py` (plant + stdio worker), `protocol.py`, `checkpoints.py`, `power_spike.py` |
| Adapter | `src/lifeline/domains/power.mjs`, `src/lifeline/kernel/stdio-worker.mjs`; contract metric `power.switch_state` (unit `state`) added |
| Fixtures | `fixtures/lifeline/infra/power/analytic.json` (feeder with tie and islanded clinic microgrid; two-bus closed-form case), `fixtures/lifeline/infra/power/reference.json` (CIGRE MV with DER) |
| Evidence | `artifacts/lifeline/infra/p06-run-0/spike.json`, `artifacts/lifeline/infra/p06-run-0/reference/{summary,trace,measurements,independent-resolve,service-cases.private}.json` |

## RED → GREEN

The plant was first written with the three required behaviors absent: supply equal to the commanded setpoint, the last solution kept when the solver failed, and commands accepted without a revision check.

```text
test_power.py  RED 8 failures + 1 error of 21:
  disconnected hospital: deficit 0.0 != 20,000,000 J; islanded/unavailable-generation loads reported 400,000/150,000 W
  nonconverged two-bus: 'converged' != 'no_feasible_operating_point'
  stale switch command: Rejected not raised; worker stale receipt 'success' != 'rejected'
  restore: checkpoint_corrupt (defect: seal() kept a live reference, so later mutation broke the hash)
→ GREEN after supply = solved result on an energized bus, classify_solve(), revision check, seal() copy;
  one further defect fixed (preview window read the fork's advanced clock).
Fixture leak RED → GREEN: with the scenario block left in the plant spec, the admitted model contained
  'trip-2-3'; the plant now drops `scenario` from the spec (test fails without the fix, passes with it).
python -m unittest discover -s runtime/infra/tests        28 tests OK (25 power + 3 scoring)
node --test test/lifeline/infra/power-adapter.test.mjs    7/7 (first run; mutation checks below)
npm test                                                   333 pass
```

Node mutation checks: forcing `baseRevision: 1` fails the stale-action test; adding 5 J to the Node scorer fails the cross-check test.

## Physics and accounting checks

| Check | Result |
| --- | --- |
| Two-bus closed form (12.47 kV, 3+4j Ω, 2 MW + 0.4 Mvar) | receiving voltage and I²R losses within 1e-6 relative |
| AC balance (feeder, storage discharging 50 kW) | sources + generators + storage = loads + line losses within 1 W; diesel supplies exactly 100 kW |
| Thermal limit | housing ×2.5 loads L3 above 100% → `thermal_limit` event; no voltage event on the stiff feeder |
| Voltage limit | two-bus ×3 converges at 0.804 pu → `voltage_limit` event |
| Infeasible vs numerical | two-bus ×6 has no real solution → `no_feasible_operating_point` with loadability bracket; classifier unit test separates it from `solver_failure` (no convergence at zero load) |
| Nonconverged service | samples are `null`; score `capture_incomplete`; sensor value `null` with `solution_unavailable` |
| Islanded / unavailable generation | open feeder or diesel loss → supplied 0 W, deficit integrates; tie closure restores |
| Shedding | a shed load keeps its demand; deficit counts |
| Storage | 1 MJ at 100 kW stops at exactly 0 J after 10 s; delivered energy equals stored energy drop within 1 J |
| Envelope | load scale outside [0, 8] refused (`outside_model_envelope`); clock regression, unknown actuator, over-limit storage and unknown action refused |
| Reference drift | built CIGRE tables must hash to the fixture's recorded SHA-256 (`f742f489…`); a changed hash is refused |

## Capability spike (median / p95 ms, 15 repetitions, Apple Silicon host)

| Operation | Feeder | CIGRE MV |
| --- | --- | --- |
| initialize (build network) | 133 / 148 | 219 / 231 |
| solve | 7.1 / 8.2 | 10.5 / 11.7 |
| change + solve | 7.1 / 7.2 | 10.5 / 10.6 |
| checkpoint / restore | 0.39 / 0.43 | 1.36 / 1.36 |
| fork (rebuild from checkpoint) | 67 / 82 | 111 / 125 |
| preview, 60 s horizon | 74 / 87 | 122 / 135 |
| advance 60 steps (re-solve only on change) | 24 total | 22 total |
| checkpoint size | 17.8 KB | 59.7 KB |

State inventory in every checkpoint: spec, model version, clock, revision, step, switches, line/source/generator service, load connection and scale, storage energy and command, local-control memory (empty until P07), pending faults, applied faults, ledger, receipts.

Repeatability (uninterrupted vs checkpoint→diverge→restore vs fork): identical sample times, maximum load difference 0 W and essential-unserved difference 0 J on both networks (tolerances 0.001 W, 1 J). The negative control, which diverges without restoring, differs by 400 kW / 8 MJ (feeder) and 727.5 kW / 26.3 MJ (CIGRE), so the comparison can detect a failed restore.

Preview isolation: preview forks the admitted model (current configuration, no fault schedule, ledger or receipts), returns a forecast record, never a receipt, and leaves the live checkpoint hash unchanged. A true-plant checkpoint is refused as a model (`model_not_admitted`). The Node adapter holds only checkpoint/model handles and hashes.

## Reference-network run

CIGRE TB 575 European MV benchmark (`pandapower.networks.create_cigre_network_mv(with_der='all')`). Scenario assumptions are recorded in the fixture: CI3, CI7 and CI9 are essential, battery capacities, 0.90–1.10 pu band, 120 s manual tie delay. Driven through the Node adapter and the worker (`node scripts/lifeline-power-reference.mjs`, 1.25 s wall time).

| Quantity | Value | Hand check |
| --- | --- | --- |
| Line 2-3 trip at 60 s | buses 3–11 de-energized | — |
| Conventional tie S1 closed at 180 s (receipt `success`, revision 1 → 2) | essential loads restored; bus 9 at 0.943 pu; line 14-8 at 38% | — |
| Essential demand (600 s) | 525.3 MJ | 0.8755 MW × 600 s |
| Essential unserved | 105.06 MJ | 0.8755 MW × 120 s |
| Essential served fraction | 0.800 | 480 / 600 s |
| Recovery (≥99% for 30 s) | 120 s for CI3, CI7, CI9 | — |
| Preview at 180 s: tie closure / do nothing, 60 s | 0 J / 52.53 MJ | 0.8755 MW × 60 s |
| Python vs Node scorers | agree (cross-check tolerance 1 J) | — |
| Independent raw-pandapower re-solve of end and post-trip states | voltages and loading identical (0 V difference); same de-energized buses | — |

## Limits and not claimed

- Steady-state AC power flow at discrete steps. Transient stability, protection coordination, black start and safe physical switching are not modeled. Grid2Op is a separate P07 profile.
- An island without an ext_grid or slack generator is unsupplied. Storage is grid-following and lossless.
- Slack-generator capacity is reported as a `generator_limit` event, not enforced by the solver.
- The infeasible/numerical split uses the declared evaluator rule (continuation over uniform load scale). It does not prove that no operating point exists.
- The infrastructure environment is on the host. The clean-room VM does not install pandapower yet, so the Node adapter tests skip there with a stated reason until the guest environment is provisioned.
