# LIFELINE Infrastructure Evaluation and Breakthrough Ledger

**Status:** Proposed full-program protocol, November 1, 2026. No power, water, coupled-infrastructure, transfer or field benefit has been measured. Numerical targets below are planning targets; P17 must freeze the exact study before evaluation.

**Program:** [Living master](../superpowers/plans/2026-10-31-lifeline-program.md). **Design:** [Infrastructure behavior](../superpowers/specs/2026-11-01-lifeline-infrastructure-design.md). **Historical evidence:** [Communications protocol](lifeline-evaluation-protocol.md), [pilot run](../trials/lifeline-pilot-run-0.md), [run register](../trials/lifeline-run-register.md).

## 1. Questions the program must answer

1. Can the same decision lifecycle operate qualified power, water and communications adapters?
2. Can it forecast a developing service loss early enough to permit a useful action?
3. Does joint planning preserve more service than independent local control?
4. Does Meta-assisted investigation/planning improve on competent conventional joint planning?
5. Does adaptation help on unfamiliar mechanisms, layouts and dependencies under partial observations?
6. Do those gains remain when time, cost, uncertainty, physical constraints and operator authority are counted?
7. Do operators or a named real site benefit?

Answer these separately. A successful domain integration answers question 1. A good interface or correct explanation does not answer questions 3–7.

## 2. Current evidence boundary

V1 contains 48 first-attempt episodes from eight cases, three controllers and two repetitions. There were also nine withdrawn reruns following a replay-classification bug and scratch exhaustion. Original outputs and the correction record remain retained.

Meta minus adaptive averaged **−1.35 percentage points over the six recoverable failure cases**, with two material losses and six ties at reported precision across the full eight cases. Across all eight cases the mean is approximately −1.01 points. Adaptive is the primary comparator, not the best conventional policy on every individual case.

The current evidence supports actual packet experiments, live model participation and bounded failure handling. It does not support an AI improvement claim. The integration repair is untested in this revision. V1 scenarios are now seen data and cannot establish new held-out generalization.

## 3. Service metrics and policy

For service s with immutable requested demand d_s(t) and independently observed usable supply q_s(t):

```text
unmet_s = integral max(0, d_s(t) - min(d_s(t), q_s(t))) dt
D_s = unmet_s / integral d_s(t) dt
S = 1 - sum(w_s * D_s) / sum(w_s)
```

For discrete messages, use scheduled unique logical messages and their earliest valid on-time receipt. If offered demand is zero, the service score is null and the aggregation rule is declared before the run. Missing capture is not zero deficit.

| Domain | Raw primary quantity | Usability and secondary measures |
| --- | --- | --- |
| Power | Unserved essential energy | Voltage/thermal conditions, outage duration, supply ramps, storage reserve, switching and shedding |
| Water distribution | Unmet usable volume | Pressure requirement, tank reserves, low-pressure duration, pump energy and cycling |
| Treatment | Output failing the qualified process service requirement | Explicit process/quality model, residence/buffer behavior, off-spec duration and resource use |
| Communications | Lost/late essential logical messages | Per-flow deadline delivery, latency beside loss, background throughput, probe/retry cost |
| Transport/repair | Time-integrated service deficit during restoration | Arrival/repair times, crew/parts use, access constraints |
| Facility continuity | Time meeting declared compound service requirements | Separate component service scores, reserve trajectories and failure cause |

Weights, priority tiers, quality thresholds, nonessential service floors and acceptable tradeoffs are operator/scenario policy, frozen before evaluation. Publish them. A model cannot change weights or demand after seeing a failure. Do not add facility continuity to its component scores as if the same preserved service were independent benefit twice.

Use lexicographic protection of hard operating limits and declared service tiers, then explicit tradeoffs among feasible plans. When external conditions make the policy infeasible, report violation/deficit and mitigation rather than declaring a feasible solution. Distinguish preexisting/exogenous violations from those induced or worsened by the controller.

Report the aggregate beside every service group, worst-family result, noncritical harm, recovery censoring, resource expenditure and constraint event. Scores cannot substitute for these details.

## 4. Breakthrough ledger

All B claims currently have status **unproven**, with these study outcomes recorded (Nov 3, 2026):

