# LIFELINE Infra P07 Runs 0–1 — Electrical control, prevention cases and Grid2Op profile

**Date:** November 1, 2026. **Task:** P07. **State:** qualified as a working controlled power domain on development cases, with a separate Grid2Op acceptance record. These are development results on adjustable cases. They are not held-out evidence and make no AI claim.

| Item | Value |
| --- | --- |
| Code | `runtime/infra/power_control.py`, `runtime/infra/power_grid2op.py`; plant extensions in `power_pandapower.py` (overcurrent protection with checkpointed timers, sensor freeze/offset, actuator unavailability, transformer loading, forecast assumptions in preview, no-source handling, network reuse for forks) |
| Fixtures | `fixtures/lifeline/infra/power/control-policy.json`, `fixtures/lifeline/infra/power/development.json` (CIGRE MV + sensors, protection, envelope; 9 cases) |
| Environments | infra: pandapower 3.2.2 (`requirements.lock`); Grid2Op: separate `.work/environments/grid2op`, grid2op 1.12.6 with pandapower 3.2.2 (`requirements-grid2op.lock`), bundled test data, nothing downloaded to the home directory |
| Evidence | `artifacts/lifeline/infra/p07-run-0/development.json` (run 0, superseded baselines), `artifacts/lifeline/infra/p07-run-1/development.json` (run 1), `artifacts/lifeline/infra/p07-run-0/grid2op-acceptance.json` |

## RED → GREEN

```text
test_power_control.py with Policy.check() returning ok: 6 failures
  overload transition, incompatible switching, storage below reserve, unavailable actuator,
  unauthorized protected shedding, dwell — each "'ok' != '<code>'"
  (+1 error: a network with no in-service source made pandapower raise "No reference bus";
   now reported as a converged, fully de-energized solution)
→ GREEN 14/14 after the admissibility check (static rules, then every action prefix replayed on the
  admitted model; a prefix may not create a thermal violation absent from the starting state)
test_power.py 27 power + 3 scoring OK (adds no-source and frozen-sensor tests)
test_grid2op_profile.py 7/7 in the Grid2Op environment (skipped with a reason in the infra environment).
  Written before its tests; power shown by mutation: removing the terminal guard, the cooldown pre-check,
  or the illegal-flag mapping each fails the corresponding test.
```

## Baseline verification (run 0 → run 1)

Run 0 exposed two baseline defects, so it is retained but superseded:

- **Local was a strawman on constrained backup.** Its tie closure was correctly refused as an overload transition, but it had no shed-then-restore sequence, so it never restored (1,103 MJ essential unserved, the same as doing nothing). Run 1 adds the conventional sequence: if closing the tie would overload the backup path, shed in the fixed order first, using the same admissibility check as execution. It also adds undervoltage relief at 0.90 pu.
- **Predictive tolerated 842 s of voltage violation** instead of shedding, because the constraint weight was 1e5 J-equivalent per second. Run 1 raises it to 1e6.

A regression test covers the constrained-backup restoration.

## Development results (run 1; CIGRE MV, 900 s, essential = CI3 + CI7 + CI9 = 0.8755 MW)

| Case | Control class | Essential unserved MJ (none / local / predictive) | Non-essential unserved MJ (local / predictive) | Note |
| --- | --- | --- | --- | --- |
| no fault | no fault | 0 / 0 / 0 | 0 / 0 | no actions |
| gradual overload 1.0→1.8× (forecast at 0 s) | recoverable, prevention | 328.8 / 0 / 0 | 776.3 / 0 | none: two protection trips. Local sheds three loads; predictive closes S1 (meshed feeders) and sheds nothing |
| feeder loss, unannounced | recoverable | 735.4 / 106.8 / 1.8 | 420.1 / 6.9 | local waits its declared 120 s restoration delay; predictive closes at the next decision (2 s actuator delay) |
| announced loss of line 3-8 (240 s lead) | recoverable, prevention | 429.2 / 79.3 / 0 | 178.1 / 0 | predictive pre-closes a tie before the trip |
| constrained backup (1.5× peak, line 1-2 trip) | recoverable | 1,103.1 / 162.8 / 0 | 2,164.7 / 1,012.5 | both shed before closing; predictive acts sooner and sheds less |
| second contingency | recoverable | 546.2 / 158.7 / 2.6 | 356.2 / 5.8 | two restorations each |
| loss of the HV source | physically unrecoverable | 735.4 / 735.4 / 735.4 | equal | no action helps; local spends three useless tie operations, predictive stays idle |
| stale observation (three sensors frozen before the trip) | stale/corrupted | 546.2 / 79.3 / 1.3 | 178.1 / 2.9 | stale readings are excluded by age; other sensors carry the evidence |
| S1 actuator unavailable | recoverable | 546.2 / 79.3 / 1.3 | 178.1 / 2.9 | the policy refuses S1; both use S3 |

**Interpretation.** On the two announced cases, the predictive baseline's lead is prevention with observable lead time. On the unannounced cases, most of the difference comes from the local policy's assumed 120 s manual delay, not from foresight. That delay is a scenario assumption, so these rows do not show that prediction helps. This predictive baseline is the comparator that LIFELINE controllers must beat later (P17+); it is not a LIFELINE result.

The tiny-feeder predictive choice equals exhaustive enumeration of every feasible end configuration (24 configurations) with and without an announced L2 loss.

## Grid2Op profile acceptance (`grid2op-l2rpn-case14-sandbox-v1`)

| Item | Value |
| --- | --- |
| Environment / backend / classes | `l2rpn_case14_sandbox` (bundled test data), `PandaPowerBackend`, `PlayableAction_…`, `CompleteObservation_…`; 5-minute steps, 575-step episodes |
| Legality mapping | two line changes in one step → `illegal_action`; line cooldown → `cooldown_active` refused before submission, and Grid2Op itself flags it illegal when submitted |
| Termination | three successive disconnections → `BackendError` (power flow diverged) captured; any later step or observation raises `episode_terminal` |
| Do-nothing episode | 575 steps, `episode_complete`, max ρ 0.913, 6.6 s |
| Restart / fork | `reset(seed, chronic)` replays identically; `fork()` (`env.copy`) gives identical observations |
| Restoration | `not_simulated`: Grid2Op results and coupled-backend restoration results stay labeled separately |

## Limits

- Delays, dwell, reserve, costs, shedding order and the S2/S3 incompatibility are scenario assumptions. Forecasts are exact, scenario-supplied events; forecast qualification is P10.
- The predictive baseline uses bounded candidate plans (singles and cross-kind pairs). It is exhaustive only on the tiny feeder. It runs at about 55–107 s per 900 s episode on the host.
- The transition check enforces thermal limits only; voltage enters through relief rules and the objective.
- Protection is a steady-state overcurrent timer (1.2 loading for 30 s), not a protection-coordination study.
