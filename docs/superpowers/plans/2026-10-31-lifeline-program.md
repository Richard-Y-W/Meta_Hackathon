# LIFELINE Living Program and TDD Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Work inline unless delegation is separately authorized. Follow red/green/refactor cycles, inspect unexpected failures before changing behavior, and attach observed evidence before checking a box.

**Goal:** Build and qualify an emergency communications system that investigates compound network failures and preserves essential message delivery, then extend the qualified approach to broader resilience problems.

**Architecture:** A Node supervisor coordinates telemetry, a conventional controller, a Meta investigator, bounded forecasts, guarded actions, and an append-only evidence ledger. An isolated Python/Mininet worker runs actual packet traffic. An independent scorer and frozen comparison protocol determine which performance claims are supported.

**Tech stack:** Existing Node.js ES modules, `node:test`, native browser JavaScript/SVG, Python standard-library adapter/tests, Linux, Mininet, Open vSwitch, and Meta Model API. No frontend framework migration or model training is required for the first release.

**Planning date:** October 31, 2026. **Implementation baseline:** `d12459829cce71d65771c2a85236d46800bdfe1d`.

**Design:** [Emergency communications design](../specs/2026-10-31-lifeline-design.md).
**Evaluation:** [Frozen-comparison protocol](../../research/lifeline-evaluation-protocol.md).
**Evidence and progress:** [Run register](../../trials/lifeline-run-register.md).

## 0. SSD workspace and storage rule

**Owner requirement:** All project-created files and project-controlled runtime data belong on the external SSD. The canonical macOS repository is `/Volumes/PortableSSD/Meta_Hackathon`. A home-directory alias is only a compatibility symlink to that directory; never recreate it as an internal-drive checkout.

Before writing, installing dependencies, creating an environment, starting a build, provisioning a VM, or running an experiment, confirm that `/Volumes/PortableSSD` is mounted and resolve the physical working directory. Use the canonical SSD path for host commands. If the SSD is unavailable, stop with `storage_unavailable`; do not create a replacement directory under `/Volumes`, the home directory, Downloads, Desktop, or the internal drive.

| Project material | Required host storage |
| --- | --- |
| Source, tests, plans, configuration and Git history | `/Volumes/PortableSSD/Meta_Hackathon/` |
| Dependencies and native environments | Repository-local directories or `.work/environments/` on the SSD |
| Package/model caches and downloaded inputs | `.work/cache/` and `.work/downloads/` on the SSD |
| Temporary project files, build products and logs | `.work/tmp/`, `.work/build/` and `.work/logs/` on the SSD |
| Packet captures, evaluation outputs and retained evidence | `artifacts/lifeline/` on the SSD |
| Additional checkouts and worktrees | `.work/worktrees/` on the SSD |
| VM disks, snapshots and container-engine storage | `.work/vm/` and `.work/containers/` on the SSD |

Paths beginning with `.work/` or `artifacts/` are relative to the canonical repository. Keep generated working data ignored by Git. Configure each tool's cache, download, temporary-file and output locations before using it; a repository on the SSD does not by itself redirect tool defaults from the internal drive. Do not change `HOME` or `CODEX_HOME`, or move unrelated user data.

The SSD is currently ExFAT. Dependencies or runtime objects needing native Linux permissions, symlinks, or Unix sockets must run inside the Linux VM's native filesystem, with every writable VM disk and snapshot stored on this SSD. The guest may use paths such as `/workspace/Meta_Hackathon`; preflight must record their mapping to the SSD-backed VM disk. Guest `/run` or `/tmp` may use guest RAM or that disk. An APFS development volume, if needed for Mac-native tooling, must likewise use an image stored on the SSD. Do not use an internal-drive VM/container disk as a fallback.

Task 1 must qualify storage before other runtime provisioning: record the physical repository, cache and output roots, available space, and VM/container backing-file paths. Test missing-mount, internal-path fallback, and symlink-escape cases. Paths supplied by a model, tool default, or environment setting cannot override this storage requirement.

The root [AGENTS.md](../../../AGENTS.md) repeats this requirement for future coding sessions. Read-only references to other existing projects, such as an earlier project's style examples, do not authorize creating LIFELINE outputs there.

## 1. How this plan stays alive

This file owns scope, task order, dependencies, and completion gates. The design owns behavior and interfaces. The evaluation protocol owns scoring and comparisons. The run register owns observed outcomes, blockers, decisions, and the next executable task. Update all affected documents in the same change when their contracts change.

Use `planned`, `active`, `blocked`, `qualified`, or `superseded` for task state. An unchecked task is not qualified. A precise failure can complete an investigation, but it does not qualify the capability that failed.

For each implementation task:

1. Record the starting commit and any dirty files that must be preserved.
2. Add a focused behavioral test and observe its intended RED. A syntax error, missing test dependency, or unavailable host is not the intended behavioral failure.
3. Implement the smallest behavior that satisfies the contract.
4. Run focused GREEN and the named negative controls; refactor only while those remain green.
5. Record commands, result, commit, artifact paths, remaining limits, and the next task in the run register.
6. Run `git diff --check`, review the change, and commit the qualified increment during implementation.

Do not check a box for a stub, mocked packet result, proposed experiment, unrun test, or attractive screenshot. Unit tests establish contracts; emulator tests establish packet behavior; live Meta traces establish provider use; comparisons establish measured benefit. Those evidence levels are distinct.

### Current state

| Area | State on October 31 | Evidence or next requirement |
| --- | --- | --- |
| Legacy device demo | Implemented at baseline commit | Existing code and prior review; not a LIFELINE result |
| Domain selection | Confirmed | Owner selected emergency communications |
| Architecture and program | Written planning baseline | This document and linked design |
| Linux/Mininet host | Packet runtime qualified; provider not | [Runtime run 0](../../trials/lifeline-runtime-run-0.md); G0 needs a live Meta call |
| Real packet service metrics | Qualified for fixed policy | [Packet run 0](../../trials/lifeline-packet-run-0.md) |
| Conventional network controller | Qualified (priority, adaptive) | [Baseline run 0](../../trials/lifeline-baseline-run-0.md) |
| Bounded network execution | Qualified (guard and executor) | [Guard run 0](../../trials/lifeline-guard-run-0.md), [execution run 0](../../trials/lifeline-execution-run-0.md) |
| Meta investigator | Not implemented | Tasks 8–10 |
| Comparative results | No LIFELINE runs | Tasks 11–12 |
| Live demo | Not implemented | Tasks 13–14 |
| Novelty and field benefit | Hypotheses | Tasks 12 and 16–19 |

