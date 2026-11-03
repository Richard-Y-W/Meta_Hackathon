# LIFELINE Infra P13 Runs 0–7 — Strong coordinated conventional comparator

**Date:** November 1–2, 2026. **Task:** P13. **State:** qualified. The locked comparator is **`hybrid`** (revision 2 since P14): the coordinated rules running in parallel with the rolling-horizon joint optimizer. Development cases only.

| Item | Value |
| --- | --- |
| Code | `src/lifeline/controllers/joint.mjs` (independent, priority, rolling, hybrid, oracle; layered episode runner with charged decision latency; exhaustive schedule check), `runtime/infra/baselines.py` (in-process perfect-information search scored by the evaluator's ledgers), `scripts/lifeline-town-baselines.mjs`. Town: capability listing, station mains alarm, previews skip steps beyond their horizon, delayed-resume templates in the planner |
| Fixture | `fixtures/lifeline/infra/town/baseline-policy.json` (5 cases; true repair at 11,400 s, between the two ETA scenarios; settings locked here) |
| Evidence | `artifacts/lifeline/infra/p13-run-{0..7}/`. Runs 0–4 are retained as aborted or superseded; **run 6** holds independent, priority, rolling and oracle; **run 7** holds hybrid (all other code paths unchanged since run 6) |
| Tests | `test_baselines.py` 3/3; `joint-controller.test.mjs` 7/7; `npm test` all passing; all Python suites pass in the town environment |

## How the comparators work

All comparators act through the same town controller interface (observe, command, admitted model, preview), with the same capability catalog, telemetry ages and execution path.

**Decision time is charged.** Each decision's measured wall time × 60 (the town's accelerated clock), rounded up to the 60 s grid, passes before its steps may act. A controller cannot start another decision while computing one. Steps that have become due run before any new decision. A rule may ask to re-decide sooner.

| Comparator | What it does |
| --- | --- |
| independent | power closes ties after 120 s of dead buses, trying the next tie two minutes after each attempt; water dispatches the generator on its own station mains alarm |
| priority | independent, plus a demand shift when measured storage outlasts the latest declared ETA |
| rolling | the P12 planner every 15 min and on outside changes, on the ETA scenarios |
| hybrid | priority and rolling as parallel layers, each with its own latency |
| oracle | rolling given the true future; **a ceiling, not deployable** |

## Comparator defects found and fixed (runs 0–5)

| Run | Finding | Fix (with test) |
| --- | --- | --- |
| 0 | The optimizer's catalog omitted tie S2, which the storm left working; independent beat it by closing S2 | catalog completed; the parity test now checks assets as well as command types (RED with the old catalog). The P12 note records the same omission |
| 1 | The optimizer acted at the fault instant: 10–20 s of search was not charged | latency charged on the town clock (asserted in tests) |
| 2 | The oracle's decisions (14–19 simulated min) kept replacing each other before acting | no new decision while one is still computing |
| 3 | A decision at the instant a step became due replaced that step | due steps run before deciding (regression test with a fake town and clock: RED with the old order) |
| 4 | aborted by a user pause; the paused minutes would have been charged as decision time | rerun |
| 5 | independent waited a 15 min period after each rejected tie, reaching S2 only at 4,560 s | rules may re-decide two minutes later (unit test) |

Runs 3 and earlier ran beside an unrelated CPU-heavy user process, so their decision latencies were inflated. Because latency is measured wall time, results depend on host load; runs 5–7 ran on a quiet host.

## Results (essential water unmet m3 / essential power unserved MJ; 4 h; storm at 1,800 s)

| Case | independent | priority | rolling | **hybrid** | oracle (ceiling) |
| --- | --- | --- | --- | --- | --- |
| no fault | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| high storage (ties S1, S3 disabled) | 0 / 273 | 0 / 273 | 0 / 273 | 0 / 273 | 0 / 0 |
| lower storage | 0 / 273 | 0 / 273 | 0 / 975 | 0 / 273 | 0 / 0 |
| second fault at 3,600 s | 5.88 / 9,729 | 5.88 / 9,729 | 5.40 / 9,729 | **5.40** / 9,729 | 0 / 0 |
| all ties available | 0 / 117 | 0 / 117 | 0 / 351 | 0 / 117 | 0 / 0 |

Decision latency: rules ~0 s (charged one 60 s step); the optimizer 7.6–12.3 s mean (charged 15–25 min).

**Attribution.**

- **Coordination vs independence:** the coordinated priority rule never changed an outcome here, so the shared ETA and endurance rule adds nothing in these cases.
- **The optimizer alone** loses to competent rules when its charged latency delays action (lower storage, all ties available). It gains only in the second-fault case, where its generator dispatch and timed demand shift save 0.48 m3 of essential water.
- **Hybrid** keeps the rules' speed and the optimizer's cross-domain gain. It is never worse than either, so it is the comparator any LIFELINE or Meta system must beat.
- **Headroom:** the oracle loses nothing in every case by closing a tie before the storm. That needs foresight of the storm. The 273–9,729 MJ gap between hybrid and the oracle is the room a better forecast-driven controller could use.

**Checks:**

- The comparator's catalog equals everything the town accepts: commands, switches, pumps, links and resources.
- Its first decision on high storage closes the same tie (S2) as exhaustive search over 48 schedules (no tie or one of three ties × dispatch now / in 1 h / never × two 1 h station-mode slots), which serves all essential water.
- The Python perfect-information search covers generator × station mode only, not ties. It confirms that more capabilities are never worse and that the no-fault optimum takes no action, but it is not the full ceiling; the Node oracle is.

## Comparator revision 2 (P14, runs 8–9)

P14 run 4 showed the comparator could not shed a non-essential zone: no template used the residential valve, and the service policy ignored non-essential water. Revision 2 adds:

- non-essential water to the ranking, after essential power and before fuel;
- shed-now, shed-in-1h and restore templates for the residential valve PZ;
- a 20-candidate cap.

It also makes the oracle latency-free (a ceiling: perfect information and instant decisions). Run 8 was aborted by a worker request timeout (the client limit is now 10 min); run 9 is the revision-2 reference:

| Case | hybrid rev 2: essential water m3 / essential power MJ | oracle |
| --- | --- | --- |
| no fault | 0 / 0 | 0 / 0 |
| high storage | 0 / 273 | 0 / 0 |
| lower storage | 0 / 195 | 0 / 0 |
| second fault | **0** / 9,612 (rev 1: 5.40 / 9,729) | 0 / 0 |
| all ties available | 0 / 117 | 0 / 0 |

In the second-fault case revision 2 sheds the residential zone late and restores it, so the comparator now serves all essential water there. Revision 2 is the comparator for P14 onward.

## Limits

- Five development cases, one run each.
- Latency is measured wall time, so results vary with host load.
- The settings are locked here; any AI system gets the same development allowance before qualification.
