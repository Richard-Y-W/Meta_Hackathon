# LIFELINE Research, Breadth and Deployment — Implementation Plan P17–P31

> **For agentic workers:** Use `superpowers:executing-plans`; work inline unless separately authorized. Every study and deployment stage has its own entry gate. An unsuccessful study can finish without qualifying its proposed claim.

**Goal:** Test the breakthrough hypotheses, extend qualified infrastructure breadth, and establish practical benefit through staged operator and site evidence.

**Architecture:** Frozen evaluations compare matched controllers; model learning is isolated from trusted constraints; each new adapter uses the common lifecycle; authority advances from observation to bounded action only within a named qualification envelope.

**Tech stack:** Qualified infrastructure engines and existing Node/Python stack; additional process/transport/lab tools are admitted through P23–P27 capability checks.

**Authority:** [Master](2026-10-31-lifeline-program.md), [design](../specs/2026-11-01-lifeline-infrastructure-design.md), [evaluation and breakthrough criteria](../../research/lifeline-infrastructure-evaluation.md). All P tasks remain planned.

## P17 — Freeze a benchmark that can distinguish the claims

**Entry:** P13 baseline qualification; development traces from each required domain.

**Files:** Create `fixtures/lifeline/infra/protocol-research-v1.json`, `scripts/lifeline-infra-freeze.mjs`, `test/lifeline/infra/protocol.test.mjs`, `docs/research/lifeline-infrastructure-dataset-card.md`.

- [x] RED: detect graph-isomorphic split overlap, derivative fault schedules, hidden truth in prompts and a case selected after seeing AI outcomes.
- [x] GREEN: freeze families, held-out topology/dependency/mechanism splits, primary estimand, margins, budgets, controller identities, randomized order, invalid-run rules and stop rule.
- [x] Select sample size from development variance at the scenario-family level, record precision/power assumptions, and freeze before revealing outcomes.
- [x] Include no-fault, impossible recovery, false alarm, partial observation, known-model optimum and zero coordination benefit controls.
- [x] Preserve commitment hashes and a separate evaluator-private manifest. The public dataset card describes generation without exposing future fault schedules to controllers.

**Run:** `node --test test/lifeline/infra/protocol.test.mjs`.

**Gate:** The suite is immutable, adequately discriminating and free of known leakage. A pilot cannot be promoted to held-out evidence by renaming it.

**State (Nov 3):** `qualified` ([run 0](../../trials/lifeline-infra-p17-run-0.md)). Frozen at `cc9fe67`, 16 groups, 10 families; known-model optimum is the latency-free oracle (headroom only).

## P18 — Run the primary held-out comparison

**Files:** Create `scripts/lifeline-infra-evaluate.mjs`, `runtime/infra/analysis.py`, `runtime/infra/tests/test_analysis.py`, `docs/trials/lifeline-infrastructure-comparison-run-0.md`.

