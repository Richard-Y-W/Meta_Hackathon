# LIFELINE Coordinated Resilience — Implementation Plan P11–P16

> **For agentic workers:** Use `superpowers:executing-plans`; work inline unless separately authorized. Preserve local control and evaluate every new coupling against an independent control. P11–P14 are qualified (Nov 1–2); P15–P16 are planned.

**Goal:** Build the coupled power–water–communications town and demonstrate measured prevention, mitigation and recovery.

**Architecture:** A multi-rate orchestrator connects qualified domain models through explicit physical/resource/control dependencies. A shared plan evaluator compares independent control, conventional joint control and Meta-assisted joint control.

**Tech stack:** Qualified Python domain engines, Node orchestration, the common contracts, Mininet or a separately labeled modeled communications adapter, browser JavaScript/SVG.

**Depends on:** P02, P04–P10. [Design](../specs/2026-11-01-lifeline-infrastructure-design.md) defines interfaces, authority and time.

## P11 — Coupled state, clocks and resource conservation

**Files:** Create `runtime/infra/coupling.py`, `runtime/infra/clock.py`, `runtime/infra/worker.py`, `runtime/infra/tests/test_coupling.py`, `test_clock.py`, `fixtures/lifeline/infra/town/dependencies.json`, `fixtures/lifeline/infra/town/development.json`. Extend `src/lifeline/kernel/services.mjs`.

- [x] Declare every edge's mechanism, units, delays, uncertainty and evidence: power-to-pump, pump-to-electrical-load, power-to-communications, communications-to-remote-control, facility reserves and shared backup resources.
- [x] RED: a pump cannot deliver hydraulic work indefinitely without electrical supply; battery-supported communications must continue until reserve exhaustion; losing telemetry must not falsely report physical failure.
- [x] GREEN: implement coupled updates with explicit iteration/step tolerances. Preserve water/energy balances and account for all sources, sinks, losses and shared allocations.
- [~] Implement real-time hybrid and accelerated modeled modes as distinct profiles. *(Profiles and charged latency done; the town has run only in accelerated modeled mode.)* Charge decision/solver/action latency using the frozen clock mapping.
- [x] Test a 15-second provider delay at 60×: the decision becomes available no earlier than 900 simulated seconds later. Test zero hidden pauses and continued local control.
- [x] Remove individual edges, lengthen reserves, reverse an irrelevant edge, and add a common-cause hazard. Verify the cascade follows the equations, not a scripted incident label.
- [~] Test step-size sensitivity, solver-order sensitivity, checkpoint/restore, out-of-order telemetry, command loss and nonconvergence. *(All except acknowledgement loss after delivery, which is not modeled.)* Distinguish emulator infrastructure failure from action-caused infeasibility.
- [x] Retain a no-intervention coupled trace with a developing secondary service loss and an intervention trace that changes that path.

**Analytic controls:**

