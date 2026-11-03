# LIFELINE Infra P12 Runs 0–1 — Joint plans and resource-aware intervention search

**Date:** November 1, 2026. **Task:** P12. **State:** qualified on the development town. No AI is involved; this is the shared planner that conventional and Meta candidates will both go through.

| Item | Value |
| --- | --- |
| Code | `src/lifeline/kernel/plans.mjs` (`validateTimedPlan`), `src/lifeline/kernel/planner.mjs` (templates, robust evaluation, joint feasibility, bounded search, timed execution), `src/lifeline/domains/town.mjs` (town worker client); town additions in `runtime/infra/coupling.py`: a shared portable generator (capacity, fuel, setup time, overload trip), the remote `set_station_mode` demand shift, the admitted model, timed multi-domain previews and a world revision; a `line_restore` world event in the power plant; worker `admitted_model`, `preview`, `state` |
| Fixtures | `fixtures/lifeline/infra/town/plan-controls.json` (3 cases; two restoration-ETA scenarios); generator in `town/development.json` (25 kW; 120 MJ of fuel at 3 J per electrical J; 10 min setup) |
| Evidence | `artifacts/lifeline/infra/p12-run-0/planner.json` (superseded), `artifacts/lifeline/infra/p12-run-1/planner.json` |
| Changed elsewhere | The Python reference scorer now indexes supply and demand by time (it re-sorted the series on every lookup: one 4 h town preview took 18.9 s, now 0.65 s, with an identical result). Every Python suite passes in both environments, and the Node scorer agrees |

## What a joint plan is

A plan is a set of timed steps on the coupling grid. Each step has a domain action, a duration, dependencies, declared resource use (allocate or release), preconditions (`supply_available`, provided by a named step) and an optional deadline.

Static validation refuses:

- dependency cycles;
- off-grid steps and late commands (before now, or with an effect after the deadline);
- double allocation of a resource (also against current allocations);
- steps that need a supply before the step providing it completes.

Joint feasibility is judged by simulation: a plan whose steps overload the generator together, but not one at a time, is `jointly_infeasible`.

Candidates come from bounded templates over the catalog and the observed state: retain, probe-only (a no-op here, since the town has no probe capability), tie closures, the generator, generator plus a 1 h or 2 h demand shift, resuming a paused station, and a pause without re-allocation.

Each candidate is simulated from the admitted estimated state under every declared restoration scenario. Ranking uses the frozen order on the **worst** scenario — essential water unmet, essential power unserved, constraint time, fuel used — and then the mean fuel over scenarios, then action cost. A search past its candidate or wall-time budget returns its best evaluated plan, or retains policy.

## RED → GREEN

The planner was written before its tests, so test power comes from mutations:

- removing the double-allocation, supply-precondition or late-command check fails its test;
- the joint-feasibility mutation was first undetected (the test checked only the code, not `ok: false`); after strengthening, it failed.

```text
planner.test.mjs 8/8 (5 unit, 3 against the live town worker); npm test pass; Python suites pass in the town and infra environments
```

## Results (run 1; decision at 1,860 s, after the storm trips line 3-8 and disables both ties; PU2 in maintenance)

| Case (only the starting storage differs) | Observed tank | Chosen plan | Why (worst scenario, then mean fuel) |
| --- | --- | --- | --- |
| high storage | 4.12 m | generator + pause the station 1 h | 0 m3 essential unmet in both ETAs. The plain generator plan also reaches 0 m3 in the worst (late) ETA with all 120 MJ used; the pause uses 113.5 MJ in the nominal ETA (mean 116.7 MJ), keeping part of the reserve |
| lower storage | 3.61 m | generator, no pause | the same pause leaves 2.52 m3 essential unmet; the plain generator plan leaves 0.36 m3 in the late ETA |
| second fault (line 2-3 trips at 3,600 s) | 4.12 m | generator + pause 1 h, executed | generator and pause delivered; at 3,600 s the outside change expired the pending resume; the generator stayed allocated (no invented rollback); the replan from actual state chose `resume-station` (27.5 m3 unmet against 72.7 m3 for retaining) |

Doing nothing loses 42.5–45.7 m3 of essential water in these cases. The planner chose differently from the observed tank level, not from the case name; the templates are identical. Each decision evaluated 7 candidates × 2 scenarios in about 20 s.

## Run 0 → run 1

- Run 0 ranked on the worst scenario only, and so chose the plain generator plan for high storage: the pause saves fuel only when restoration is on time. The mean-fuel tie-break was added.
- Run 0's replan after the second fault chose to retain policy, leaving the station paused. The templates did not see the paused setting, and the generator templates were correctly refused as double allocations. Templates now take the observed state. Both behaviors are covered by tests.

## Correction found in P13 (same day)

The P12 template space listed only ties S1 and S3, both disabled by the storm. Tie S2 (line 6-7) was physically available in all three plan-control cases. Closing it restores the de-energized buses without the generator: the independent comparator did exactly that in P13 run 0. The P12 tradeoff results therefore hold **only within that restricted template space**. They show that the planner chooses between demand shift and plain generator use from observed storage. They do not show the best available action in those cases. The P13 catalog lists S2, and the P13 parity test now checks assets as well as command types.

## Limits

- The generator is the only shared resource, and its fuel use is a declared ratio.
- The ETA scenarios are declared assumptions.
- `coordinator.mjs` and `forecast.mjs` were not extended: timed execution and its expiry rule live in `planner.runTimedPlan`, and plan uncertainty uses scenario sets like P10's ensembles.
- The search is a bounded template enumeration, not an optimizer; P13 adds the rolling-horizon joint comparator and exhaustive checks.