- [x] RED: aggregation must count failed actions, provider timeouts, unrecovered episodes and all declared first attempts. Test paired signs and cluster weighting on hand-calculated data.
- [x] GREEN: compare independent, coordinated conventional and Meta-assisted controllers using identical offered demands, faults, authority and clock rules.
- [x] Retain per-service effects, paired uncertainty intervals, intervention/resource costs, constraint events, worst-family outcomes and headroom.
- [x] Apply the frozen stop/invalid-run rules without tuning. If resources run out, mark the study incomplete and report the partial batch.
- [x] Classify each proposed B claim independently as supported within scope, tied/inconclusive or contradicted.

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p test_analysis.py`; `node scripts/lifeline-infra-evaluate.mjs --protocol fixtures/lifeline/infra/protocol-research-v1.json --out artifacts/lifeline/infra/research-v1`.

**Gate:** A complete interpretable comparison; statistical success is not required to complete the experiment.

**State (Nov 3):** `complete` ([run 0](../../trials/lifeline-infrastructure-comparison-run-0.md)). B2 not supported (contradicted vs independent, inconclusive vs hybrid), B5 contradicted, B1 exploratory signal only; the Meta model changed no decision (0/17 calls); layout-C groups had no headroom.

## P19 — Identify what caused any benefit

**Files:** Create `fixtures/lifeline/infra/protocol-ablation-v1.json`, `docs/research/lifeline-infrastructure-ablation-report.md`. Extend `test/lifeline/infra/protocol.test.mjs`.

- [ ] Freeze model-off, narrator-only, no-coupling, no-forecast, no-active-probe, fixed-model, no-memory, fixed-cadence-investigation, and matched-latency variants.
- [ ] RED: disabling one mechanism must not secretly remove baseline recovery or change available sensors/actions.
- [ ] GREEN: run matched interventions and resource accounting; isolate coordination, diagnosis, planning, memory and latency effects.
- [ ] Include a conventional controller with an equal computation allowance and an appropriate adaptive-estimation baseline.
- [ ] If the gain vanishes when budgets/information match, revise the claim. If Meta adds only explanation quality, report that measured result separately from service preservation.

**Run:** protocol tests, then the P18 evaluator using the ablation protocol.

**Gate:** An evidence-backed mechanism attribution, including negative findings. B2 cannot be credited to Meta merely because a joint planner outperforms independent control.

## P20 — Discover an unfamiliar mechanism

**Entry:** P19; a documented limitation of the structured model.

**Files:** Create `src/lifeline/kernel/model-induction.mjs`, `runtime/infra/model_sandbox.py`, `test/lifeline/infra/model-induction.test.mjs`, `runtime/infra/tests/test_model_sandbox.py`, `fixtures/lifeline/infra/protocol-induction-v1.json`.

- [ ] Define a held-out mechanism family that cannot be expressed by adjusting existing known parameters alone.
- [ ] RED: reject generated code that accesses credentials, network, evaluator files, forbidden imports, unbounded execution or authoritative constraints.
- [ ] GREEN: propose a new state/transition representation, backtest it on admitted history, select a discriminating experiment, and require forward predictive validation before use.
- [ ] Compare structured adaptation, adaptive system identification, a Schema-style persistent-model loop and the proposed extension under matched observations/compute.
- [ ] Measure prediction and service outcomes, probe cost, time to adaptation and harmful model revisions. A correctly named failure is insufficient.
- [ ] If a fixed model or conventional estimator solves the cases equally well, retain the simpler method and reject the mechanism-discovery claim.

**Run:** `node --test test/lifeline/infra/model-induction.test.mjs`; `python3 -m unittest discover -s runtime/infra/tests -p test_model_sandbox.py`; frozen induction evaluation.

**Gate B3:** Improvements survive the mechanism holdout and appropriate baselines. A reimplementation is labeled as such; it is not automatically a direct comparison with the authors' system.

## P21 — Transfer across layouts, dependencies and domains

**Entry:** P20 for learned-model transfer; P03/P11 for shared-core transfer. New-domain transfer additionally requires an independently qualified P23–P25 adapter.

**Files:** Create `fixtures/lifeline/infra/protocol-transfer-v1.json`, `test/lifeline/infra/transfer.test.mjs`, `docs/research/lifeline-transfer-report.md`.

- [ ] Freeze the core, prompt templates and model memory before opening the transfer split. Record allowed adapter engineering and developer hours.
- [ ] RED: reject incident-specific rules or answers embedded in a capability catalog, prompt, adapter or retrieved document.
- [ ] GREEN: run disjoint topology, dependency, parameter and mechanism transfers separately. Strong new-domain claims use an entire held-out domain profile.
- [ ] Compare no-memory, relevant-memory, wrong-domain-memory, domain-specialized controllers and established adaptive approaches.
- [ ] Measure service, calibration, trials/probes to competence, development effort and negative transfer. Preserve failures rather than selecting only transferable incidents.

**Run:** `node --test test/lifeline/infra/transfer.test.mjs`; frozen transfer evaluation.

**Gate B4:** Shared-core reuse is supported by conformance; useful learned transfer requires improved measured outcomes or adaptation cost. Those are different claims.

## P22 — Scale, disturbance robustness and multiple authorities

**Files:** Create `fixtures/lifeline/infra/protocol-stress-v1.json`, `scripts/lifeline-infra-stress.mjs`, `test/lifeline/infra/isolation.test.mjs`, `docs/research/lifeline-scale-envelope.md`.

- [ ] RED: a solver/model overload, telemetry flood, stale grant or disconnected remote coordinator cannot starve local control or widen authority.
- [ ] GREEN: profile increasing assets, dependencies, service flows, simultaneous incidents and candidate plans; record the first capacity/latency failure.
- [ ] Test correlated hazards, unknown observation bias, sensor loss, command delay, model outage, wrong model and incomplete dependency maps.
- [ ] Add separate utility authority scopes and limited information sharing. A coordinator must handle a refused action and asynchronous approval without assuming global control.
- [ ] Compare equal-resource controllers and repeat selected cases on a second qualified host or backend. Declare where simulator fidelity or resource limits fail.

**Run:** `node --test test/lifeline/infra/isolation.test.mjs`; the stress CLI with the frozen stress manifest.

**Gate B5/Q4:** Report only the measured size, timing, disturbance and authority envelope. A single laptop result is not national-scale resilience.

## P23 — Water-treatment process profile

**Entry:** P08/P09/P11 and a documented process-model review.

**Files:** Create `runtime/infra/treatment.py`, `runtime/infra/tests/test_treatment.py`, `src/lifeline/domains/treatment.mjs`, `fixtures/lifeline/infra/treatment/profile.json`, `docs/research/lifeline-treatment-model-card.md`.

- [ ] Select a concrete process train and service output with a domain reviewer: source/pretreatment, a specified treatment unit, buffer/storage and delivery. Record actual modeled phenomena and omitted chemistry.
- [ ] Audit candidate models such as WaterTAP/IDAES for the chosen unit's transient behavior, state, initialization and validity; static design optimization alone does not qualify incident response.
- [ ] RED: reject mass/energy imbalance, output counted as usable despite failed quality criteria, and actions outside calibrated process ranges.
- [ ] GREEN: qualify residence/buffer dynamics, unit loss, power dependence, uncertain influent, sensor failure and recovery using analytic cases plus independent process data or references.
- [ ] Compare local/interlocked control and process MPC before Meta. Begin in simulation/recommendation mode; chemical or plant actuation requires site-specific qualification later.

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p test_treatment.py`.