### Definition of a complete first release

- [ ] Real application messages traverse the qualified emulator and are independently scored.
- [ ] An operator can inject two admitted failures during a running scenario.
- [ ] A conventional controller and the AI-assisted controller receive comparable information and control authority.
- [ ] A real Meta response contributes a typed diagnostic or intervention decision, with its actual outcome retained.
- [ ] Invalid, stale, partial, and failed operations have precise visible outcomes.
- [ ] The comparison report includes all declared runs and distinguishes exploratory evidence from a frozen evaluation.
- [ ] The live demo, recorded fallback, README, pitch, and result claims agree about what was measured.

## 2. Release sequence and gates

| Gate | Required result | Tasks | What may be claimed |
| --- | --- | --- | --- |
| G0 | Working Linux packet environment and usable Meta access/latency measurement | 1 | Platform feasibility only |
| G1 | Trusted metrics, actual cascade, strong conventional baseline | 2–7 | Reproducible communications resilience experiment |
| G2 | Guarded actions, interruption recovery, forecast qualification | 5–8 | Bounded controller behavior in the emulator |
| G3 | Live Meta investigation and recovery trace | 9–10 | Working AI-assisted prototype |
| G4a | Small predeclared paired comparison | 11 | Preliminary measured comparison |
| G4b | Frozen held-out suite and ablations | 12 | Narrow performance claims supported by that suite |
| G5 | Rehearsed demo and consistent submission artifacts | 13–14 | Hackathon-ready demonstration |
| G6 | Broader novelty and reliability qualification | 15–17 | Research contribution if evidence supports it |
| G7 | Operator pilot and qualified domain extension | 18–19 | Only the capabilities demonstrated by each pilot |

G4b is not required to claim a working hackathon prototype. It is required for a strong generalization claim. G5 cannot silently promote G4a into G4b.

The minimum hackathon execution path is **Tasks 1–11, then 13–14**. Task 12 is the larger research qualification and does not block interface integration or a narrowly claimed demo release. Tasks 15–19 start only when their stated entry evidence exists. Task numbers identify increments; their explicit dependencies determine execution order.

### Requirement and test traceability

| Requirement | Implementing tasks | Decisive test or retained outcome |
| --- | --- | --- |
| Actual packet execution | 1, 4 | Sender/receiver records from qualified Linux network |
| Correct service denominator | 3 | Lost, late, duplicated and untransmitted-message controls |
| No hidden-fault information | 4, 11 | Controller-view audit and scenario-boundary tests |
| Competent baseline | 7 | Known-capacity optimum controls and real recoveries |
| Bounded action authority | 2, 5 | Malformed, stale, unauthorized and over-budget rejection tests |
| Correct partial-effect handling | 6 | Lost acknowledgement, duplicate operation and failed rollback tests |
| Honest prediction limits | 8 | Analytic checks, packet residuals and unsupported-model outcomes |
| Meaningful Meta contribution | 9, 12 | Live decision trace and model-removal comparison |
| Continuous-clock adaptation | 10 | Second incident during an outstanding model call |
| Complete failure accounting | 10, 11 | Interrupted run, failed proposal and missing-capture controls |
| Measured performance and generalization | 11, 12 | Paired reports, uncertainty, frozen split and ablations |
| Visible truthful demonstration | 13, 14 | Live/replay labels, measured UI state and rehearsal artifacts |
| Broader impact and novelty | 15–19 | Appropriate research comparisons and domain/operator evidence |

## 3. Calendar and scope cuts

