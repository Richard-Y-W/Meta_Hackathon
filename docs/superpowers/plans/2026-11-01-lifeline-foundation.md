# LIFELINE Foundation — Implementation Plan P00–P05

> **For agentic workers:** Use `superpowers:executing-plans`; work inline unless separately authorized. Execute the task's RED/GREEN sequence, retain the actual commands and artifacts, and update the run register. All tasks below are planned.

**Goal:** Preserve V1 evidence, repair slow-model integration, and establish the common control and measurement boundary for infrastructure-wide work.

**Architecture:** Keep the complete conventional controller running while asynchronous investigations produce version-bound proposals. Introduce a separate infrastructure contract without rewriting frozen V1 artifacts.

**Tech stack:** Existing Node ES modules/`node:test`, Python unittest, Lima/Mininet, JSON manifests, SSD-backed runtime.

**Depends on:** [Master storage and execution rules](2026-10-31-lifeline-program.md). **Contracts:** [Infrastructure design](../specs/2026-11-01-lifeline-infrastructure-design.md).

## Execution and evidence convention

Run host commands from `/Volumes/PortableSSD/Meta_Hackathon`; Linux/root integration commands run only in the qualified SSD-backed guest. Future files and CLIs named here are implementation targets and do not exist yet.

For each task, retain `artifacts/lifeline/infra/pNN-run-0/` with a manifest, commands/results, raw outputs, and a short interpretation; create `docs/trials/lifeline-infra-pNN-run-0.md`. Later attempts increment the suffix. Do not overwrite a failed run. After GREEN, review `git diff --check`, update the register, and commit the qualified increment during implementation. A failing import is setup evidence; the intended RED is a failing behavioral assertion once the interface exists.

## P00 — Preserve evidence and reproduce setup

**Entry:** Existing release at `127ba02`; SSD mounted.

**Files:** Create `scripts/lifeline-release-manifest.mjs`, `runtime/vm/lifeline-cleanroom.yaml`, `docs/trials/lifeline-cleanroom-run-0.md`. Modify `README.md`, `scripts/lifeline-preflight.py`, `test/lifeline/preflight.test.mjs`. Retain the V1 archive and all original pilot outputs.

- [x] Record code, current dirty files, protocol and artifact hashes. Separate 48 retained first attempts from nine withdrawn reruns. Do not change `fixtures/lifeline/protocol-v1.json` or original run bundles.
- [x] RED: preflight must reject a missing SSD mount, internal cache/output path, escaping symlink, insufficient scratch, and a VM disk outside the SSD. Test these with controlled path fixtures, not by disconnecting the live SSD.
- [x] GREEN: report the physical repository, environments, caches, temporary roots, VM backing disks, free capacity and guest mapping. Capacity admission uses projected batch size plus a declared reserve.
- [x] Create a second SSD-backed guest from documented prerequisites and pinned packages. Keep the running demo guest intact. Record downloads, versions, setup time, and every manual correction.
- [x] In that fresh guest run unit tests, one short packet control, one guarded route update, and replay a retained bundle. Exercise start/stop/cleanup twice and confirm no orphaned interfaces/processes.
- [x] Revise README from the observed setup, including credentials as user-supplied inputs without recording their values.

**Commands:**

```sh
node --test test/lifeline/preflight.test.mjs
python3 scripts/lifeline-preflight.py --help
npm test
python3 -m unittest discover -s runtime/mininet/tests -p 'test_*.py'
```

Inspect the preflight's actual CLI before recording a full invocation. Packet/root qualification follows the existing runtime run note inside the clean guest.

**State (Nov 1):** `qualified` in [P00 run 0](../../trials/lifeline-infra-p00-run-0.md).

**Gate:** An independently started environment runs and cleans up using the README. Existing test totals are historical until rerun. Missing provider credentials can qualify the local runtime half only; live-provider behavior remains separate.

## P01 — Repair parallel investigation, clocks and expiry

**Entry:** P00 evidence snapshot; local controller tests available.

**Files:** Modify `src/lifeline/controllers/meta.mjs`, `src/lifeline/controllers/adaptive.mjs` only if needed for its public seam, `src/lifeline/meta-provider.mjs`, `scripts/lifeline-run.mjs`, `test/lifeline/meta-controller.test.mjs`, `test/lifeline/meta-provider.test.mjs`. Create `src/lifeline/investigation-clock.mjs` and `test/lifeline/investigation-clock.test.mjs`.

