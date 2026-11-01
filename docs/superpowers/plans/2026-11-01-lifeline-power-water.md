# LIFELINE Power and Water — Implementation Plan P06–P10

> **For agentic workers:** Use `superpowers:executing-plans`; work inline unless separately authorized. Observe RED/GREEN and retain domain evidence before checking a task. These tasks implement required project breadth.

**Goal:** Qualify electrical and water models, actions, measurements and forecasts as working domains of the same coordinator.

**Architecture:** Python workers own domain calculations; typed Node adapters expose only admitted observations and capabilities. Conventional controls and independent measurements qualify each domain before coupling.

**Tech stack:** Python, pandapower, WNTR/EPANET, a separate Grid2Op benchmark adapter, Node ES modules, unittest/`node:test`. Pin selected versions and dataset licenses after compatibility checks.

**Depends on:** P03 contracts and P05 accounting; P04 before autonomous action. All commands and artifacts follow the [foundation convention](2026-11-01-lifeline-foundation.md).

## Shared domain acceptance record

Each adapter records supported assets/actions/faults, units, state variables, time model, restart/fork behavior, numerical tolerances, supported operating range, hidden evaluator fields, local control, solver failure behavior and license provenance. Require four controls: no fault, recoverable fault, physically unrecoverable fault, and corrupted/stale observation.

The first fixtures are small enough to inspect by hand. Qualification then uses a documented reference network with provenance. Freeze limits as scenario engineering assumptions; do not imply they are universal equipment or public-health standards.

## P06 — Electrical adapter and trusted measurements

**Files:** Create `runtime/infra/protocol.py`, `runtime/infra/power_pandapower.py`, `runtime/infra/checkpoints.py`, `runtime/infra/tests/test_power.py`, `test/lifeline/infra/power-adapter.test.mjs`, `src/lifeline/domains/power.mjs`, `fixtures/lifeline/infra/power/analytic.json`, `fixtures/lifeline/infra/power/reference.json`, `runtime/infra/requirements.lock`.

- [x] Implement a capability spike: initialize, solve, observe, change one admitted load/switch, advance, checkpoint, restore, and fork. Record timings and complete state required for repeatability, including storage and controller memory.
- [x] RED: a disconnected critical load must create unserved demand; a nonconverged solve cannot report full service; a stale command cannot switch a changed topology.
- [x] GREEN: return canonical W/Wh or J, V/per-unit with declared base, current/loading and timestamps. Expose only declared sensors. Private scoring reads actual supplied load independently.
- [x] Test a simple known-flow case, AC balance including losses, voltage/thermal bounds, islanded unsupplied loads, storage energy conservation, and response to unavailable generation.
- [x] Compare restored/forked rollouts with an uninterrupted reference within predeclared tolerances; test that a preview cannot mutate the live plant or read future faults.
- [x] Fail explicitly outside the admitted numerical/model envelope. Distinguish lack of a feasible operating point from solver failure using retained diagnostics.
- [x] Retain one reference-network run with source provenance and measurements checked independently of the controller.

**Behavioral specification:**

```python
before = plant.checkpoint()
preview = plant.preview(open_feeder_plan, admitted_model)
self.assertEqual(plant.checkpoint_hash(), before["hash"])
self.assertGreater(preview["essential_unserved_j"], 0)
```