**Gate Q5-treatment:** A named process profile with validated outputs. WNTR distribution results alone cannot satisfy this gate. [WaterTAP model library](https://watertap.readthedocs.io/en/stable/).

## P24 — Transportation and repair logistics

**Files:** Create `runtime/infra/transport.py`, `runtime/infra/repair.py`, `runtime/infra/tests/test_transport.py`, `test_repair.py`, `src/lifeline/domains/transport.mjs`, `fixtures/lifeline/infra/transport/profile.json`.

- [ ] Define road accessibility, travel times, crews, skills, parts, repair duration/precedence and shared fuel. Use a simple verified travel model first; qualify SUMO only where traffic dynamics affect the question.
- [ ] RED: no crew can occupy two sites, traverse a closed link, finish before arrival or repair without required parts.
- [ ] GREEN: coordinate feasible travel/repair sequences with power/water/communications dependencies; count disruption caused by repair operations.
- [ ] Compare shortest-job/criticality heuristics, scheduling optimization and the proposed controller on held-out road/asset disruptions.
- [ ] Retain common-cause access failures, unavailable crews, uncertain repair duration and restored-access controls.

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p test_transport.py`, then `test_repair.py`.

**Gate Q5-transport:** Measured restoration benefit with realistic resource/time constraints. [SUMO documentation](https://eclipse.dev/sumo/docs/).

## P25 — Facility continuity and further adapter admission

**Files:** Create `src/lifeline/domains/facilities.mjs`, `runtime/infra/facilities.py`, `test/lifeline/infra/facilities.test.mjs`, `fixtures/lifeline/infra/facilities/profile.json`, `docs/research/lifeline-adapter-admission.md`.

- [ ] Define synthetic hospital/shelter/data-center service dependencies, finite backup energy/water, restart delays and facility-specific usability thresholds.
- [ ] RED: component availability cannot count as a functioning facility when another necessary service or reserve is absent.
- [ ] GREEN: implement explicit service composition and compare reserve allocation or demand scheduling against a conventional facility policy.
- [ ] Test correlated supply loss, depleted backup, contradictory priorities, refrigeration/cooling constraints where modeled and recovery sequencing.
- [ ] Define the admission checklist for later district heating, manufacturing, food/cold-chain or other infrastructure: physics/process model, observations, actions, comparator, independent score and domain review. Each extension gets its own task and gate before a claim.

**Run:** `node --test test/lifeline/infra/facilities.test.mjs` plus the profile's declared numerical checks.

**Gate Q5-facilities:** Qualified synthetic service composition; operational continuity is not a claim about patient outcomes or lives saved.

## P26 — Operator study and workflow

**Entry:** P16 and access to consenting participants through an authorized study.

**Files:** Create `docs/research/lifeline-operator-study.md`, `fixtures/lifeline/infra/operator-tasks.json`, `test/lifeline/infra/operator-flow.test.mjs`. Extend `src/lifeline/infra-http.mjs` and town UI.

- [ ] Predeclare tasks, participant roles, randomization/counterbalancing, permitted data and success measures.
- [ ] RED/GREEN: approval must bind to the displayed plan; cancellation, changed conditions and manual override invalidate outstanding authority.
- [ ] Compare existing workflow, conventional recommendations and LIFELINE on decision time, error rate, false alarms, service outcomes and explanation usefulness.
- [ ] Test misunderstanding of uncertainty, stale data and model attribution. Retain negative feedback and redesign failed interactions.
- [ ] Separate usability findings from field effectiveness; synthetic tasks cannot establish real-world outcome improvements.

**Run:** `node --test test/lifeline/infra/operator-flow.test.mjs`; execute the frozen study when participants and access are available.

**Gate B6-study:** Measured operator-task benefit with limitations and participant scope.

## P27 — Isolated hardware-in-the-loop lab

**Files:** Create `runtime/lab/bridge.py`, `runtime/lab/tests/test_bridge.py`, `docs/lab/lifeline-hil-protocol.md`, `fixtures/lifeline/lab/envelope.json`.

- [ ] Choose an isolated bench: hardware network, instrumented low-energy pump/storage rig, and an electrical emulator or appropriately isolated test equipment.
- [ ] RED: lost communications, invalid setpoint, stuck actuator and failed readback must produce the declared local fallback, not assumed success.
- [ ] GREEN: qualify timing, sensors, noise, calibration, local override, interruption and physical effect receipts.
- [ ] Replay matched disturbances against conventional control; compare simulation predictions with measurements and document model mismatch.
- [ ] Keep public utilities and essential services outside this lab envelope.

**Run:** `python3 -m unittest discover -s runtime/lab/tests -p test_bridge.py`, then the approved lab protocol with actual instrument records.

**Gate Q6:** Isolated hardware behavior and operator workflow qualified; simulation success alone does not qualify this stage.

## P28 — Read-only shadow pilot

**Files:** Create `runtime/site/telemetry_bridge.py`, `runtime/site/tests/test_read_only.py`, `docs/pilots/lifeline-shadow-protocol.md`, `docs/pilots/lifeline-data-boundary.md`.

- [ ] Define a named partner/site, allowed telemetry, retention, credentials, owners, incident workflow and model-validity envelope.
- [ ] RED/GREEN: the deployed shadow process has no actuation capability; test denied mutations and revoked credentials.
- [ ] Measure alert lead time, calibration, missed events, false alarms, availability and recommendation feasibility over the prespecified window.
- [ ] Compare against the site's actual monitoring/workflow. Label hypothetical action benefits as counterfactual estimates, not observed preservation.
- [ ] Review drift and information leakage; retire unsupported recommendations.

**Run:** `python3 -m unittest discover -s runtime/site/tests -p test_read_only.py`; site-specific shadow acceptance checks.

**Gate Q7-shadow:** Operational observation evidence at one named site.

## P29 — Assisted operation with explicit approvals

**Files:** Create `runtime/site/approval_bridge.py`, `runtime/site/tests/test_approval.py`, `docs/pilots/lifeline-assisted-protocol.md`.

- [ ] Specify exact approved action classes/assets, responsible operator, change windows, effect checks, escalation and stop conditions.
- [ ] RED/GREEN: changed, expired or replayed approvals cannot actuate; revocation and local override take precedence.
- [ ] Start with operator-reviewed recommendations; introduce only qualified actions after site acceptance.
- [ ] Measure accepted/rejected suggestions, intervention latency, actual service effects, unintended consequences and operator burden.
- [ ] Retain every recommendation and outcome; favorable selections alone cannot establish overall benefit.

**Run:** `python3 -m unittest discover -s runtime/site/tests -p test_approval.py`; the named site's acceptance protocol.

**Gate Q7-assisted:** Site-scoped assisted operation, separate from autonomous operation.

## P30 — Bounded authority and maintained operations

**Files:** Create `runtime/site/authority.py`, `runtime/site/tests/test_authority.py`, `docs/operations/lifeline-operating-envelope.md`, `docs/operations/lifeline-incident-and-upgrade-runbook.md`.

- [ ] Define narrow action/asset/time limits backed by P27–P29 evidence and site acceptance. Broader model capability does not widen permissions.
- [ ] RED/GREEN: fail closed on expired authority, configuration drift and unsupported state; local protective functions remain independent.
- [ ] Qualify staged rollout, manual override, monitoring, provider outage, software/model update rollback, audit retention and recovery.
- [ ] Requalify changes affecting constraints, models, prompts, timing or equipment. Track operational incidents and regressions.
- [ ] Report service outcomes and costs over the complete declared window.

**Run:** `python3 -m unittest discover -s runtime/site/tests -p test_authority.py`; site-specific operating-envelope acceptance.

**Gate Q8:** Bounded authority at the named site and configuration, not universal infrastructure autonomy.

## P31 — Reproducible research and product release

**Entry:** P18/P19/P22 for research; deployment claims additionally require their own completed site gates.

**Files:** Create `fixtures/lifeline/infra/release-v1.json`, `scripts/lifeline-infra-release-check.mjs`, `docs/releases/lifeline-infrastructure-release.md`, `docs/research/lifeline-infrastructure-claims.md`, `docs/operations/lifeline-maintenance.md`.

- [ ] RED: release checks reject missing attempts, unsupported claims, unpinned inputs, unlicensed redistribution, inconsistent protocol hashes and secrets.
- [ ] GREEN: rebuild the declared scope from a clean SSD-backed environment and replay scores independently.
- [ ] Publish a capability/claim matrix with exact domains, sizes, disturbances, clocks, baselines and limitations; include negative and tied results.
- [ ] Prepare reproducible benchmark/paper assets and disclose prior work, generated components and project lineage. Publishing remains an owner decision.
- [ ] Assign maintenance, compatibility, regression and evidence-retention responsibilities. Preserve old versions and migration paths.

**Run:** `node scripts/lifeline-infra-release-check.mjs --manifest fixtures/lifeline/infra/release-v1.json` after implementing the checker and the release manifest.

**Gate Q9:** A reproducible release with claims matching evidence. The program remains living as new domains and operating envelopes are qualified.
