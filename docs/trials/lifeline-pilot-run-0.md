# LIFELINE Pilot Run 0 (G4a)

**Suite:** frozen pilot, protocol revision 1 (`fixtures/lifeline/protocol-v1.json`, frozen at `90bc5b6` before any meta result). **Date:** November 1, 2026, 06:58–07:49 UTC (episodes), reclassified 08:05 UTC. **Task:** 11, preliminary comparison.

**Result:** A completed, negative preliminary comparison. On 8 development cases × 2 repetitions, the Meta-assisted controller tied the adaptive conventional baseline on 6 cases and did worse on 2. The mean paired difference over recoverable failure cases was **−1.35 percentage points** (worst −7.24, best 0.00), with no no-fault regression. The traces show why: the model's 14–18 s decisions replaced a conventional rule that acts in seconds. This qualifies G4a as preliminary evidence. It supports no improvement claim.

## Identity and execution

| Item | Value |
| --- | --- |
| Episodes | 48 scheduled (8 cases × `priority`, `adaptive`, `meta` × 2), seeded order 20261101, run sequentially on the qualified VM |
| Code | `69bf7c1` for all 48 first attempts (clean tree); reclassification with `74667be` (tooling only: replay checker, evaluator) |
| Policy / provider | `policy-v1.json`; `muse-spark-1.3`, medium reasoning effort, 6,000-token cap, 18 s per call, 2 calls per decision, 12 calls per run |
| Evidence | `artifacts/lifeline/guest/pilot-v1/` (`index.jsonl`, `reclassification.jsonl`, `comparison.json`, `comparison.md`, one bundle per attempt); untouched copy as first written in `pilot-v1-original/` |

```text
2c41f2d1d875f86242e3b37dfc41418e235afe153d290bc76bbcf1595c512f98  pilot-v1/comparison.json
3829009c4d3a9336ba1d4737675e921a516334dfdd62900280cd675a6eee9980  pilot-v1/index.jsonl
abf22222e27eabcfd6c7719e96882ab8346139b2d7b0b2cb2a4a8917602b4c35  pilot-v1/reclassification.jsonl
99268a6a2fb240ac3a82c86c7d8c9c11dca03994dd25bd1956399916cd1526b1  pilot-v1/schedule.json
```

## What went wrong in the tooling, and how it was handled

The evaluator first reported 3 of 48 first attempts as infrastructure-invalid. All three were `meta` runs flagged by the replay's contract check. The checker treated stateful guard rejections (`action_rejected/transition_overload`, a transition-capacity check that needs run state) as contract disagreements. Following the protocol, the evaluator then reran those three paired blocks. Each run had left its raw logs in the guest's RAM-backed `/run`, which the run script never released, so the tmpfs filled (591 of 592 MB). Eight of the nine reruns then failed with `No space left on device`, and the ninth was flagged by the same faulty check.

Fixes (`74667be`, test-first): the replay now compares only the recorded `contract` check (4 new tests); the run script releases its guest run directory after copying the logs; reruns get unique tags. `--reclassify` then re-applied the corrected rule to every first attempt without rerunning traffic. Exactly the 3 flagged runs changed, to valid, and all 48 first attempts are valid. The 9 rerun attempts are withdrawn because the corrected rule does not require them; they remain in the index. All first attempts had scored, replay-matched captures before the tmpfs filled (the first pass used about 450 MB). The original outputs are retained unmodified.

## Results (receipt-scored on-time essential delivery, primary window)

| Case | Priority | Adaptive | Meta | Meta − adaptive | Per-run (meta) |
| --- | --- | --- | --- | --- | --- |
| p1 no fault | 100.00 | 100.00 | 100.00 | 0.00 | 1.000, 1.000 |
| p2 outage, adequate backup | 100.00 | 100.00 | 100.00 | 0.00 | 1.000, 1.000 |
| p3 outage, competing background | 99.94 | 100.00 | 100.00 | 0.00 | 1.000, 1.000 |
| p4 capacity drop, link up | 99.24 | 99.05 | 99.05 | 0.00 | 0.9905, 0.9905 |
| p5 outage, then backup capacity drop | **99.93** | 97.24 | 90.00 | **−7.24** | 0.935, 0.865 |
| p6 gray failure (silent lossy link) | 96.73 | **99.34** | 98.46 | −0.88 | 0.981, 0.988 |
| p7 stale telemetry, compound | 99.95 | 100.00 | 100.00 | 0.00 | 1.000, 1.000 |
| p8 partition (clinic unreachable) | 33.34 | 33.34 | 33.34 | 0.00 | 0.333, 0.333 |

Two repetitions per case are not enough for an uncertainty interval; none is claimed. Repetitions agreed closely for the deterministic controllers (within 0.03 pp) and less for `meta` (p5: 93.5% and 86.5%), consistent with variable model latency.

| Controller | Model calls | Failed calls | Model time | Output tokens | Interventions | Rejected proposals | Probe bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| priority | 0 | 0 | 0 s | 0 | 12 | 0 | 0 |
| adaptive | 0 | 0 | 0 s | 0 | 40 | 0 | 320,000 |
| meta | 39 | 8 (timeouts) | 536 s | 104,196 | 45 | 18 | 481,536 |

## Why the meta controller lost (from retained traces)

**p5, repetition 2 (86.5%).** After the 65 s capacity cut on r3-r4, both controllers' deterministic layers made the same first move at 66 s: throttle bulk-shelter and reroute dispatch-clinic. Field-clinic remained degraded. The adaptive controller's unexplained-degradation rule probed two paths and moved field-clinic at 74 s, and it recovered by 73–74 s. In the meta controller that rule is handed to the model while the model is available. Its investigation's first call timed out after 18 s (87.6 s), and the retry answered at 105 s (17.5 s) with a correct diagnosis ("r4>r3 capacity-reduced to ~3 Mbps") but only a background throttle. A reroute came at 121 s, after the scored window. Field-clinic missed deadlines from 65 to 104 s; its delivery after incident 2 was 26.6%, against 85.3% under the adaptive controller.

**p6.** Similar timing: two 13–15 s model calls before any effective change, then two timeouts during the 65 s outage, which put the controller in degraded mode (83–104 s).

**Priority on p5.** It won p5 (99.93%) by shedding background early. On this case, simple shedding beats rerouting; on p6 the same strategy lost (96.73%).

## What this supports and does not

- G4a: a complete, predeclared paired comparison with every attempt accounted for, including a disclosed tooling correction.
- C2: the model took part in real decisions (39 calls, 45 interventions including deterministic ones, 18 rejected proposals) with measured consequences.
- **Not supported:** any claim that LIFELINE improves essential delivery over a competent conventional controller. On this pilot it did not.

## Design implication for the next protocol revision (not applied to this pilot)

Model latency (14–18 s per call, 21% of calls timing out) makes the model unsuitable as a replacement for fast conventional reactions. A revision should let the deterministic rule keep acting while the model investigates in parallel, and score the model on diagnosis or longer-horizon decisions. That is a new protocol revision; it cannot reuse these cases as held-out evidence.

**Next:** Task 13 live check, then Task 14 release package with this result stated plainly.