```python
self.assertAlmostEqual(pump_w, rho * g * flow_m3s * head_m / efficiency)
self.assertAlmostEqual(next_volume_m3, volume_m3 + net_flow_m3s * dt_s)
self.assertEqual(command_status_without_control_path, "unconfirmed")
self.assertTrue(local_protection_remained_enabled)
```

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p test_coupling.py` and the same command with `test_clock.py`.

**State (Nov 1):** `qualified` with open items in [P11 run 0](../../trials/lifeline-infra-p11-run-0.md).

**Gate:** At least two independently qualified causal edges produce measurable cross-domain effects; the three-domain town has no label-driven service failures.

## P12 — Joint plans and resource-aware intervention search

**Files:** Extend `src/lifeline/kernel/plans.mjs`, `coordinator.mjs`, `forecast.mjs`. Create `src/lifeline/kernel/planner.mjs`, `test/lifeline/infra/planner.test.mjs`, `fixtures/lifeline/infra/town/plan-controls.json`.

- [x] Define an action DAG with preconditions, duration, resources, intermediate constraints, cancellation points and effect checks. Include retain-policy and probe-only candidates.
- [x] RED: reject double allocation of a generator, restoring a pump before its supply is available, a late command, and a plan with individually feasible but jointly infeasible actions.
- [x] GREEN: enumerate bounded plan templates, simulate candidates from admitted estimated state, and rank by frozen service policy, constraint outcomes, cost and uncertainty.
- [x] Test a beneficial cross-domain tradeoff: temporarily shift permitted pump demand using measured storage to preserve an electrical reserve, then restore pumping before its service constraint is breached.
- [x] Test the opposite case where low storage makes that action harmful. The planner must choose differently from observed state rather than the scenario name.
- [x] Inject a second fault between actions. Expire the remainder, read actual state and replan without inventing atomic rollback.
- [x] Bound candidate count, horizon, solver work and wall time. A search overrun returns the best admitted plan or retains policy; it cannot monopolize the fast controller.

**Run:** `node --test test/lifeline/infra/planner.test.mjs test/lifeline/infra/plans.test.mjs`.

**State (Nov 1):** `qualified` in [P12 runs 0–1](../../trials/lifeline-infra-p12-run-0.md); `planner.mjs` holds timed execution (coordinator/forecast not extended).

**Gate:** Candidate outcomes, costs and transitions are independently checkable; cross-domain plans are valid beyond per-domain feasibility.

## P13 — Strong coordinated conventional comparator

**Files:** Create `src/lifeline/controllers/joint.mjs`, `runtime/infra/baselines.py`, `runtime/infra/tests/test_baselines.py`, `test/lifeline/infra/joint-controller.test.mjs`, `fixtures/lifeline/infra/town/baseline-policy.json`.

- [x] Implement independent domain control, a simple coordinated priority policy, and a rolling-horizon joint optimizer using admitted observations/forecasts.
- [x] RED: the joint baseline must solve known tiny allocation/scheduling optima and must not be beaten by a trivial feasible action because a capability was withheld.
- [x] GREEN: use the same dependency catalog, capabilities, observation ages, execution path and budgets as the proposed system. Include state/parameter estimation and uncertainty handling appropriate to the task.
- [x] On small finite cases compare with exhaustive feasible search. On larger cases record termination, objective bounds/gaps where available, incumbent solution and timeout behavior.
- [x] Tune only on development cases, retaining the same development allowance as the AI system. Lock settings before qualification.
- [x] Measure independence versus coordination separately from conventional versus Meta. If the conventional joint controller obtains the gain, attribute it to coordination.
- [x] Maintain a private perfect-information ceiling for headroom analysis, labeled as an oracle and never treated as a deployable comparator.

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p test_baselines.py`; `node --test test/lifeline/infra/joint-controller.test.mjs`.

**State (Nov 2):** `qualified` in [P13 runs 0–7](../../trials/lifeline-infra-p13-run-0.md): locked comparator `hybrid` (rules in parallel with the rolling optimizer); oracle ceiling retained.

**Gate:** A competent conventional joint controller passes analytic and domain controls. LIFELINE does not earn a novelty claim by beating isolated controllers only.

## P14 — Meta-assisted investigation and joint decisions

**Files:** Create `src/lifeline/controllers/meta-joint.mjs`, `src/lifeline/kernel/model-store.mjs`, `test/lifeline/infra/meta-joint.test.mjs`, `model-store.test.mjs`, `fixtures/lifeline/infra/meta-prompt-v1.txt`. Reuse provider transport and P01 time budgets.

- [x] RED: invalid evidence IDs, unsupported actions, invented units, hidden-state fields and expired responses cannot reach execution.
- [x] GREEN: request competing explanations, a discriminating test or observation, candidate plans, predicted service effects and explicit falsifiers. Feed only the admitted evidence packet and capability catalog.
- [x] Maintain structured parameter/dependency hypotheses with evidence, versioning, contradiction checks and expiry. Read an unknown value as unknown.
- [x] Bound investigation by the remaining opportunity for an effective intervention: conservative loss time minus current time, actuation duration and uncertainty margin. Test an early useful probe, a late correct diagnosis and a probe whose cost exceeds its decision benefit. Log the deadline calculation and re-evaluate it when state changes.
- [x] Evaluate Meta and conventional candidates through the same planner/guard; preserve conventional control while the model works.
- [x] Test a correct but late diagnosis, confidently wrong explanation, contradictory new evidence, missing sensor, two overlapping incidents and provider interruption.
- [x] Retain at least one live Meta decision that changes a probe or admitted action. An explanation generated after a predetermined action does not qualify participation.
- [x] Compare model-off, model-as-narrator, model-as-investigator and complete Meta control on development cases; use these to debug contribution, not to select favorable held-out results.

