# LIFELINE Infra P08 Run 0 — Water distribution adapter and restart qualification

**Date:** November 1, 2026. **Task:** P08. **State:** qualified for distribution hydraulics, service accounting and closed-loop state handling by replay. **No water-quality, treatment or potable-water claim** (`qualityModelQualified: false` in every record).

| Item | Value |
| --- | --- |
| Backend | EPANET 2.2 toolkit via WNTR 1.5.0, pressure-driven demand (PDA). Chosen after testing: WNTR's native pause/restart is not equivalent (the network clock overshoots one step on resume; a restarted tank level differed by 1.1e-3 m), while the toolkit steps natively and replays deterministically |
| Environment | `.work/environments/water`: uv-managed CPython 3.12.15 under `.work/python`, uv cache on the SSD, pinned in `runtime/infra/requirements-water.lock`. The home-directory uv dirs (dated Oct 27) were untouched |
| Code | `runtime/infra/water_wntr.py`, `runtime/infra/water_evidence.py`, `src/lifeline/domains/water.mjs`; contract metric `water.level` (m) |
| Fixtures | `fixtures/lifeline/infra/water/analytic.inp` (pumped tank, 12 m3 usable, 10 L/s essential node, normally-closed branch), `reference.inp` (EPANET Net3, copied unmodified from WNTR), `networks.json` (sensors, actuators, PDA pressures, envelopes, tolerances), `provenance.json` (hashes, source, licence) |
| Evidence | `artifacts/lifeline/infra/p08-run-0/evidence.json` |

## RED → GREEN

The plant was written with its accounting conventions in place, so test power comes from mutations, plus one genuine RED found in review:

```text
remove the isolation convention   → 2 failures (isolated node, closed link)
count leak flow as service        → initially undetected (scoring caps service at demand); the test was
                                    strengthened to check per-sample delivered = required with a separate
                                    leak, then failed under the mutation
ignore pump outage                → 7 failures (depletion, storage, leak, mass balance, frozen sensor, Net3)
isolated time not counted as low pressure (found in the Net3 run): RED 0 s vs 49,612 s isolated → GREEN
test_water.py                      20/20 (water environment); water-adapter.test.mjs 5/5; stale-label mutation caught
npm test 339 pass; power and Grid2Op suites pass
```

Two first-run test failures were test or measurement errors, not plant defects. An emptied tank reads 9e-6 m above its minimum, so a 0.1 mm level tolerance is now declared. EPANET also clips a filling tank at full on whole seconds; see mass balance below.

## Checks

| Check | Result |
| --- | --- |
| Analytic depletion (12 m3, 0.01 m3/s) | 1,200 s at hydraulic steps of 60, 30 and 10 s (deviation 0); 12.0 m3 delivered before, unmet after |
| Tank mass balance | exact while draining (within 1e-3 m3); while filling, each tank-full event leaves at most 1 s of net inflow unaccounted, because EPANET clips the tank at full on whole seconds |
| Pump outage | storage falls, then delivery fails after depletion |
| Isolated node | delivered exactly 0, although EPANET reports a residual 2e-5 L/s; full deficit; flagged isolated |
| Closed link / pipe break | downstream node isolated, deficit integrates |
| Leak (emitter) | EPANET's reported demand includes emitter flow; consumers get their demand, and the leak is reported separately as loss and drains storage sooner |
| Low pressure | 3× surge on JD → pressure below 15 m, partial PDA delivery, low-pressure time counted; isolated time also counts |
| Zero demand | score `null`, status scored |
| Commands | stale revision and unavailable actuator refused; off-grid times and clock regression refused; envelope violations refused |
| Restart / fork by replay | checkpoint → diverge → restore and fork-from-checkpoint give ledgers identical to the uninterrupted run; the diverged negative control differs. Restore cost 4 ms at 10 min, 52 ms at 24 h simulated time |
| Preview isolation | admitted model has no fault schedule; preview leaves the checkpoint hash unchanged; a true-plant checkpoint is refused |
| Node adapter | canonical envelopes (Pa, m, m3/s); frozen sensor labeled `stale` by age; Python and Node scorers agree within 1e-6 m3 |

## Net3 reference run (24 h, PDA 14 m required pressure, essential junctions 109/101/119)

| Quantity | Baseline | Pump 335 out at 1 h |
| --- | --- | --- |
| Essential required | 3,483 m3 | 3,483 m3 |
| Essential unmet | 0 | 1,845 m3 (scores 0.47) |
| Essential low-pressure / no-service time (sum of three nodes) | 0 | 148,836 s |
| Pump energy | 26.8 GJ | 1.1 GJ |
| Tanks at end (1/2/3) | 9.60 / 11.81 / 10.82 m | at their minimum levels |

The independent check runs WNTR's `EpanetSimulator` over the same model through a different code path and compares at 289 steps. Maximum pressure difference at the essential nodes is 0.47 mm; maximum tank-level difference is 0.16 mm.

**Modeling decision to note.** All 18 Net3 controls act on the two declared pump actuators, so the plant removes them; actuator behavior belongs to the controller (P09). Without them, pump 10 stays at its initial closed status and pump 335 alone supplies the town. This baseline is therefore not Net3's published operating schedule.

## Limits

Extended-period distribution hydraulics only. Isolation is judged on the undirected graph of open links (check valves are not part of that judgement). Decisions and faults sit on the declared hydraulic step. Restore and preview cost grows with simulated time.
