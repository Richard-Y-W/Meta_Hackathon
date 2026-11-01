# LIFELINE Execution Run 0

**Run IDs:** `run-20261101044411-lft2` (transition, run of record), `run-20261101044516-lfc2` (cascade regression). **Date:** October 31, 2026. **Task:** 6, executing and reconciling real network effects.

**Result:** Qualified. Versioned route updates and background throttling ran through the guard and executor on live emulated traffic. Two successive updates and one throttle were confirmed with no transient loss in this no-fault setting. Failure handling is qualified by contract tests and two real-OVS integration tests.

## Identity

| Item | Value |
| --- | --- |
| Code | `e2f0310`, clean tree for both runs of record |
| Controller | `scripted`: a diagnostic replay of `fixtures/lifeline/development/transition-script.json`, not a comparator |
| Scenario | `no-fault.json`, 50 s; `cascade.json`, 120 s (regression) |
| Evidence | `artifacts/lifeline/guest/transition-run-0/`, `packet-run-2/`; development runs `transition-run-dev`, `transition-run-dev2` |

## Mechanism

The ingress switch tags a flow's packets with a DSCP version, and downstream switches forward each version along its own path. `prepare_route` installs a new version's downstream rules for the data and acknowledgement paths and reads each one back before reporting it as an effect. `commit_route` replaces the ingress rule, which counts as one configuration revision. The executor then waits for the version's packet counter at the destination switch to increase, drains for 1 s and retires the previous version. Rollback reactivates a still-installed earlier version; for the reference version 0, it deletes the tagging ingress rule. Rate changes are throttle-only and read back from the sender's control file. Every command carries an operation ID; reusing an ID returns the recorded outcome, and reusing it with different arguments is refused.

## Packet results

| Run | Actions | Outcome |
| --- | --- | --- |
| Transition `lft2` | `dispatch-clinic` → `r0-r5-r4-r3` at 15 s; → `r0-r1-r2-r3` at 30 s; `bulk-field` → 2 Mbit/s at 40 s | All 3 admitted and confirmed. Route updates took about 1.9 s each, including the 1 s drain. 4,800 essential messages: 4,800 on time, 0 late, 0 lost; 1.00 transmissions per message (no retry fired) |
| Development `lft0` | Same script | Update 2 rejected `lifetime_exceeds_policy`: the run script computed `collectedAtMs + 10000` in floating point (10000.000000000004 ms). Fixed by using integer milliseconds; the guard's exact check is unchanged |
| Cascade regression `lfc2` | Fixed policy | Primary on-time 0.631, compared with 0.630 in packet runs 0 and 1 |

The transition result is for an uncongested network. Loss during updates under congestion or concurrent faults is not yet measured.

## Tests

```text
node --test test/lifeline/executor.test.mjs           → 14 pass (RED 13/13 on stub; verify-exit regression RED then GREEN)
python3 -m unittest … -p test_controls.py             → 18 pass (RED 15 errors on missing classes; 2 rollback cases RED then GREEN)
python3 -m unittest … -p test_contracts.py            → 25 pass
sudo LIFELINE_INTEGRATION=1 … -p test_integration.py  → 2 pass in the VM
npm test (host)                                       → 137 pass
```

Executor contract cases: no worker request for a rejected or mismatched decision; prepare failure aborts its partial effects; ingress failure during commit; successful effect with lost reply reconciled without duplication; lost reply with no effect retried under the same operation ID; read-back of a rate change; verification timeout with rollback to a feasible version; impossible rollback followed by a deterministic fallback, or `service_unavailable`; cancellation; worker exit during commit or verification leaves an `unknown` effect and starts nothing else; two successive updates retire their predecessors.

Real-OVS integration: tagged traffic moved onto the new version (more than 40 packets in 1 s at `r3` and `r5`); a replayed commit returned `replayed: true`; rollback to version 0 stopped traffic on the tagged version (at most 2 packets in 1 s); abort left 0 rules.

Defects found: configuration revision counted once per role instead of once per commit; worker exit during verification escaped as an exception; integration tests shared a run directory; non-integer proposal times.

## Remaining limits

- Impossible rollback after an additional link failure is tested with the fake worker only, not on packets.
- `probe_path` is not executable yet; the executor refuses it without a worker call (Task 7).
- A process restart must reconcile through `control_state` before control resumes (Task 10).
- No measured transient loss under load.

**Next:** Task 7, conventional controllers.