- **B2 (research-v1, P18): not supported.** Contradicted against independent control (95% interval [−1.64, 0.00] pp, below the 0.5 pp margin) and inconclusive against coordinated conventional control ([−1.37, +0.64] pp). The Meta model changed no decision. [Run note](../trials/lifeline-infrastructure-comparison-run-0.md).
- **B5 (research-v1): contradicted.** The critical-group lower bound was −2.2 pp for hospital and fire water.
- **B1 (research-v1): exploratory signal only.** One positive anticipatory group out of two.

| ID | Hypothesis and mechanism | Comparison | Proposed qualification target | Falsifier |
| --- | --- | --- | --- | --- |
| B1 | Forecast-guided action prevents avoidable secondary service loss | Matched reactive and predictive conventional control; same information/actions | Positive paired benefit with 95% interval excluding zero; at least 10% relative deficit reduction and 0.5 percentage-point S gain on the frozen anticipatory population; warning precedes loss by more than required execution time | Warning arrives late, no usable action exists, benefit vanishes against predictive control, or false alarms cause comparable harm |
| B2 | Cross-domain Meta-assisted coordination adds useful service preservation | Both independent domain control and strong coordinated conventional control | Same practical/statistical benefit target versus each prespecified comparator, with per-domain regression limits and no new executed hard-limit violation attributable to the method | Gain exists only against independent control, arises from extra information/resources, or hides damage to another domain |
| B3 | Online revision of an unfamiliar mechanism improves decisions | Fixed structured models, conventional adaptive identification, persistent-model reasoning comparator | Positive service gain and predictive improvement on a held-out mechanism family; improvement exceeds matched probe/compute cost | Only a known parameter changed, the prompt contains the answer, or a simpler estimator performs equally well |
| B4 | Shared reasoning/model knowledge transfers usefully | Frozen core with/without relevant memory, specialized/adaptive baselines, wrong-memory control | Reduced adaptation experiments or developer effort with service noninferiority; useful learned transfer additionally requires positive held-out outcome/adaptation gain | Incident-specific adapter/prompt tuning, no benefit from memory, or harmful transfer beyond the frozen margin |
| B5 | Benefit survives uncertainty, delay and outages | Same controllers across stress profiles and matched resource budgets | No-fault/per-critical-group S regression lower bound above −0.5 points; continued local control; retained benefit in declared disturbance strata | Stale action executes, model failure suppresses recovery, benefit requires perfect sensors or instantaneous inference |
| B6 | Operators obtain practical value | Existing workflow and conventional recommendations in a counterbalanced study, then site-specific baseline | Prespecified improvement in decision quality/time with service noninferiority and no increase in critical operator errors | Better subjective explanations without task benefit, selective favorable recommendations, or unobserved field counterfactual treated as fact |

These targets are deliberately falsifiable, not a prediction of success. A near-perfect comparator may leave less than the proposed absolute margin; freeze a different adequately motivated study before evaluating, or report that the target is unattainable in that population. Never lower a threshold after seeing held-out outcomes and retain the original claim.

For B3/B4/B6, P17 or the relevant later study must set a practical margin from development variance and the specific resource/task unit before execution. Until that numerical choice is frozen, the study is exploratory and cannot qualify the claim.

No observed hard-limit violations is a finite experimental result, not a guarantee of safety outside the admitted envelope.

## 5. Controller matrix and fairness

| Controller | Role |
| --- | --- |
| Fixed/no-action | Diagnostic cascade control; not the main superiority comparator |
| Independent local/domain controllers | Measures value of cross-domain coordination |
| Coordinated priority policy | Simple strong alternative; may beat more elaborate methods |
| Coordinated rolling-horizon optimizer with estimation | Main conventional comparator |
| Meta-assisted joint coordinator | Proposed method, retaining the full local control layer |
| Model-off/narrator-only variants | Separate control contribution from interface/explanation |
| Adaptive identification and persistent-model methods | Mechanism/transfer comparison where applicable |
| Private perfect-information oracle | Headroom and infeasibility diagnosis only |

Select the strongest conventional configuration using development data and lock it. Retain other baseline results; do not choose the easiest comparator afterward. On tiny cases verify optimization by exhaustive feasible enumeration; record solver gaps and failure handling elsewhere.

All implementable methods receive the same nominal equipment information, admitted observations, observation ages, prior engineering knowledge, action catalog, authority and limits. They use the same executor and independent scorer. Give conventional methods a comparable development effort and computational allowance. They need not waste budget on model calls they do not use.

