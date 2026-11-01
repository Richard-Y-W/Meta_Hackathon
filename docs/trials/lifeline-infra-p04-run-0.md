# LIFELINE Infra P04 Run 0 — Arbitration, authority and partial execution

**Date:** November 1, 2026. **Task:** P04. **State:** qualified. The kernel is in-memory and adapter-agnostic. Live multi-domain execution through it starts with the coupled town (P11+).

| Item | Value |
| --- | --- |
| Code | `c220543`: `src/lifeline/kernel/{plans,arbiter,coordinator}.mjs`, tests `test/lifeline/infra/{plans,arbiter,coordinator}.test.mjs` |
| Evidence | `artifacts/lifeline/infra/p04-run-0/kernel-trace.json` (`node scripts/lifeline-kernel-trace.mjs`); scheduling input from [communications v2 run 0](lifeline-communications-v2-run-0.md) |

## Behavior verified (tests and retained trace)

- An investigation holds no locks. A supervisory reservation is preempted by an immediate recovery plan on the same asset (`reserve-1` preempted by `recovery-1`), and recovery succeeds.
- A plan for an older configuration revision is refused before each action (`configuration_stale`). Changed content under the same approval identity is rejected.
- Partial completion: `meta-2` stopped at injected rejection `sup-b`. Read-back shows `sup-a` succeeded, so only its declared compensation `sup-a-undo` ran and the receipt is `partial`. No multi-domain atomicity is assumed.
- An operator manual override on `valve-3` refuses the later plan `meta-3` (`manual_override`).
- Authority modes observe/recommend/approve_each/bounded_auto, supersession, idempotent retries, missing acknowledgements and lock-busy waits are covered in the kernel tests.

## Frozen local-control scheduling budget

The budget is set from measured runs, before this qualification:

| Source | Lag p95 | Lag max |
| --- | --- | --- |
| Communications v2, 60 episodes (worst episode) | 5.81 ms | 48.9 ms |
| Kernel trace: 100 ms tick, 50 hanging model calls, solver in 5 ms slices | 3.90 ms | 3.90 ms |

**Frozen budget (local control):** per-episode tick-lag p95 ≤ 10 ms and maximum ≤ 100 ms. Both sources meet it. Later tasks reuse this budget; changing it requires a new revision with its own rationale.

## Limits

The trace uses in-memory adapters. Solver load is simulated by cooperative slices; a blocking solver in the same process would violate the budget, so domain solvers run in separate worker processes (P06+).
