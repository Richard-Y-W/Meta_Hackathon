# LIFELINE Infra P09 Runs 0–1 — Water control and constrained preservation

**Date:** November 1, 2026. **Task:** P09. **State:** qualified as a working controlled water domain on development cases (adjustable; not held-out evidence; no AI claim).

| Item | Value |
| --- | --- |
| Code | `runtime/infra/water_control.py`; plant extensions in `water_wntr.py`: case tank-level override, history groups tagged fault/action, timed plan continuations in preview (an infeasible continuation is skipped and reported), leak accounting at any junction, per-node and tank outcomes in previews |
| Fixtures | `fixtures/lifeline/infra/water/town.inp` (main + backup pump, 90 m3 usable tank, hospital JH and fire station JF protected, residential JR behind valve PZ), `control-policy.json`, `development.json` (10 cases) |
| Evidence | `artifacts/lifeline/infra/p09-run-0/development.json` (superseded), `artifacts/lifeline/infra/p09-run-1/development.json` |

## RED → GREEN and baseline verification

- **Protected service:** a plan that closes the fire-station branch to save water for the hospital is refused (`protected_service_violation`, node JF). Closing the residential zone is allowed. The check compares each protected node's service against doing nothing; the episode metrics list protected violations per node, so an average cannot hide one.
- **Other rules tested:** unsupported pump speed (`unsupported_parameter`), unavailable actuator, minimum run/off time (`dwell_active`), starts per hour (`cycling_limit`), and storage reserve (`reserve_violation`).
- **Mutation checks:** removing the protected, reserve or start-limit rule fails its test.
- **Test-design fix:** with 600 s minimum run and off times, a pump can start at most 3 times an hour, so a 4-start limit was unreachable. The limit is now 2.
- **Baseline gap found by exhaustive enumeration.** On the tiny analytic network, the optimum over every 4-slot schedule serves the non-essential branch while the pump runs and closes it before an announced outage. The constant-plan baseline could not represent this. It now scores two-stage plans (one decision period, then a continuation), and its closed-loop first decision matches the optimum's first slot; the test also checks it never beats the optimum.
- **Run 0 → run 1 policy defect:** admissibility was judged as if every plan were held for the whole 2 h forecast horizon. A full tank empties in 1.4 h at full draw, so every routine pump-off was refused, and local control never cycled (run 0: identical energy with and without control). Admissibility now uses a declared 20 min commitment window: the longest dwell, plus a decision period, plus the actuator delay, with margin. A routine pump-off at a full tank is now admissible (regression test).

```text
test_water_control.py 11/11, test_water.py 20/20 (water environment); npm test 352 pass
```

## Development results (run 1; 6 h; essential = JH + JF; reserve 1.5 m)

| Case | Essential unmet m3 (none / local / predictive) | Non-essential unmet m3 (local / predictive) | Pump energy MJ (none / local / predictive) | Note |
| --- | --- | --- | --- | --- |
| no fault | 0 / 0 / 0 | 0 / 0 | 138.6 / 115.8 / 138.6 | local cycles its band (4 starts, lowest level 1.68 m); predictive keeps pumping (its weights value storage over 23 MJ) |
| main pump lost | 89.0 / 0 / 0 | 0 / 0 | 22.6 / 120.0 / 133.2 | both start the backup; predictive let the tank fall below reserve for 2,280 s |
| gradual leak (unobserved failure) | 0 / 0 / 0 | 0 / 0 | 204.9 / 174.8 / 204.9 | the evaluator reports 196 m3 lost to the leak while consumer demand is fully met |
| backup unavailable + main lost | 89.0 / 82.9 / 59.0 | 197.3 / 208.1 | — | predictive closes the residential zone sooner: less essential and more non-essential loss |
| low starting storage | 0 / 0 / 0 | 14.4 / 0 | 150.2 / 120.4 / 150.2 | local's conservation rule closes the zone briefly |
| demand surge (unknown demand) | 0 / 0 / 0 | 0 / 0 | 244.7 / 217.0 / 244.7 | the surge appears as delivered demand, with zero leak |
| level sensor frozen, then main lost | 85.4 / 0 / 0 | 0 / 0 | — | the stale level is not used; the backup starts on unavailability evidence |
| source isolated (unrecoverable) | 113.0 / 103.2 / 88.8 | 236.9 / 251.3 | 8.2 each | **no action avoids loss**; conservation only delays it |
| announced grid outage at 1 h | 78.2 / 82.9 / 48.3 | 197.3 / 186.5 | 33.1 / 18.3 / 33.0 | **preemptive scheduling helps.** Predictive runs both pumps and enters the outage at 4.96 m, against local's 2.69 m; local, having cycled down, does worse than no control |
| announced outage that never comes | 0 / 0 / 0 | 0 / 0 | 138.6 / 115.8 / 137.8 | **acting early wastes resources** (small here): predictive adds 2 pump starts and 3 switching-cost units, with no service benefit |

Protected-node violations are listed per node in every result (JF and JH in the pump-loss-without-backup, isolation and outage rows). Reserve trajectories, low-pressure seconds, switching cost and starts are retained per episode.

## Limits

- Pumps are on/off only. Setpoints, delays, costs, reserve and protected minimums are scenario assumptions.
- Advisories are exact when they come true; forecast quality is P10.
- The predictive baseline enumerates every actuator configuration with bounded continuations; it is exhaustive only on the tiny network.
- Predictive runs at about 13–42 s per 6 h episode.