- [x] RED: while a model promise remains unresolved, feed identical unexplained degradation to adaptive and Meta-assisted controllers. Both must retain the baseline probe/recovery opportunity within the same control ticks. Provider success, failure, and hang must not toggle that capability.
- [x] RED: start at 31,000 ms, observe a timeout at 49,000, start a retry then complete it at 67,000. A 20,000 ms degraded hold must end at 87,000, not 69,000. In a separate test, a 30,000 ms investigation deadline started at 31,000 must expire at 61,000 even when per-call timeouts are 18,000.
- [x] Define an injected monotonic `nowMs()` using the episode's time origin. The helper `createInvestigationBudget({startedAtMs, deadlineMs, nowMs})` exposes `remainingMs()` and `expired()`; clamp remaining time at zero.
- [x] GREEN: keep the full adaptive rule active, bound each call by remaining total time, cancel timed-out requests, and timestamp completion/fallback using current time. Charge attempts exactly once, including failures.
- [x] RED/GREEN: bind a pending response to its originating evidence and configuration revision. A conventional reroute, second fault, expired observation, stopped run, or new run must prevent an old response from mutating current state.
- [x] Test simultaneous baseline/model proposals, duplicate completions, out-of-order responses, provider recovery and end-of-run arrival. Model work may wait or be discarded; baseline recovery must not wait on it.
- [x] Retain a live slow-provider run and a failed-provider run. Separate changed controller behavior from model/prompt latency changes.

**Behavioral assertions for the injected clock:**

```js
const b = createInvestigationBudget({
  startedAtMs: 31000, deadlineMs: 30000, nowMs: () => now
});
now = 49000; assert.equal(b.remainingMs(), 12000);
now = 61000; assert.equal(b.expired(), true);
now = 67000; assert.equal(b.remainingMs(), 0);
```

**Run:** `node --test test/lifeline/meta-controller.test.mjs test/lifeline/meta-provider.test.mjs test/lifeline/investigation-clock.test.mjs`.

**State (Nov 1):** `qualified` in [P01 run 0](../../trials/lifeline-infra-p01-run-0.md); the adaptive baseline gained a refused-plan hold (baseline revision for v2).

**Gate:** No branch of provider health disables conventional recovery; stale work cannot execute; total deadlines and fallback holds obey observed time. This is integration qualification, not an improvement result.

## P02 — Qualify communications revision 2

**Entry:** P01; V1 frozen and preserved.

**Files:** Create `fixtures/lifeline/protocol-v2.json`, `fixtures/lifeline/scenarios-v2.json`, `docs/trials/lifeline-communications-v2-run-0.md`. Modify `src/lifeline/evaluation.mjs`, `scripts/lifeline-evaluate.mjs`, `test/lifeline/evaluation.test.mjs` only for versioned protocol support.

- [x] RED: reject mixed protocol/controller identities, hidden-fault data in controller input, missing first attempts, and a score whose offered denominator changed.
- [x] Treat all V1 cases as seen regression/development data. Create new cases before viewing v2 AI results; retain no-fault, unrecoverable, timeout and stale-data controls.
- [x] Freeze paired workloads, randomized controller order, budget, loss margin and failure rules. Include adaptive, priority, repaired Meta, and model-disabled repaired Meta.
- [x] GREEN: run the same receipt scorer against both protocol revisions without rewriting V1 results. Report both per-service and overall outcomes, action/probe costs and scheduling delays.
- [x] Qualify at least a small declared comparison with confidence limits appropriate to independent scenario groups. If the suite is too small for the desired precision, call it exploratory.
- [x] Record whether repair removes regressions, whether AI adds value, and how much headroom remains. Move to power/water after integration qualification even if added AI benefit is absent.

**Run:** `node --test test/lifeline/evaluation.test.mjs test/lifeline/replay.test.mjs`; then the existing evaluator with `--protocol fixtures/lifeline/protocol-v2.json --suite pilot --backend mininet --out artifacts/lifeline/communications-v2`.

**State (Nov 1):** `qualified` in [communications v2 run 0](../../trials/lifeline-communications-v2-run-0.md): repair removes the regression (meta − adaptive −0.003 pp, worst −0.03 pp); AI value not shown (meta − meta-disabled 95% interval −0.003 to +0.015 pp).

**Gate:** Trustworthy v2 comparison and explicit outcome. Do not replace the objective with diagnosis accuracy if service preservation fails; diagnosis can be a separately declared secondary result.

## P03 — Versioned infrastructure contracts and adapter conformance

**Entry:** P00; independent of achieving an AI win in P02.

**Files:** Create `src/lifeline/kernel/contracts.mjs`, `clock.mjs`, `services.mjs`, `src/lifeline/domains/communications.mjs`, `test/lifeline/infra/contracts.test.mjs`, `clock.test.mjs`, `adapter-conformance.test.mjs`, `fixtures/lifeline/infra/contract-v1.json`. Existing V1 `contracts.mjs` stays versioned separately.