Actual inference, search, probes, actuation and recovery consume time and resources. Count provider timeouts and retries. In accelerated mode use the declared wall-to-simulation mapping for every method. Report modeled communications separately from actual packet experiments.

A forecast controller only forks its admitted estimated model. Evaluator-private branches can establish simulation counterfactuals but are never supplied as an oracle planner.

## 6. Scenario families and separation

| Family | Purpose | Required variation |
| --- | --- | --- |
| Stable/no fault | Detect needless intervention | Workload/noise differences and harmless warnings |
| Observable developing threat | Test anticipation | Lead time above/below feasible intervention time |
| Abrupt incident | Test mitigation | No advance knowledge of unobservable shocks |
| Compound failure | Test replanning | Different second fault, order and timing |
| Delayed dependency | Test coordination | Water/backup reserves, pump load feedback, control loss |
| Model mismatch | Test adaptation | Wrong parameters versus genuinely absent mechanism |
| Partial observation | Test information use | Delay, missingness, bias, conflicting measurements |
| False alarm | Price preventive action | Threat that does not materialize |
| Impossible recovery | Test limits and honest accounting | Isolated supply, exhausted reserves, unavailable actions |
| No useful coupling | Detect manufactured coordination gains | Independent resources or inactive dependency |
| Common-cause event | Separate direct from propagated effects | Correlated initial damage with causal edge controls |
| Resource/authority constraint | Test realistic choices | Shared crews/fuel, refused actions, local control autonomy |

Maintain separate development, regression, frozen evaluation, and external replication sets. Split by topology/dependency/mechanism family; different seeds of a seen incident are repetitions, not new generalization.

Audit isomorphic graphs, renamed assets, derived schedules, prompts, retrieval files and adapter code. Record what the foundation model may have encountered publicly; do not claim public benchmark cases are certainly absent from its training data.

A proposed pilot budget is 12 scenario groups × 2 repetitions × 3 primary controllers = 72 runs. A research planning point is 60 independent scenario groups across at least 10 topology/dependency families × 3 repetitions × 3 controllers = 540 runs. These counts do not guarantee adequate power. Use development variance to decide the final precision/sample budget before freezing; reduce scope transparently if resources cannot support it.

## 7. Inference, uncertainty and stopping

The independent sampling unit is the scenario group or family, as justified by generation; packets and closely related repetitions are not independent trials. Compute paired controller differences, aggregate repetitions within scenario, and account for family dependence. Retain a prespecified cluster/bootstrap or randomization procedure with its assumptions; small family counts limit interval precision.

Predeclare the primary population, primary comparator(s), hypothesis order and multiplicity handling. B1–B6 are separate studies; do not search all outcomes and present the best as the primary result. Report effect sizes and intervals, not a p-value alone.

Use a fixed batch or a prespecified sequential procedure. No favorable early stopping. Record all attempts, exclusions, infrastructure issues, method failures and replacements.

- Provider failure, invalid model output, stale proposals, bad actions and failure to recover are method outcomes.
- An independent evaluator/storage failure can be infrastructure-invalid only under a frozen rule with evidence.
- If a paired scenario is rerun for infrastructure reasons, retain the original attempts and rerun all affected comparators as prescribed.
- A controller-caused plant collapse remains an adverse outcome. Missing logs cannot turn it into a convenient exclusion.
- Operator-stopped live demos are retained and unscored unless a separately frozen protocol defines an interruption metric.

Report planned versus completed runs and the reason for any shortfall. An incomplete experiment cannot satisfy a completed qualification gate.

## 8. Prevention, causality and falsification

Record forecast time, predicted service-loss time interval, available intervention duration and actual action completion. Prevention requires action before the relevant loss, not merely recovery after it.

For simulation causality, branch matched episodes from the same pre-decision plant state with identical exogenous demands/faults but different interventions. Keep branch truth private. Measure the resulting physical/service trajectories. Repeat across cases, not just a selected successful scene.

Run these negative controls:

