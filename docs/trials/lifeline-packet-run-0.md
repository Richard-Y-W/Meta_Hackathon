# LIFELINE Packet Run 0

**Run IDs:** `run-20261101042811-lfc1` (run of record), `run-20261101042227-lfc0` (development, dirty tree). **Date:** October 31, 2026. **Task:** 4, real messages, telemetry and the cascade.

**Result:** Qualified for the fixed reference policy. Real application messages cross the six-switch emulated network. The independent scorer sees both incidents. The cascade, partition, restart and boundary controls behave as specified. No controller decision or AI result is involved.

## Identity

| Item | Value |
| --- | --- |
| Code for run of record | `21764ca`, clean tree (manifest `code.dirty: []`) |
| Development run `lfc0` | `b7e2f4c` plus uncommitted Task 4 files; superseded as evidence by `lfc1`, retained for comparison |
| Scenario | `fixtures/lifeline/development/cascade.json`, `dev-cascade-1`, canonical sha256 `5eae0436b71f2e403e2319d49c62ad173a83a78ac5b8c51c1e03d558b3fccfca`; worker-visible part `db1be8d8886a30096a71098c364e7bf07d7a5672a553d4e129db0af08bc702da` |
| Controller | `fixed`: reference routes with OpenFlow fast-failover at each ingress switch; no runtime decisions |
| Platform | Runtime run 0 VM (Ubuntu 24.04, kernel 6.8.0-147, Mininet 2.3.0, OVS 3.3.9, Node v24.14.1, Python 3.12.3); guest load 0.28 before, 0.75 after |
| Evidence | `artifacts/lifeline/guest/packet-run-1/` (manifest, events, controller view, summary, raw sender/receiver logs, `checksums.txt`) |

## Scenario as run

Six OVS switches in a ring with direct `r0-r3` (20 Mbit/s) and cross-link `r1-r4` (6 Mbit/s); ring links 8 Mbit/s; 5 ms delay and a 200-packet queue per link. Hosts: dispatch on `r0`, field on `r1`, clinic on `r3`, shelter on `r4`. Three essential UDP flows of 80 messages/s, 1,024-byte payload, 500 ms deadline, retries at 250 and 400 ms, routed acknowledgements. Two paced UDP background sources: `bulk-shelter` 4 Mbit/s and `bulk-field` 6.5 Mbit/s. That second rate is a development setting chosen so failover onto `r1-r2` exceeds its capacity. Hidden schedule: `r0-r3` down at 20 s; `r1-r2` reduced to 3 Mbit/s at 65 s with the link still up. The episode ran 120 s.

Faults were applied 9 ms (incident 1) and 19 ms (incident 2) after their scheduled times, measured on the worker clock against the supervisor's schedule. That agreement supports the shared `CLOCK_MONOTONIC` basis: Node `process.hrtime` and the worker's `time.monotonic_ns` in the same kernel, with the worker epoch exchanged at handshake. It is not an independent clock-error measurement.

## Measured outcomes

| Window (ms since traffic start) | Offered | On time | Late | Lost | On-time rate |
| --- | --- | --- | --- | --- | --- |
| Warm-up [0, 20000) | 4,800 | 4,800 | 0 | 0 | 1.000 |
| Primary [20000, 120000) | 24,000 | 15,126 | 2,910 | 5,964 | 0.630 |
| After incident 1 [20000, 65000) | 10,800 | 10,689 | 59 | 52 | 0.990 |
| After incident 2 [65000, 120000) | 13,200 | 4,437 | 2,851 | 5,912 | 0.336 |

After incident 2, `dispatch-clinic` and `field-clinic` each delivered 0.4% on time; `dispatch-shelter` delivered 100% throughout. Essential transmissions per offered message: 2.14 and 2.13 for the clinic flows, 1.00 for shelter. Background delivered fraction over the primary window: `bulk-field` 0.63, `bulk-shelter` 0.0006.

Mechanism, from the retained telemetry and records:

- Incident 1: fast-failover moved `dispatch-clinic` onto `r0-r1-r2-r3`. The `r1` egress backlog on `r1-r2` rose from about 5 KB to 119 KB, and on-time delivery for that flow dipped to 92–98% per 3-second bin.
- `bulk-shelter` was blackholed after incident 1. Its ingress switch `r4` watches only `r4-r3`, which stayed up, while the failed hop `r3-r0` is downstream. The fixed policy has this weakness; it is not a measurement error.
- Incident 2: no port went down, so no failover occurred. Queue drops on `r1-r2` reached 12,434 by 80 s, and sender transmissions rose to 1.7× offered as retries added load.

Repeatability: development run `lfc0` gave 0.6303 (primary), 0.9898 and 0.3361 (incident windows) and the same retry amplification. Two runs do not estimate variance.

## Controls

| Control | Run | Outcome |
| --- | --- | --- |
| Complete partition: all three clinic links down at 20 s, 60 s episode | `run-20261101042523-lfp0` (`partition-run-0`) | Primary 9,600 offered, 3,201 on time, 0 late, 6,399 lost: shelter delivered, both clinic flows 0. Nothing claims recovery |
| No-fault smoke, 10 s | `dev-smoke-1` | 2,400 offered, 2,400 on time; sender manifests complete |
| Repeated start/stop, 2 × 5 s | `restart-run-1`, `restart-run-2` | Each: worker exit 0, no run-owned bridges, links or processes, socket removed |
| Unrelated objects preserved | `unrelated-objects-run` | Pre-existing bridge `keep0` and veth `keepv0/keepv1` survived the run |
| Controller-view audit | all runs | 0 findings: no fault labels, schedules or configured capacities in 246 observations (cascade) |
| Missing counters | cascade | 0 null `txBytes` entries; parser keeps unknown counters `null` |

## Tests

```text
node --test test/lifeline/worker-client.test.mjs     → 16 pass (RED 16/16 on stub)
node --test test/lifeline/telemetry.test.mjs         → 4 pass (RED 4/4 on stub, checked after the implementation was written)
python3 -m unittest … -p test_contracts.py           → 24 pass on host Python 3.9.6 and guest 3.12.3 (RED 22 errors on stubs)
sudo LIFELINE_INTEGRATION=1 python3 -m unittest … -p test_integration.py → 1 pass in the VM; skipped with reason on the Mac
npm test (host)                                      → 102 pass
```

The integration test was written after the worker; it verifies behavior rather than driving it.

Defects found and fixed during this task:

- A worker that dies mid-frame emits `close` without `end`; the client now reports `truncated_frame` either way. The in-memory test double was corrected to signal EOF the way a real socket does.
- OVS OpenFlow 1.3 statistics key ports by number, so every counter was `null` in the first smoke run. A real-output parser test reproduced it, and lookup now uses the OpenFlow port.
- Run windows were not clamped to short durations.
- Acknowledgement routes lacked backups, which would have blackholed acknowledgements at the first outage.
- The protocol test harness held its socket open through `makefile`, adding 2 s per test.

## What this supports

C1 for the fixed policy: the prototype runs a packet network, applies administrative faults, and measures essential-message outcomes from independent sender and receiver records. The development cascade produces deadline loss through measured queueing and retries. Controllers see symptoms (state, backlog, drops, retransmissions), not the impairment.

## What remains unqualified

- Any controller decision, route or rate change during a run (Tasks 5–7). The `rate-<source>` control file exists but nothing writes it yet.
- Probe traffic and default routes for unregistered flows.
- Telemetry delay or loss, and counter resets.
- Fixture rates are development settings, not a frozen protocol.

**Next:** Task 5 (authority, freshness and budget guard). Task 1's provider half still needs `MODEL_API_KEY`.