**Run:** `node --test test/lifeline/infra/meta-joint.test.mjs test/lifeline/infra/model-store.test.mjs`.

**State (Nov 2):** `qualified` in [P14 runs 0–5](../../trials/lifeline-infra-p14-run-0.md): one live model decision changed an admitted action (run 4); against comparator revision 2 the model added latency, not value.

**Gate:** Live evidence ties model output to a real decision and measured consequence; added performance remains a separate empirical question.

## P15 — Town interface and experiment controls

**Files:** Create `public/lifeline-town.html`, `public/lifeline-town.js`, `public/lifeline-town.css`, `src/lifeline/infra-http.mjs`, `test/lifeline/infra/http.test.mjs`. Modify `server.mjs` to add the new route while preserving the existing `/lifeline` demo.

- [ ] RED: stale run IDs, reconnects, a dead worker, partial action and operator stop must have accurate visible states.
- [ ] Implement three linked views: critical service delivery/reserves; physical assets/dependencies; evidence/forecast/action timeline. Show predicted and observed effects separately.
- [ ] Provide admitted judge faults for line/feeder loss, pump unavailability, link degradation and missing telemetry. Each command records request and actual effect time.
- [ ] Show live/replay/modeled mode, time scale, provider state, baseline comparison, intervention cost, constraints and uncertainty.
- [ ] Tie essential-service strips to independent measurements, not controller commentary. Export the run manifest, receipts, forecasts and score.
- [ ] Exercise keyboard controls, readable contrast, narrow layouts, reconnection and evidence export in the browser. Capture actual states; cosmetic spacing does not need unit tests.
- [ ] Keep simulator/backend details in an inspection panel. The main view answers what is threatened, what action is proposed, and what happened.

**Run:** `node --test test/lifeline/infra/http.test.mjs`; then browser verification against the qualified local town route.

**Gate:** A viewer can distinguish measured preservation, predicted risk and unsupported state without reading source code.

## P16 — Coupled demonstration and release gate

**Files:** Create `scripts/lifeline-infra-run.mjs`, `scripts/lifeline-infra-replay.mjs`, `docs/demo/lifeline-town-demo.md`, `docs/releases/lifeline-town-release.md`, `test/lifeline/infra/replay.test.mjs`.

- [ ] RED: replay must detect a changed workload, reordered action receipt, altered clock mapping and a score copied from another run.
- [ ] GREEN: replay recomputes scores and validates provenance without contacting the provider or changing the retained bundle.
- [ ] Rehearse a developing threat with useful lead time, a second surprise failure, an unrecoverable case, and provider/control-channel interruption.
- [ ] Retain matching independent-controller and joint-conventional comparisons. State whether the benefit came from coordination, Meta, both or neither.
- [ ] Choose an understandable three-minute presentation cut from retained evidence; exact submission duration remains governed by the accepted portal. Compress presentation only, labeling replay speed.
- [ ] Rebuild the smallest town in a fresh SSD-backed environment and verify the release instructions. Record a narrated video and publishing/portal decisions as owner dependencies.
- [ ] Update README, claims and run register together. Disclose the original Blackbox Apprentice code and communications V1 lineage.

**Run:** `node --test test/lifeline/infra/replay.test.mjs`; then `node scripts/lifeline-infra-replay.mjs --run artifacts/lifeline/infra/town-release-run-0 --verify` after that bundle exists.

**Gate Q3:** A measured three-domain prototype and reproducible demonstration exist. A compelling scene does not qualify B1–B5 without the research comparisons.

## Flagship sequence and causal checks

| Beat | Visible event | Required evidence |
| --- | --- | --- |
| Normal town | Services and finite reserves operating | No-fault control and fixed demand |
| First threat | Electrical fault or observable deteriorating margin | Timestamped permitted fault/observation |
| Anticipation | Predicted secondary loss and candidate actions | Forecast made before that loss; uncertainty and lead time |
| Intervention | Cross-domain action with cost | Guard, actual command/receipt and measured effect |
| Surprise | Pump/link/telemetry failure | Judge selection retained; no advance controller access |
| Adaptation | Changed plan and service trajectory | New evidence, expired old plan and actual outcome |
| Comparison | Service deficit versus matched conventional runs | Same initial state, demands, faults, policy and honest timing |

The demonstration can be successful as an engineering prototype while the AI comparison is tied or negative. Preserve that distinction in every release.