1. Remove the allegedly causal dependency; the claimed cross-domain effect should change appropriately.
2. Add enough reserve or remove the constraint; the need for the intervention should disappear.
3. Delay the action beyond the opportunity window; prevention should no longer be credited.
4. Replace the model with the conventional choice or narrator-only output; isolate its actual contribution.
5. Preserve intervention but randomize irrelevant labels; decisions should not depend on case names.
6. Inject an incorrect hypothesis or stale memory; contradictions should reduce its influence.
7. Test an avoidable warning and a false alarm; count the price of acting unnecessarily.
8. Tighten the observation boundary; a gain that depended on hidden truth must disappear and be invalidated.

For field operation, an unobserved alternate future is not directly measured. Report counterfactual estimates with assumptions, and use an appropriate prospective/operator study before claiming causally improved service.

## 9. Forecast and adaptation measurements

Measure calibration and usefulness together: event-probability reliability/Brier score where probabilities are produced, interval coverage and width, timing error, warning lead time, false alarms, missed threats and downstream decision benefit.

Do not infer forecast error from a prevented outcome alone; evaluate a retained forecast-only or matched counterfactual rollout. Avoid evaluating an intervention forecast against a different executed plan.

For model adaptation record: original model, contradiction, revised hypothesis, backtest, information-gathering action, forward prediction, acceptance/retirement, service effect and resource cost. Separate parameter estimation, topology/dependency inference and new-mechanism representation. They support different claims.

Transfer evidence includes model/core/prompt hashes before the new task, permitted adapter work, engineering hours, experiments to competence and wrong-transfer controls. A common API demonstrates software reuse; it does not itself demonstrate learned transfer.

## 10. Prior work and novelty boundary

| Established work | What it already covers | What LIFELINE must separately establish |
| --- | --- | --- |
| [InfraRisk](https://arxiv.org/abs/2205.04717) | Interconnected power/water/road simulation, failure/restoration and heuristic/MPC repair planning | Useful online decisions under partial observations and unfamiliar interacting failures beyond a strong joint comparator |
| [Grid2Op](https://grid2op.readthedocs.io/en/latest/) | Sequential power-grid decisions and evaluation of many controller classes | A measured contribution, not merely plugging a model into grid actions |
| [NetPilot](https://scholars.duke.edu/publication/807203) and [SWARM](https://www.usenix.org/conference/nsdi25/presentation/namyar) | Automated network mitigation and performance-aware action selection | Benefits beyond established diagnosis/mitigation under matched conditions |
| [Schema](https://arxiv.org/abs/2609.39140) and [WorldCoder](https://arxiv.org/abs/2402.12275) | Executable/persistent model learning and planning | Infrastructure-specific evidence for adaptation, constraints, timing and service benefit |
| [Simplex architecture](https://www.sei.cmu.edu/library/an-architectural-description-of-the-simplex-architecture/) | Combining advanced control with a trusted baseline | Qualification of this implementation; fallback alone is not a new invention or safety proof |
| [WNTR](https://usepa.github.io/WNTR/), [pandapower](https://pandapower.readthedocs.io/en/latest/) | Established domain modeling foundations | Correct integration, added decision capability and independent outcome evidence |

This is a starting claim audit, not an exhaustive literature review. P17/P20/P31 must update the nearest executable comparators and document adaptation choices before a novelty claim. Using multiple simulators, a dependency graph, an LLM, or a fallback controller is insufficient on its own.

The intended differentiator is **evidence-driven adaptation and timely coordinated intervention across qualified infrastructure domains under unfamiliar failures and incomplete information**. Whether that is a research contribution depends on the frozen comparisons.

## 11. Evidence bundle and claim promotion

Each run retains:

- Code/dirty-tree identity; scenario, solver, prompt, policy, adapter, model and protocol versions.
- Workload manifest, authority, time mapping, seed, hardware/resource envelope and dataset provenance.
- Raw admitted observations, separate private truth, commands/receipts, forecasts and model traces with secrets removed.
- Every attempt and error; independent measurements, score reconstruction, resource/cost records and comparison membership.
- A short statement of what the run supports and what remains untested.

Promote a claim only when its task, comparison, statistical/practical criterion and negative controls pass. Record the exact envelope and failures next to it. If a new run contradicts an old claim, retain both, reopen the claim and investigate.

The strongest eventual headline should be conditional on actual evidence: a named system preserved more essential service across a specified coupled-infrastructure benchmark or qualified pilot. Until then, the honest description is a working communications prototype and a planned infrastructure-wide resilience program.