Here `plant` is the adapter fixture implementing the design's lifecycle; `preview` returns a result record and never an execution receipt.

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p test_power.py`; `node --test test/lifeline/infra/power-adapter.test.mjs`.

**State (Nov 1):** `qualified` in [P06 run 0](../../trials/lifeline-infra-p06-run-0.md). pandapower 3.2.2 pinned; CIGRE MV reference run retained; infra environment is host-only until the guest is provisioned.

**Gate:** Electrical behavior, scoring and restart/fork are qualified. Do not claim transient stability, black start or protection correctness from a steady-state solution.

## P07 — Electrical control, prevention cases and Grid2Op profile

**Files:** Create `runtime/infra/power_control.py`, `runtime/infra/power_grid2op.py`, `runtime/infra/tests/test_power_control.py`, `runtime/infra/tests/test_grid2op_profile.py`, `fixtures/lifeline/infra/power/control-policy.json`, `fixtures/lifeline/infra/power/development.json`.

- [x] Define admissible electrical actions: explicit switch choices, redispatch/demand shifts and storage only where the selected model supports them. Include dwell/ramp/switching costs and actuator delay.
- [x] RED: reject overload-producing intermediate transitions, simultaneous incompatible switching, storage below reserve, an unavailable actuator and unauthorized shedding of a protected load.
- [x] GREEN: implement a local protection/recovery policy plus a competent predictive baseline using the same forecasts, actions and solver. On tiny finite cases compare its choice to exhaustive feasible enumeration.
- [x] Build gradual overload, generator/feeder loss, constrained backup, second-contingency and impossible-supply controls. A prevention case includes observable lead time; a completely unannounced instantaneous cut cannot establish advance prediction.
- [x] Add the separate Grid2Op adapter, pin its environment/action classes/backend and capture episode termination. Test mapping of legality/cooldowns, terminal failure and observation restrictions.
- [x] Do not continue a Grid2Op terminal episode as if restoration were simulated. Use the qualified coupled electrical backend for restoration studies and label which profile produced each result.
- [x] Measure essential unserved energy, outage duration, constraint events, nonessential shedding, action cost and recovery. Verify the baseline before comparing AI.

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p 'test_power_control.py'` and `python3 -m unittest discover -s runtime/infra/tests -p test_grid2op_profile.py`.

**State (Nov 1):** `qualified` in [P07 runs 0–1](../../trials/lifeline-infra-p07-run-0.md): development cases only; Grid2Op profile has its own acceptance record.

**Gate:** Power is a working controlled domain with a credible local/predictive comparator. The Grid2Op profile has its own acceptance record; a working pandapower adapter does not qualify Grid2Op results.

## P08 — Water distribution adapter and restart qualification

**Files:** Create `runtime/infra/water_wntr.py`, `runtime/infra/tests/test_water.py`, `src/lifeline/domains/water.mjs`, `test/lifeline/infra/water-adapter.test.mjs`, `fixtures/lifeline/infra/water/analytic.inp`, `fixtures/lifeline/infra/water/reference.inp`, `fixtures/lifeline/infra/water/provenance.json`. Extend `checkpoints.py` with backend-specific state.

- [x] Choose and pin the hydraulic backend after testing pressure-dependent shortage behavior, pump controls, tanks, leak/failure representation, restart and observation sampling.
- [x] RED: a pump outage must affect delivered demand or storage according to the equations; an isolated demand node cannot receive its requested demand by accounting convention.
- [x] GREEN: implement observations and measurements in canonical m, m3, m3/s and declared energy units. Use actual pressure-dependent supply for shortage scoring.
- [x] Test a tank's mass balance, reserve depletion time, closed valve, leak, pump unavailable, low-pressure service and zero demand. Compare a simple constant-flow depletion case against an analytic calculation.
- [x] Demonstrate a decision at an intermediate time and reproduce uninterrupted simulation from a checkpoint. Include tank levels, controls, elapsed time and any quality state.
- [x] If native stepping/restart is unsuitable, implement replay from the initial state plus the complete action history and verify equivalence; charge its computational cost. Reject unsupported closed-loop claims if neither method qualifies.
- [x] Retain numerical-tolerance and step-size sensitivity results; solver errors and missing capture remain explicit.

**Behavioral specification:**

```python
# Analytic control: 12 m3 usable storage, 0.01 m3/s net draw.
self.assertAlmostEqual(result["depletion_time_s"], 1200, delta=step_s)
self.assertGreater(result["unmet_m3_after_depletion"], 0)
self.assertFalse(result["quality_model_qualified"])
```

