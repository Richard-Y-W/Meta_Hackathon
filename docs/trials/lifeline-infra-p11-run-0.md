# LIFELINE Infra P11 Run 0 — Coupled state, clocks and resource conservation

**Date:** November 1, 2026. **Task:** P11. **State:** qualified, with two items left open (listed at the end). Development town only.

| Item | Value |
| --- | --- |
| Environment | `.work/environments/town`: CPython 3.12.15, pandapower 3.2.2 and WNTR 1.5.0 in one process (pandas 2.3.3), pinned in `runtime/infra/requirements-town.lock`. The qualified water environment is unchanged. The P06/P08/P09 suites (`test_power`, `test_water`, `test_water_control`, `test_scoring`) were re-run here and pass, including the CIGRE provenance hash |
| Code | `runtime/infra/coupling.py` (town orchestrator), `runtime/infra/clock.py` (clock profiles, charged latency), `runtime/infra/worker.py` (stdio worker, trace evidence); plant hooks (power: declared extra loads, coupled loads, bus energization; water: pump flow/head per sample, coupling-sourced physical changes); `src/lifeline/kernel/services.mjs` adds `defineDependencies` and `facilities` |
| Fixtures | `fixtures/lifeline/infra/town/dependencies.json` (9 edges: 2 power→pump supply, 2 pump→electrical load, 3 power→router supply with batteries including one irrelevant control edge, 2 communications→remote control), `fixtures/lifeline/infra/town/development.json` (4 cases) |
| Evidence | `artifacts/lifeline/infra/p11-run-0/` (`traces.json` and one trace per run) |

## How the town couples

The coupling step is 60 s and is declared; it must be a multiple of the hydraulic step. Each step starts with a bounded fixed-point (at most 6 sweeps, 1 W tolerance):

- the power solution gives each pump its supply (bus energized), with a 120 s restart delay on return;
- the water solution gives each pump's electrical load as P = ρgQH/η (no power from reverse flow or negative head), which goes back into the power plant;
- the cycle repeats until pump powers stop changing.

Both plants then advance to the next step. Electrical protection runs inside the power plant at 5 s.

Routers run on mains while their bus is energized and on battery otherwise. Remote telemetry and commands need the site router; the local station controller (tank band, duty and backup pump) and protection need only station power. Clock profiles are `real_time_hybrid` (1×, packet communications allowed) and `accelerated_modeled` (×60 here, modeled communications only). Communications are a **modeled** profile with a declared 200 ms one-way latency, not packet-measured.

## RED → GREEN

The coupling code was written before its tests, so test power comes from mutations; each one fails its test:

| Mutation | Failing test |
| --- | --- |
| router ignores its battery | the battery-exhaustion test |
| telemetry bypasses the path | the stale-telemetry test |
| commands bypass the path | the unconfirmed-command test |
| latency not multiplied by the acceleration | the two clock tests |
| catalog edge without evidence accepted | the dependency-catalog test |

The pump-supply mutation first went undetected: the local controller had already switched PU1 off before the trip and never re-commands an unpowered pump. The test now commands PU1 on over the battery-backed router after the trip and requires zero flow while unpowered; it then failed under the mutation.

Two test-design fixes:

- The local station controller ran "300 s after its last run", so its schedule moved with the step size. It is now on absolute multiples of its period.
- The 30 s sensitivity run refines the hydraulic step together with the coupling step.

```text
test_coupling.py 15/15, test_clock.py 3/3 (town environment); services.test.mjs 3/3; npm test 355 pass
```

## Checks (all in `test_coupling.py` / `test_clock.py`)

| Check | Result |
| --- | --- |
| Pump electrical load | equals ρgQH/η from the hydraulic solution (1e-6 W); the power solution carries it (1e-3 W); EPANET's own pump energy agrees within 1% |
| Tank balance | V(t+60 s) = V(t) + net flow × 60 s within 0.05 m3 |
| Pump without supply | commanded on but unpowered → zero flow, zero electrical load; the secondary water loss follows from the equations; with the power→pump edge removed, the same trip leaves water service intact |
| Battery-backed comms | router exhausts at exactly trip + capacity/draw (720 kJ at 200 W = 3,600 s) and is up until then; doubling capacity doubles the endurance |
| Telemetry loss ≠ physical failure | with only the router failed, the tank level stays at its last delivered value and time (stale by age); the router reads `unreachable`; the hospital link is unaffected; essential water is fully served; no supply or pump failure is invented |
| Command without a control path | `unconfirmed`, no physical effect; local station control continues acting during the outage; the same command with a path is `delivered` |
| Ablations | removing or re-sourcing the irrelevant router edge changes nothing (identical tank trajectory); removing the pump-load edge removes the electrical demand while pumping continues |
| Common-cause hazard | one storm trips line 3-8 and fails the substation router directly; the router is on mains (its bus is alive), so its failure is recorded with its hazard, not as a cascade |
| Sensitivity | hospital water-loss onset differs by at most one 60 s step between 60 s and 30 s steps; sweep order (supply-first vs load-first) gives identical trajectories |
| Restart | town checkpoint → restore → continue reproduces the uninterrupted trajectory and events |
| Out-of-order telemetry | an older reading arriving later is dropped and counted |
| Nonconvergence | no electrical solution → `coupling_unresolved`, the previous supply state is kept (no invented failure), and the event is attributed `model_nonconvergence` or, when a command was just applied, `action_caused` |
| Clock | 15 s of provider time at 60× becomes available 900 simulated seconds later; pending results never release early, and the world keeps stepping while they wait |

## Retained traces (case `t-feeder-loss-backup-out`: PU2 in maintenance, storm trips line 3-8 at 1,800 s)

| Run | Hospital water lost at | Water essential unmet | Power essential unserved | Lowest tank level |
| --- | --- | --- | --- | --- |
| no intervention | 5,940 s (69 min after the trip) | 51.1 m3 | 8,193 MJ | 0.50 m |
| remote close of tie S1 at 2,400 s | never | 0 | 390 MJ | 1.74 m |
| ablation: no power→pump edge | never | 0 | 8,193 MJ | 1.74 m |
| ablation: no pump→load edge | 5,940 s | 51.1 m3 | 8,193 MJ | 0.50 m |
| ablation: no power→router edge | 5,940 s | 51.1 m3 | 8,193 MJ | 0.50 m |

**Gate check.** At least two qualified causal edges produce measurable cross-domain effects:

- **power → pump:** the hospital water loss; removing the edge removes the loss;
- **power → router:** battery exhaustion and loss of remote telemetry and control at the pump station;
- **pump → load:** a measurable 14–15 kW load on bus 7, with no service effect at this size.

Every service failure comes from the equations; the incident is only the line trip.

## Open (not claimed)

- **Acknowledgement loss** after a delivered command is not modeled; a command is either delivered or `unconfirmed`.
- **Real-time hybrid mode** with packet communications exists as a clock profile but has not been run in the town; the town runs in accelerated modeled mode.
- Edge uncertainties (e.g. pump efficiency ±0.05) are declared but not propagated.