The organizer currently lists submission on **November 4, 2026, at 9:00 PM Eastern**. The remaining build window is approximately four days, not a fresh ten-day allocation. [Official event schedule](https://cerebralvalley.ai/e/meta-ai-developer-hackathon).

| Date | Intended outcome | Decision at end of period |
| --- | --- | --- |
| Oct 31 | Qualify Linux and Meta access; freeze contracts and service metric | If packet backend is unavailable, resolve the host before building a visual demo around it |
| Nov 1 | Real packet scenario, conventional baseline, bounded route/rate execution | Require G1 and the first G2 controls |
| Nov 2 | Meta investigation, continuous-clock operation, error recovery | If model latency or decisions are unusable, narrow the demonstrated AI role and retain that limitation |
| Nov 3 | Pilot comparisons, interface integration, feature freeze | Choose claims from observed results; stop adding domains |
| Nov 4 | Rehearse, record, verify links and artifacts | Aim for a complete submission package by 6:00 PM Eastern, leaving three hours for portal issues |

These are planning targets, not completion predictions. Tasks remain evidence-gated if the dates slip. Do not cut the competent baseline, receiver-based scoring, real provider disclosure, or failure handling to meet a visual milestone.

Cut first: physical hardware, cross-domain simulation, generated executable code, voice input, SAM integration without a perception task, multi-user hosting, elaborate map art, and large-scale claims. A labeled deterministic replay is a presentation fallback; it does not substitute for a live Meta result or real packet evidence.

## 4. File and responsibility map

Paths below are planned unless already present. Keep the legacy files intact until the new route is qualified.

| Path | Responsibility |
| --- | --- |
| `src/lifeline/contracts.mjs` | Strict records, identifiers, units, proposal validation |
| `src/lifeline/identity.mjs` | Stable serialization and SHA-256 identities |
| `src/lifeline/ledger.mjs` | Ordered append-only events and manifest finalization |
| `src/lifeline/metrics.mjs` | Receipt-based deadline scoring |
| `src/lifeline/worker-client.mjs` | Typed worker transport, deadlines, lifecycle |
| `src/lifeline/telemetry.mjs` | Observation construction, age and provenance |
| `src/lifeline/beliefs.mjs` | Evidence-linked capacity intervals and contradictions |
| `src/lifeline/controllers/priority.mjs` | Priority-aware failover reference |
| `src/lifeline/controllers/adaptive.mjs` | Strong measurement-driven conventional supervisor |
| `src/lifeline/controllers/meta.mjs` | AI-assisted supervisor using the same action boundary |
| `src/lifeline/controllers/schema-inspired.mjs` | Labeled persistent structured-model comparator for research qualification |
| `src/lifeline/forecast.mjs` | Bounded route/rate counterfactual evaluation |
| `src/lifeline/guard.mjs` | Freshness, policy, action, budget and transition checks |
| `src/lifeline/executor.mjs` | Acknowledged effects, verification and compensation |
| `src/lifeline/meta-provider.mjs` | Meta request/response validation and usage recording |
| `src/lifeline/session.mjs` | Single-run lifecycle and incident state machine |
| `src/lifeline/http.mjs` | Run, event, proposal, fault, stop and export endpoints |
| `runtime/mininet/worker.py` | Private typed command server in isolated Linux |
| `runtime/mininet/topology.py` | Registered network objects and scenario construction |
| `runtime/mininet/traffic.py` | Scheduled messages, acknowledgements, retries and background demand |
| `runtime/mininet/controls.py` | Route/rate effects and read-back |
| `runtime/mininet/telemetry.py` | Counter collection and age-preserving observations |
| `runtime/mininet/faults.py` | Administrative fault injection, never an AI tool |
| `runtime/mininet/tests/test_contracts.py` | Unprivileged adapter contract tests |
| `runtime/mininet/tests/test_integration.py` | Explicitly enabled isolated packet integration tests |
| `fixtures/lifeline/development/*.json` | Public development scenarios and controls |
| `fixtures/lifeline/policy-v1.json` | Operator priorities and action limits |
| `fixtures/lifeline/protocol-v1.json` | Frozen evaluation configuration and suite identities |
| `test/lifeline/*.test.mjs` | Fast contracts, orchestration, scoring and provider tests |
| `public/lifeline.html`, `public/lifeline.js`, `public/lifeline.css` | Service-oriented demo display |
| `scripts/lifeline-preflight.py` | Platform capability and version report |
| `scripts/lifeline-provider-smoke.mjs` | One bounded live provider qualification |
| `scripts/lifeline-run.mjs` | Single-run CLI |
| `scripts/lifeline-evaluate.mjs` | Paired schedule runner and comparison report |
| `scripts/lifeline-replay.mjs` | Ledger verification and metric recomputation |
| `scripts/lifeline-generate-scenarios.mjs` | Seeded scenario generation and split manifest |
| `artifacts/lifeline/<run-id>/` | Manifests, events, receipts, summaries and environment evidence |

Existing integration points are `server.mjs`, `package.json`, `.env.example`, and `README.md`. Add new environment variables explicitly; never read credentials into evidence bundles or browser responses.

## 5. First execution batch: establish a trustworthy experiment

### Task 1: Qualify the runtime and provider

**Dependencies:** None. **Files:** Create `scripts/lifeline-preflight.py`, `scripts/lifeline-provider-smoke.mjs`, `test/lifeline/preflight.test.mjs`, and `docs/trials/lifeline-runtime-run-0.md`.

- [x] First verify the mounted SSD, physical project/output/cache locations, free space, and SSD backing for VM/container storage. Test absent-mount, attempted internal-drive fallback, and a symlink escaping the admitted storage roots; return `storage_unavailable` or `storage_path_rejected` before provisioning or writing project outputs.
- [x] Test capability reports for missing Linux namespaces, missing Mininet/OVS, unavailable worker privilege, absent API credentials, provider timeout, and a complete capability record.
- [x] Run the focused test RED; implement capability detection without silently installing dependencies or modifying host networking.
- [x] On the isolated Linux host, create a two-host test network, send actual packets, retain measured delivery, then remove only the run-owned network objects.
- [x] Record Linux/kernel, Python, Node, Mininet and OVS versions, VM resources, host load, and supported control operations. Freeze the measured environment in the run note.
- [ ] Make a bounded live Meta request through a server-side credential. Retain model ID, response ID when available, duration, token usage when available, parser outcome, and a redacted payload hash.
- [ ] Run ten sequential development requests to estimate latency and failure frequency before selecting final decision budgets. Do not claim a stable p95 from ten observations; retain the observed distribution.
- [ ] Mark G0 qualified only when both packet execution and a real provider call work. An unavailable credential may leave packet work progressing, but cannot qualify Meta usage.

Commands after their scripts exist:

```sh
node --test test/lifeline/preflight.test.mjs
python3 scripts/lifeline-preflight.py --out artifacts/lifeline/preflight.json
node --env-file-if-exists=.env scripts/lifeline-provider-smoke.mjs --out artifacts/lifeline/provider-smoke.json
```

Expected GREEN: capability checks report actual support; packet delivery is measured; the provider smoke has a real response or a precise recorded unavailable outcome. Only the successful outcomes satisfy G0.

**State (Oct 31):** `active`. Storage, capability detection and packet execution qualified in [runtime run 0](../../trials/lifeline-runtime-run-0.md). Provider call and latency sample blocked on a missing `MODEL_API_KEY`. The packet test is `runtime/mininet/packet_smoke.py`; the VM definition is `runtime/vm/lifeline-lima.yaml`.

### Task 2: Freeze typed contracts and evidence identities

**Dependencies:** Task 1's capability report. **Files:** Create `src/lifeline/contracts.mjs`, `src/lifeline/identity.mjs`, `test/lifeline/contracts.test.mjs`, and `fixtures/lifeline/policy-v1.json`.

Public interfaces are `canonicalRecord(value) -> {json, sha256}` and `validateProposal(proposal, context) -> {ok, code}`. The context contains run ID, current configuration revision, current time, policy identity, registered topology/flows, and remaining budgets. No validator mutates its input.

- [x] Add RED cases for valid record round-trip, key-order-independent identity, input immutability, and identity changes for every authority field.
- [x] Reject unknown authority fields, NaN/Infinity, negative times, duplicate object IDs, route cycles, bad endpoints, unknown links, essential-source throttling, oversized probes, and unsupported versions.
- [x] Implement strict parsing before canonicalization. Canonical serialization sorts object keys, preserves ordered arrays, permits only the declared JSON values, and rejects unsupported JS values.
- [x] Require exact run/policy/configuration bindings. A stale observation reference must be checked against the explicit age policy, not accepted because its hash is well-formed.
- [x] Run GREEN and pin a reviewed canonical fixture. Keep policy changes versioned and outside model authority.

```sh
node --test test/lifeline/contracts.test.mjs
```

Expected RED: missing contract behavior. Expected GREEN: all positive and malformed controls pass with stable reason codes. Evidence: `docs/trials/lifeline-contracts-run-0.md`.

**State (Oct 31):** `qualified` at contract level in [contracts run 0](../../trials/lifeline-contracts-run-0.md). Duplicate keys in raw model JSON remain for the Task 9 parser.

### Task 3: Make the service metric independently correct

**Dependencies:** Task 2. **Files:** Create `src/lifeline/metrics.mjs`, `test/lifeline/metrics.test.mjs`, and sender/receiver fixture records under `fixtures/lifeline/development/`.

Public interface: `scoreMessages({offered, receipts, fromMs, toMs})` returns `offered`, `onTime`, `late`, `lost`, `duplicateReceipts`, and `deliveryRate`. Offered records have `id`, `createdAtMs`, and `deadlineMs`; receipts have `id` and `receivedAtMs`. Include offered records whose creation falls in `[fromMs,toMs)` and wait through the largest applicable deadline before finalizing.

The first RED test must include this boundary case:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessages } from '../../src/lifeline/metrics.mjs';