- [x] Define the design's observation, capability, service, forecast, plan, action and receipt schemas, including canonical units and integer microsecond clocks.
- [x] RED: reject a water flow supplied as electrical power, negative timestamps, unknown capabilities, incompatible schema versions, cross-run evidence, stale configuration and missing observations interpreted as zero.
- [x] GREEN: implement strict `validateEnvelope(value)` returning `{ok, code}`; implement explicit unit conversion at adapter admission. Internal records use canonical units.
- [x] Wrap actual communications behavior, preserving its route/rate/probe semantics and receipt scorer. State unsupported adapter operations explicitly; do not fill them with successful stubs.
- [x] Test all adapter lifecycle methods, duplicate request handling, close/reset isolation and capability discovery.
- [ ] Retain a communications run through the common interface with raw network receipts matching the original scorer.

**Example rejection:**

```js
const candidate = { ...validObservation,
  metric: 'water.flow', quantity: { value: 1, unit: 'W' } };
assert.deepEqual(validateEnvelope(candidate), { ok: false, code: 'unit_mismatch' });
```

**Run:** `node --test test/lifeline/infra/contracts.test.mjs test/lifeline/infra/clock.test.mjs test/lifeline/infra/adapter-conformance.test.mjs`.

**State (Nov 1):** `active` in [P03 run 0](../../trials/lifeline-infra-p03-run-0.md): contracts, clock and adapter conformance qualified; the live adapter-driven run remains.

**Gate:** One real adapter passes conformance and rejects incompatible physics/identities. Defining the interface alone does not qualify a new domain.

## P04 — Arbitration, authority and partial execution

**Entry:** P03 and P01 timing contract.

**Files:** Create `src/lifeline/kernel/arbiter.mjs`, `plans.mjs`, `coordinator.mjs`, `test/lifeline/infra/arbiter.test.mjs`, `plans.test.mjs`, `coordinator.test.mjs`.

- [x] RED: an 18-second investigation cannot hold a lock needed by immediate recovery. A plan for revision 4 cannot execute after revision 5 without revalidation.
- [x] Implement capability-scoped authority, bounded execution slots, action dependencies, expiry, conflict detection, current-state checks and cancellable investigations.
- [x] RED/GREEN: inject partial completion between two actions. Read back actual state, mark the receipt partial, and select only a declared compensation or stop path. Do not assume multi-domain atomicity.
- [x] Test observe/recommend/approve_each/bounded_auto separately; approve a precise plan identity and reject changed content under the same approval.
- [x] Test plan supersession, missing acknowledgements, reconnection, idempotent retries, manual override and a provider burst that would otherwise starve local control.
- [x] Retain event traces showing which proposal won and why; record maximum local-control scheduling delay under model/solver load.

**Run:** `node --test test/lifeline/infra/arbiter.test.mjs test/lifeline/infra/plans.test.mjs test/lifeline/infra/coordinator.test.mjs`.

**State (Nov 1):** `qualified` in [P04 run 0](../../trials/lifeline-infra-p04-run-0.md); frozen local-control budget p95 ≤ 10 ms, max ≤ 100 ms.

**Gate:** Every mutation has a valid grant and lifecycle; baseline control meets its frozen scheduling budget. The budget is established from P01 measurements, then frozen before qualification.

## P05 — Service accounting and private evaluation

**Entry:** P03.

**Files:** Create `src/lifeline/kernel/measurement.mjs`, `runtime/infra/scoring.py`, `test/lifeline/infra/measurement.test.mjs`, `runtime/infra/tests/test_scoring.py`, `fixtures/lifeline/infra/analytic-service-cases.json`.

- [x] Define immutable demand schedules and independent supplied-quality observations. Power uses unserved energy; water uses unmet demand subject to pressure/quality; communications uses unique on-time receipts.
- [x] RED: shedding demand cannot shrink the denominator; two retries cannot count as two served messages; missing observations cannot score as delivered supply.
- [x] GREEN: implement per-service deficit integrals and predeclared normalized service scores. Keep component metrics beside any composite facility metric to expose double counting.
- [x] Test ten-second 50% supply against a hand-calculated deficit, tank reserve exhaustion, complete partition, zero demand, censored recovery and quality below the usability threshold.
- [x] Isolate evaluator-only truth and independently recompute outcomes from raw records. Delete controller explanations and verify scores are identical.
- [x] Test that both missing capture and a method-caused service loss remain visible with different statuses. The invalid-run rules come from the frozen protocol.

**Run:** `node --test test/lifeline/infra/measurement.test.mjs` and `python3 -m unittest discover -s runtime/infra/tests -p test_scoring.py`.

**State (Nov 1):** `qualified` in [P05 run 0](../../trials/lifeline-infra-p05-run-0.md).

**Gate Q1:** P00–P05 evidence exists; every metric has an independent denominator, unit, quality rule and missing-data policy. This qualifies infrastructure plumbing, not power/water operation.