This tank control checks accounting; the reference network separately checks hydraulic pressure and pump behavior.

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p test_water.py`; `node --test test/lifeline/infra/water-adapter.test.mjs`.

**State (Nov 1):** `qualified` in [P08 run 0](../../trials/lifeline-infra-p08-run-0.md): EPANET 2.2 via WNTR 1.5.0, replay restart; the separate files `networks.json`, `requirements-water.lock` and `water_evidence.py` were added; `checkpoints.py` needed no backend-specific extension because the water state is the change history.

**Gate:** Distribution hydraulics and closed-loop state handling qualify. Hydraulic delivery alone does not establish potable-water quality or treatment-plant control.

## P09 — Water control and constrained preservation

**Files:** Create `runtime/infra/water_control.py`, `runtime/infra/tests/test_water_control.py`, `fixtures/lifeline/infra/water/control-policy.json`, `fixtures/lifeline/infra/water/development.json`.

- [x] Define pump states/schedules and valve settings with pressure, storage, actuator, cycling and reserve constraints. Expose only supported parameters; an arbitrary numeric pump speed is not automatically valid.
- [x] RED: a plan that improves one node while violating another protected node's minimum service must be rejected or scored as a policy violation, never hidden by an average.
- [x] GREEN: implement threshold/local recovery and a horizon-based pump/storage baseline. Give it the same demand forecast, observation delays and action set as LIFELINE.
- [x] Enumerate feasible schedules for a tiny network to verify the baseline and independent scoring.
- [x] Build pump loss, gradual leak, unavailable backup, low storage, demand surge, stale pressure and unrecoverable source isolation cases. Separate unknown demand from an unobserved asset failure.
- [x] Measure per-node usable delivered volume, unmet demand, reserve trajectory, low-pressure duration, electricity consumption and switching cost.
- [x] Retain a case where preemptive scheduling helps, one where acting early wastes resources, and one where no action can avoid loss.

**Run:** `python3 -m unittest discover -s runtime/infra/tests -p test_water_control.py`.

**State (Nov 1):** `qualified` in [P09 runs 0–1](../../trials/lifeline-infra-p09-run-0.md): development cases only; preemptive-helps, early-action-wastes and no-action-avoids-loss cases retained.

**Gate:** Water is a working controlled domain with a strong comparator, a measured benefit/cost tradeoff, and honest infeasibility handling.

## P10 — Forecast threats with lead time and calibrated uncertainty

**Entry:** P05, P07 and P09. P02 supplies the communications comparison.

**Files:** Create `src/lifeline/kernel/forecast.mjs`, `src/lifeline/kernel/threat-inputs.mjs`, `test/lifeline/infra/forecast.test.mjs`, `test/lifeline/infra/threat-inputs.test.mjs`, `scripts/lifeline-infra-forecast-check.mjs`, `fixtures/lifeline/infra/forecast-controls.json`.

- [x] Define forecast records with origin observations, model/configuration version, prediction horizon, interval/probability semantics, assumptions and validity range.
- [x] RED: a forecast created after service loss cannot count as an advance warning. A forecast given hidden future fault data must fail the information-boundary test.
- [x] GREEN: implement baseline consequences for current policy and candidate interventions using admitted estimated state. Propagate parameter/observation uncertainty with declared scenarios or ensembles.
- [x] Admit timestamped alarms, maintenance records, operator reports and external hazard forecasts through provenance/age checks. Test contradictory reports and a forecast that does not materialize; no input may expose future injected faults.
- [x] Test power overload progression, tank depletion, communications backup exhaustion and unavailable remote control. Include false alarms, harmless anomalies and cases without an observable precursor.
- [x] Compare predictions to independent future observations; measure lead time, calibration, interval width, optimistic errors and missed threats. A permanently wide interval does not qualify usefulness.
- [x] Test degraded/missing telemetry and explicit `unsupported` forecasts. Validate before allowing a forecast to justify autonomous action.
- [x] Retain forecast-only and action-enabled experiments separately so acting on a warning does not erase the evidence needed to assess its prediction.

**Run:** `node --test test/lifeline/infra/forecast.test.mjs test/lifeline/infra/threat-inputs.test.mjs`; then `node scripts/lifeline-infra-forecast-check.mjs --manifest fixtures/lifeline/infra/forecast-controls.json --out artifacts/lifeline/infra/forecast-run-0` after implementing that CLI.

**State (Nov 1):** `qualified` in [P10 runs 0–1](../../trials/lifeline-infra-p10-run-0.md): forecast-only controls; the power overload timing forecaster is not calibrated (coverage 0.40) and is recorded as such.

**Gate Q2 (Nov 1): met** for adapters, controls and scored forecasts, with the overload-timing forecaster recorded as uncalibrated. **Gate Q2:** Independently qualified power/water adapters and forecasts exist. B1 still requires the matched prevention experiment; accurate forecasting alone is not prevented service loss.

## References and modeling decisions

Official [pandapower](https://pandapower.readthedocs.io/en/latest/), [Grid2Op](https://grid2op.readthedocs.io/en/latest/), and [WNTR](https://usepa.github.io/WNTR/) documentation were checked November 1, 2026. Qualification records must pin the actual installed versions. This plan chooses these tools as candidate foundations; it does not assume their defaults satisfy LIFELINE's constraints or co-simulation requirements.