test('lost and late messages remain in the offered denominator', () => {
  const result = scoreMessages({
    offered: [
      { id: 'a', createdAtMs: 0, deadlineMs: 500 },
      { id: 'b', createdAtMs: 0, deadlineMs: 500 },
      { id: 'c', createdAtMs: 0, deadlineMs: 500 },
    ],
    receipts: [
      { id: 'a', receivedAtMs: 500 },
      { id: 'a', receivedAtMs: 501 },
      { id: 'b', receivedAtMs: 501 },
    ],
    fromMs: 0,
    toMs: 1000,
  });
  assert.equal(result.offered, 3);
  assert.equal(result.onTime, 1);
  assert.equal(result.late, 1);
  assert.equal(result.lost, 1);
  assert.equal(result.duplicateReceipts, 1);
  assert.equal(result.deliveryRate, 1 / 3);
});
```

- [x] Observe RED, then implement scoring from offered IDs and earliest valid receipt per ID.
- [x] Add out-of-order receipts, retries, unknown IDs, duplicate offered IDs, zero offered messages, boundary times, and an incomplete observation horizon. Zero offered messages yields an undefined/null rate, never 100%.
- [x] Require a separate error for an incomplete capture rather than classifying missing evidence as network loss.
- [x] Cross-check small fixtures with a separately written reference calculation. Preserve background demand before throttling so its throughput denominator cannot shrink.
- [x] Run GREEN and retain the hand-calculated fixture and scorer output.

```sh
node --test test/lifeline/metrics.test.mjs
```

Evidence: `docs/trials/lifeline-metrics-run-0.md`. No networking or model is needed to qualify this task.

**State (Oct 31):** `qualified` at contract level in [metrics run 0](../../trials/lifeline-metrics-run-0.md).

### Task 4: Run real messages, collect telemetry, and reproduce the cascade

**Dependencies:** Tasks 1–3. **Files:** Create `runtime/mininet/{worker,topology,traffic,telemetry,faults}.py`, the two Python test modules in the file map, `src/lifeline/{worker-client,telemetry}.mjs`, `test/lifeline/worker-client.test.mjs`, `scripts/lifeline-run.mjs`, and `fixtures/lifeline/development/{cascade,no-fault,partition}.json`.

- [x] Drive RED/GREEN for protocol handshake, units, message correlation, monotonic sequence, truncated frames, duplicate replies, timeout, worker exit, and command rejection after exit.
- [x] Build the registered six-switch topology and four service endpoints from the development fixture. Record actual ports and interface identities.
- [x] Schedule essential messages independently of the controller. Record offered IDs before transmission and sender completion manifests after the horizon.
- [x] Use a common monotonic clock in the same Linux kernel for sender/receiver timing; verify the clock basis and supervisor-to-worker run epoch. Run the supervisor on Linux in the reference deployment, with the Mac browser as a client. A future multi-host experiment needs an explicit synchronization/error model.
- [x] Collect rates, queue/drop counters where supported, link observations, age, and receipts. Missing counters remain missing; never substitute zero.
- [x] Install a fixed reference policy with preconfigured backup paths, disable the direct link, observe rerouting pressure, and retain queueing, retry, and deadline-loss evidence. Add a still-up capacity reduction and a complete partition control.
- [x] Confirm hidden fault labels and future schedule entries never appear in controller-visible observations.
- [x] Run a clean teardown and repeated start/stop test. Detect orphan workers and run-owned network objects without deleting unrelated host resources.

```sh
node --test test/lifeline/worker-client.test.mjs
python3 -m unittest discover -s runtime/mininet/tests -p test_contracts.py
node scripts/lifeline-run.mjs --scenario fixtures/lifeline/development/cascade.json --controller fixed --backend mininet --out artifacts/lifeline/packet-run-0
```

The packet command requires the qualified environment from Task 1 and the worker introduced in this task. Expected GREEN: the independent scorer sees actual messages and a fault effect; no particular AI improvement is expected. Evidence: `docs/trials/lifeline-packet-run-0.md`.

**State (Oct 31):** `qualified` for the fixed policy in [packet run 0](../../trials/lifeline-packet-run-0.md): cascade primary on-time 0.630 (24,000 offered), partition and restart controls pass, controller-view audit clean. Run inside the VM: `limactl shell lifeline`, sync to `/workspace/Meta_Hackathon`, copy evidence to `/mnt/lifeline-artifacts`.

### Task 5: Enforce authority, freshness, and budgets

**Dependencies:** Tasks 2 and 4. **Files:** Create `src/lifeline/guard.mjs` and `test/lifeline/guard.test.mjs`.

- [x] Observe RED for wrong policy, old configuration revision, expired proposal, stale telemetry, unknown flow, unavailable path, route loop, changing essential demand, and exhausted action/probe budgets.
- [x] Implement precondition rechecks against the newest observation. A fresh sample with unchanged preconditions can admit a proposal; changed authority or failed preconditions cannot.
- [x] Charge rejected and timed-out attempts against their attempt budgets, and charge actual probe bytes separately. Retries cannot reset a budget.
- [x] Validate transitional capacity/rule limits and action order, not only the predicted final state.
- [x] Prove model confidence and explanatory text never override a rejected guard result.

```sh
node --test test/lifeline/guard.test.mjs
```

Evidence: `docs/trials/lifeline-guard-run-0.md` with stable rejection codes and no worker effects for rejected actions.

**State (Oct 31):** `qualified` at contract level in [guard run 0](../../trials/lifeline-guard-run-0.md); five branch mutations caught. End-to-end "no worker effect" is confirmed with the executor in Task 6.

### Task 6: Execute and reconcile real network effects

**Dependencies:** Task 5. **Files:** Create `src/lifeline/executor.mjs`, `runtime/mininet/controls.py`, and `test/lifeline/executor.test.mjs`; extend Python integration tests.

- [x] Add RED cases for prepare failure, ingress-switch failure, successful effect with lost reply, repeated operation ID, cancellation, worker exit, and verification timeout.
- [x] Implement versioned route preparation, explicit switch acknowledgements, ingress change, traffic verification, and old-rule retirement. Qualify forward and acknowledgement paths.
- [x] Implement bounded background-rate application and read-back. Keep the original offered workload immutable.
- [x] Record effect receipts only after observed acknowledgements. A sent command is not proof of application.
- [x] On partial failure, retain actual effects and reconcile before retrying. Reuse an operation ID only to retrieve its prior outcome; never duplicate a completed effect.
- [x] Test feasible rollback and impossible rollback after an additional link failure. In the latter case, establish a new feasible deterministic policy or report unavailable service.
- [x] Qualify the transition with actual packets, including in-flight messages, path-version drain, and two successive updates. Retain transient loss rather than excluding it from the score.

```sh
node --test test/lifeline/executor.test.mjs
python3 -m unittest discover -s runtime/mininet/tests -p test_integration.py
```

The Python integration suite runs only in the explicitly enabled qualified Linux environment. An unavailable environment is reported as an infrastructure block, not a passing packet test. Evidence: `docs/trials/lifeline-execution-run-0.md`.

**State (Oct 31):** `qualified` in [execution run 0](../../trials/lifeline-execution-run-0.md): two successive versioned updates and a throttle confirmed on live traffic with 0/4,800 messages lost. Impossible rollback is contract-tested only; transient loss under congestion is unmeasured.

### Task 7: Build the conventional controllers before the AI

**Dependencies:** Task 6. **Files:** Create `src/lifeline/controllers/{priority,adaptive}.mjs`, `test/lifeline/controllers.test.mjs`, and `fixtures/lifeline/development/controller-oracles.json`.

- [x] Test shortest feasible priority-aware routing, background shedding within policy, alternate paths, acknowledgement paths, ties, no-path outcomes, stale measurements, and oscillation hysteresis.
- [x] Implement a priority-aware failover controller. It uses the same service priorities and action guard as LIFELINE.
- [x] Implement the stronger adaptive controller: update capacity estimates from telemetry, probe uncertain overloaded paths within budget, and evaluate feasible route/rate combinations on the small topology.
- [x] Enumerate at most three simple candidate paths per essential flow and rates from the declared background-rate grid; retain the same candidate/action limits for all supervisors. Record search exhaustion as a limit, not optimality.
- [x] Test small known-capacity instances against exhaustive hand-checkable optima. An oracle with hidden capacity is a diagnostic ceiling only; keep it out of the fair primary comparison.
- [x] Run outage, overload, no-fault, partition, and stale-telemetry controls. Confirm the baseline actually reacts, preserves priority traffic when feasible, and can win on easy cases.
- [x] Qualify G1. If a baseline fails an elementary case, fix it before comparing the AI.

```sh
node --test test/lifeline/controllers.test.mjs
node scripts/lifeline-run.mjs --scenario fixtures/lifeline/development/cascade.json --controller adaptive --backend mininet --out artifacts/lifeline/baseline-run-0
```

Evidence: `docs/trials/lifeline-baseline-run-0.md`, including controller configuration and tuning history.

**State (Oct 31):** `qualified`; G1 qualified in [baseline run 0](../../trials/lifeline-baseline-run-0.md). Cascade on-time: fixed 0.631, priority 0.9985, adaptive 1.000. The adaptive baseline saturates `dev-cascade-1`, so Task 11 needs predeclared harder development cases (owner decision).

## 6. Second execution batch: bounded adaptation and real Meta decisions

### Task 8: Qualify beliefs and counterfactual prediction

**Dependencies:** Task 7. **Files:** Create `src/lifeline/{beliefs,forecast}.mjs` and `test/lifeline/{beliefs,forecast}.test.mjs`.

- [ ] Test observation-derived capacity intervals, missing measurements, conflicting evidence, model revision, and evidence IDs that do not exist.
- [ ] Require an empty or contradictory model to produce `model_inconsistent`; it cannot certify an intervention.
- [ ] Implement a bounded flow/capacity estimator with explicit assumptions and uncertain inputs. Never read hidden fault settings.
- [ ] Qualify flow conservation, capacity constraints, priority ordering, and no-path cases against hand-calculated examples.
- [ ] Compare predictions with packet outcomes across the public development scenarios. Record residuals, optimistic errors, and cases outside model support.
- [ ] Set forecast tolerances from development evidence before evaluation. When the model is unsupported or fails calibration, keep its predictions advisory and use deterministic control.
- [ ] Qualify G2 only after the guard, executor, and model limitations are exercised together.

```sh
node --test test/lifeline/beliefs.test.mjs test/lifeline/forecast.test.mjs
```

Evidence: `docs/trials/lifeline-forecast-run-0.md`. Forecast agreement is not a network safety guarantee.

### Task 9: Integrate meaningful Meta investigation

**Dependencies:** Task 8 and real provider qualification from Task 1. **Files:** Create `src/lifeline/meta-provider.mjs`, `src/lifeline/controllers/meta.mjs`, `test/lifeline/meta-provider.test.mjs`, and `fixtures/lifeline/development/provider-controls.json`.

- [ ] Mock-test timeout, HTTP errors, malformed JSON, missing fields, invented evidence IDs, invalid units, unsupported actions, excess response size, and valid typed decisions. These tests qualify parsing only.
- [ ] Send the model service objectives, current observations with age, recent action outcomes, model assumptions, competing explanations, and remaining budgets. Exclude hidden schedules and administrative fault truth.
- [ ] Require a decision containing a diagnostic hypothesis, evidence references, a discriminating bounded probe or intervention, expected observable consequences, and an explicit stop/retain option.
- [ ] Permit the model to propose new combinations within the action contract, rather than merely write a caption for a preselected action.
- [ ] Validate all responses before changing beliefs or attempting actions. A proposed numeric update needs supporting measurement; the model cannot invent an observed capacity.
- [ ] Record exact model/prompt versions, timing, response identifiers, usage, and failures. Show deterministic takeover explicitly when a provider is unavailable.
- [ ] Retain a live trace where a real response changes which probe or intervention is attempted and the outcome is measured. If all choices match the baseline, report that honestly.

```sh
node --test test/lifeline/meta-provider.test.mjs
node --env-file-if-exists=.env scripts/lifeline-run.mjs --scenario fixtures/lifeline/development/cascade.json --controller meta --backend mininet --decision-limit 1 --out artifacts/lifeline/meta-run-0
```

Evidence: `docs/trials/lifeline-meta-run-0.md`. Credentials and authorization headers never enter artifacts.

### Task 10: Close the continuous-time recovery loop

**Dependencies:** Task 9. **Files:** Create `src/lifeline/{session,ledger}.mjs`, `test/lifeline/{session,ledger}.test.mjs`, and `scripts/lifeline-replay.mjs`.

- [ ] Drive RED/GREEN for the full lifecycle: observation, investigation, proposal, forecast, admission, execution, verification, and renewed observation.
- [ ] Keep traffic and fault clocks running during API calls. Include model wait time, probes, rejected attempts, and compensation in the service outcome.
- [ ] Abort stale proposals after a configuration change. Handle a second failure during investigation or execution without replaying the old plan blindly.
- [ ] Require progress bounds: repeated equivalent probes or ineffective route changes reach a recorded limit and hand control back to the conventional supervisor.
- [ ] Persist every attempt and terminal outcome, including provider failure, guard rejection, partial action, user stop, worker crash, and process restart.
- [ ] Test ledger append ordering, crash-truncated final records, duplicate sequence numbers, altered records, missing receipts, and incomplete manifests. A hash chain detects changes relative to a retained manifest; it is not independent proof of an honest experiment.
- [ ] Replay contract decisions and recompute scores from retained inputs without calling the provider or rerunning network traffic. Do not claim bit-identical packet replay.
- [ ] Qualify G3 with a live Meta trace, second failure, and visible degraded-mode control.

```sh
node --test test/lifeline/session.test.mjs test/lifeline/ledger.test.mjs
node --env-file-if-exists=.env scripts/lifeline-run.mjs --scenario fixtures/lifeline/development/cascade.json --controller meta --backend mininet --out artifacts/lifeline/recovery-run-0
node scripts/lifeline-replay.mjs --run artifacts/lifeline/recovery-run-0 --verify
```

Evidence: `docs/trials/lifeline-recovery-run-0.md` and a self-contained run bundle.

## 7. Third execution batch: determine what works and make it visible

### Task 11: Run the preliminary comparison

**Dependencies:** Task 10. **Files:** Create `scripts/lifeline-evaluate.mjs`, `test/lifeline/evaluation.test.mjs`, and `fixtures/lifeline/protocol-v1.json`; update the evaluation protocol with frozen pilot settings.

- [ ] Test paired schedules, randomized controller order, all-run denominators, interrupted runs, budget accounting, and scorer disagreement before collecting results.
- [ ] Record a current scan of closely related network diagnosis, traffic engineering, and LLM control systems before freezing comparator choices. The fuller reproduction study remains Task 16; a known closer baseline cannot be omitted merely because it was found late.
- [ ] Freeze eight development cases, three controllers (`priority`, `adaptive`, `meta`), and two repetitions: 48 episodes. Use the same offered traffic and fault schedule for each paired case.
- [ ] Run sequentially on the qualified host unless parallel isolation is independently demonstrated. Retain host load and reject infrastructure-invalid pairs under the predeclared rule.
- [ ] Report every case, including no-fault and impossible-recovery controls, with deadline delivery, background throughput, recovery status, action counts, provider latency, and resource use.
- [ ] Investigate a positive or negative result using retained traces. Do not tune on a case and continue calling that case held out.
- [ ] Qualify G4a as preliminary evidence. A negative result is a valid completed comparison, but cannot qualify an improvement claim.

```sh
node --test test/lifeline/evaluation.test.mjs
node --env-file-if-exists=.env scripts/lifeline-evaluate.mjs --protocol fixtures/lifeline/protocol-v1.json --suite pilot --backend mininet --out artifacts/lifeline/pilot-v1
```

Evidence: `docs/trials/lifeline-pilot-run-0.md`, full run index, and machine-readable comparison.

### Task 12: Freeze and evaluate generalization and contribution

**Dependencies:** Task 11. **Files:** Create `scripts/lifeline-generate-scenarios.mjs`, `test/lifeline/scenario-splits.test.mjs`, `src/lifeline/controllers/schema-inspired.mjs`, `test/lifeline/schema-inspired.test.mjs`, and `docs/research/lifeline-claims.md`.

- [ ] Freeze topology/fault-composition splits and numeric ranges before looking at evaluation outcomes. Deduplicate equivalent graphs and derivative cases.
- [ ] Select the strongest conventional baseline on development data and lock its configuration with the AI configuration.
- [ ] Run the bounded held-out protocol defined in the evaluation document. Preserve all attempted runs and predeclare replacements for infrastructure failures.
- [ ] Run model-removal, probe-removal, fixed-belief, and observation-quality ablations to identify which mechanism accounts for any gain.
- [ ] Compare a Schema-style persistent-model loop under matched budgets. If using a reimplementation, label it as such; reserve direct Schema superiority claims for a verified adaptation of the authors' system.
- [ ] Compute paired uncertainty intervals over scenario groups, not individual packets. Check no-fault regression, partitions, worst-case episodes, and resource cost.
- [ ] Qualify G4b and write the smallest supported claim. If performance is tied, retain an engineering result and leave the research improvement claim unqualified.

```sh
node --test test/lifeline/scenario-splits.test.mjs test/lifeline/schema-inspired.test.mjs
node --env-file-if-exists=.env scripts/lifeline-evaluate.mjs --protocol fixtures/lifeline/protocol-v1.json --suite holdout --backend mininet --out artifacts/lifeline/holdout-v1
```

The holdout command must refuse an unfrozen protocol, reused tuning split, missing prerequisite baseline, or unaffordable declared budget. Evidence: `docs/trials/lifeline-holdout-run-0.md`.

### Task 13: Integrate the operator and judge interface

**Dependencies:** Tasks 4 and 10; meaningful comparison panels require Task 11. **Files:** Create `src/lifeline/http.mjs`, `public/lifeline.{html,js,css}`, and `test/lifeline/http.test.mjs`; modify `server.mjs` and `README.md`.

- [ ] Test run isolation, one mutation at a time, stale run IDs, explicit start/stop, invalid fault controls, event resumption, provider-unavailable status, and export of failed runs.
- [ ] Implement endpoints for run creation, status/events, admitted fault injection, stop, and evidence export. The browser cannot bypass proposal validation or reach the privileged worker.
- [ ] Render actual topology state and measured service delivery from events. Label synthetic facility identities and emulator mode.
- [ ] Show the intervention's evidence, expected outcome, actual outcome, and whether Meta or the conventional controller chose it.
- [ ] Add live judge controls only for qualified fault types. Disable controls that would violate experiment isolation or corrupt a run.
- [ ] Display live, retained comparison, and replay modes distinctly. Test stale displays after reconnect and stop; a disconnected worker cannot remain green.
- [ ] Inspect desktop and narrow-screen layouts with actual traces; verify keyboard controls, readable status, and evidence export. Do not add unit tests for cosmetic spacing.

```sh
node --test test/lifeline/http.test.mjs
npm start
```

Evidence: `docs/trials/lifeline-interface-run-0.md`, screenshots, and run IDs used in inspection.

### Task 14: Rehearse and package the hackathon result

**Dependencies:** G3, G4a, and Task 13. **Files:** Modify `README.md` and `docs/competition.md`; create `docs/demo/lifeline-demo-script.md` and `docs/releases/lifeline-hackathon-release.md`.

- [ ] Rehearse three complete runs from a clean start: ordinary two-fault demonstration, an unexpected admitted fault choice, and provider interruption.
- [ ] Explain the user problem, show messages flowing, inject the first failure, show the measured intervention, inject the second failure, then show the comparison and evidence export.
- [ ] Retain a labeled replay and a prerecorded video using the same qualified commit. Show replay mode if used; never substitute it silently for live behavior.
- [ ] Verify a fresh setup from the README on the actual demo host, including worker preflight, model configuration, start, stop, and cleanup.
- [ ] Map each judging criterion to concrete evidence in the evaluation document. Keep the model's contribution visible and measured.
- [ ] Check accepted-portal requirements for video length, required URLs, team information, and existing-work disclosure; record exact requirements before submitting. These details are not inferred from public marketing text.
- [ ] Review eligibility and accepted event terms with the team representative as a separate submission dependency; do not treat a completed demo as eligibility confirmation.
- [ ] Run relevant Node and Python tests, replay retained evidence, run `git diff --check`, and record the final code and protocol identities.
- [ ] Qualify G5 only when all submitted claims and assets match the retained evidence.

Evidence: `docs/trials/lifeline-release-run-0.md`. Completion of this task prepares the submission package; actual publication/submission follows the user's applicable authorization.

## 8. Longer-term program

### Task 15: Expand failure realism and observability

**Entry:** Stable G5 release and reproducible G4b protocol. **Horizon:** First two to four weeks after the demo, depending on resources.

**Files:** Extend `runtime/mininet/traffic.py`, `runtime/mininet/telemetry.py`, scenario fixtures, and the evaluation protocol; add `docs/research/lifeline-workload-validity.md`.

- [ ] Add real application protocols and measured traces whose use is permitted; keep synthetic and trace-driven populations separate.
- [ ] Test telemetry delay, counter reset, sensor loss, asymmetric links, queue-policy mismatch, and control-channel interruption independently before combining them.
- [ ] Measure CPU scheduling and emulator scaling limits. Publish the admitted network size and rate range; reject experiments beyond it.
- [ ] Add topology families that were not used for prompt or baseline development and retain per-family results.
- [ ] Qualify each added failure mechanism with a causal trace and an independent expected-effect check.

Exit evidence: `docs/trials/lifeline-realism-run-0.md`, including cases the emulator cannot credibly represent.

### Task 16: Establish the research contribution against prior work

**Entry:** G4b and Task 15. **Files:** Create `docs/research/lifeline-prior-work.md` and `docs/research/lifeline-research-protocol-v2.md`; extend controller adapters and matched tests as required by the reviewed comparison.

- [ ] Review current traffic engineering, active network diagnosis, fault localization, adaptive control, and LLM network-operation work. Record exactly which claim each prior system already covers.
- [ ] Audit the closest executable baselines and reproduce at least one appropriate conventional method and one persistent-model reasoning method.
- [ ] Separate unfamiliar parameter values, new topology, new fault combinations, and new failure mechanisms in the evaluation. They support different generalization claims.
- [ ] Test whether the gain survives equal probe budgets, equal observations, equal control authority, and measured model latency.
- [ ] Make the accepted contribution conditional on results: improved service outcome, better diagnostic efficiency, or a useful benchmark. Do not promise algorithmic novelty in advance.
- [ ] Publish negative and tied comparisons with the successful cases.

Exit evidence: reproducible comparison package and a claim table with supported, unsupported, and untested statements.

### Task 17: Qualify broader model construction and transfer

**Entry:** Task 16 demonstrates a reason the bounded V1 representation is limiting. **Files:** Create `docs/superpowers/specs/lifeline-program-models-design.md` and a separate implementation plan before adding an execution sandbox.

- [ ] Identify failures requiring a new state variable, dependency, or transition model rather than another capacity estimate.
- [ ] Compare a structured-model extension with an executable-program extension. Keep the simpler representation if it achieves the same outcome.
- [ ] If executable models are used, isolate them from credentials, host networking, fault truth, and unbounded computation; test their predictions on retained observations and unseen transitions.
- [ ] Measure knowledge reuse across disjoint topology/fault families, including harmful transfer and stale beliefs.
- [ ] Evaluate against Schema or a clearly identified adaptation; do not call persistent code, backtesting, or prediction checks new inventions.

Exit evidence: a distinct model-discovery result beyond V1's bounded adaptation, or a retained negative result explaining why the extension is unnecessary.

### Task 18: Qualify an operator pilot

**Entry:** Reliable G6 evidence, an interested operator, and a defined permitted test environment. **Horizon:** Approximately one to three months, conditional on access and results.

**Files:** Create `docs/pilots/lifeline-operator-protocol.md`, an operator workflow specification, and a pilot-specific implementation plan.

- [ ] Conduct task-based operator sessions to determine useful warnings, acceptable investigation delay, and intervention authority.
- [ ] Start with recorded data or a shadow observer; compare recommendations against actual operator decisions and outcomes where available.
- [ ] Qualify operator approval, cancellation, evidence review, recovery from control-plane loss, credential handling, and supported deployment environments.
- [ ] Use an isolated physical mesh or permitted lab network only after topology and radio assumptions are documented. Packet emulation alone does not establish RF resilience.
- [ ] Measure operator time, false interventions, missed incidents, and service outcomes. Do not infer lives saved from synthetic messages delivered.
- [ ] Define the required operational review and evidence before any real-service actuation.

Exit evidence: a pilot-specific claim tied to its users, network, observation period, and action authority.

### Task 19: Extend to other essential systems and coupled failures

**Entry:** A useful communications result and a concrete second-domain partner or simulation question. **Files:** Create a domain-specific design, adapter contract, benchmark, and execution plan under `docs/domains/` before implementation.

- [ ] Choose one second domain: power with Grid2Op or water with WNTR. Qualify its units, clock, observations, actions, constraints, and credible baseline independently.
- [ ] Reuse only genuinely shared components: proposal lifecycle, evidence ledger, budgets, provider interface, and experiment accounting. Keep domain solvers and control constraints authoritative.
- [ ] Evaluate cross-domain reuse on a held-out task without giving the model future faults or hidden solver state.
- [ ] Add coupled failures only after each adapter is qualified. Define power-to-communications and other dependency equations, time scales, and resource constraints explicitly.
- [ ] Compare joint control with independent domain controllers and a coordinated conventional optimizer. A connected map is not evidence of improved resilience.
- [ ] Measure preserved service over the coupled scenario and identify the mechanism behind any benefit.

Exit evidence: a separately qualified second domain, then a coupled-service result. Grid2Op and WNTR are candidate foundations, not capabilities inherited automatically by LIFELINE. [Grid2Op](https://github.com/Grid2op/grid2op), [WNTR](https://usepa.github.io/WNTR/).

## 9. Risks and required responses

| Risk | Early signal | Required response |
| --- | --- | --- |
| AI adds no value | Strong baseline matches or wins | Retain result; inspect diagnosis/probe contribution before expanding scope |
| Model too slow | Decisions arrive after useful recovery window | Keep deterministic control active; evaluate slower advisory value honestly |
| Simulator-specific improvement | Gain disappears across host/topology changes | Add independent packet checks and limit the claim |
| Objective gaming | Essential offered count changes after intervention | Reject the run and repair source/scorer separation |
| Weak comparison | Baseline fails simple known-capacity cases | Repair baseline before reporting AI superiority |
| Telemetry truth leakage | Controller sees injected fault values | Invalidate affected runs and repair observation boundary |
| Forecast optimism | Predicted recovery repeatedly misses receipts | Widen uncertainty or disable unsupported model authority |
| Partial update damage | Intermediate routing state loses traffic | Qualify transition protocol and count its service cost |
| No usable Linux host | G0 packet test cannot run | Resolve platform access; retain synthetic tests as contract evidence only |
| API availability or budget | Smoke fails or evaluation exceeds budget | Record precise limitation; reduce a prespecified suite before freezing, never after seeing scores |
| Deadline pressure | UI advances while G1 remains absent | Return to the packet and metric vertical slice |
| Scope growth | Multiple domains before G4 | Keep them in Tasks 18–19 until entry evidence exists |

## 10. Update and completion boundary

At the end of each work session, update the run register's current task, last verified commit, most recent command, result, artifact, blocker, and next action. Link every checked task to a run note. If a result is invalidated, reopen the affected task and downstream claim, retaining the old record with a superseded reason.

The hackathon release is complete at G5 for its explicitly declared scope. The research and deployment program continues through its separately qualified gates. A working packet demo does not complete the research claim, and a successful communications result does not complete a power or water result.

This plan follows the TDD structure of an earlier private project: bounded increments, explicit negative controls, retained runs, and claims that advance only with evidence. Those style references are local context, not runtime dependencies.
