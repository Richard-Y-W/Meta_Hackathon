# LIFELINE Evaluation Protocol and Claim Gates

**Version:** Planning baseline, October 31, 2026. **Status:** Proposed protocol; no LIFELINE performance results exist. Numeric thresholds below are development targets until frozen in `fixtures/lifeline/protocol-v1.json` before evaluation.

**Purpose:** Determine whether LIFELINE preserves essential message delivery during compound failures beyond what a competent conventional controller achieves with the same information and control authority.

**Design:** [Emergency communications design](../superpowers/specs/2026-10-31-lifeline-design.md). **Tasks:** [Living program](../superpowers/plans/2026-10-31-lifeline-program.md). **Observed results:** [Run register](../trials/lifeline-run-register.md).

## 1. Claims under test

| ID | Proposed claim | Required evidence | What does not establish it |
| --- | --- | --- | --- |
| C1 | The prototype controls a packet network and measures service outcomes | Real sender/receiver records, effect receipts, independent scoring | A graph animation or mocked adapter |
| C2 | Meta participates in actual investigation or intervention | Real API trace tied to a probe or action and its outcome | A generated explanation after a local controller already chose |
| C3 | The system handles the declared compound failures | Repeated scenario results including second failures and interruptions | One edited recovery clip |
| C4 | AI improves essential-service preservation over the strong baseline | Frozen paired comparison with uncertainty and cost reporting | Beating only no-action or random control |
| C5 | The proposed mechanism causes the improvement | Ablations under matched observations, budgets and workloads | A correlation between model use and success |
| C6 | The system generalizes within a declared network domain | Disjoint topology/fault-composition holdout and locked settings | Different seeds of a tuned scenario alone |
| C7 | The approach contributes beyond prior research | Current prior-work review and appropriate reproduced comparisons | A new name or domain applied to an established loop |
| C8 | Operators or real services benefit | Qualified operator or field evidence | Extrapolating synthetic message counts into lives saved |

The first release may support C1–C3 and a preliminary version of C4. C5–C8 require later evidence. Record unsupported claims explicitly in the release note.

## 2. Primary outcome and denominator

For an evaluation interval, let `N` be the number of essential logical messages scheduled by the immutable offered-workload manifest. Let `K` be the number of those messages whose earliest valid receipt arrives no later than `created_at + deadline`. The primary outcome is `K / N`.

The sender records a logical message before transmission. Retries keep the same message ID. Late messages, lost messages, and messages prevented from being transmitted by controller behavior stay in `N`. An acknowledgement is evidence for the sender's retry logic; the destination receipt is the authority for destination delivery.

Use `null` when `N = 0`. Missing sender or receiver capture makes the run incomplete until reconciled; it cannot be converted to a favorable delivery rate. Stop the sender at the evaluation horizon, then retain the deadline tail before final scoring.

The primary scored interval is from the first incident at 20 seconds through the episode horizon at 120 seconds. Retain warm-up as a diagnostic, not part of the primary recovery score. Score each service separately as well as the pooled predeclared population. Service priority and offered rates are fixed before the run.

## 3. Secondary outcomes

| Outcome | Definition and caveat |
| --- | --- |
| Service deficit | `1 - deadline_delivery_rate`, plus lost/late counts by service |
| Recovery time | Time from an incident to the first sustained 10-second interval meeting the frozen per-service delivery threshold; unrecovered episodes are censored, not dropped |
| Proposed recovery threshold | At least 95% on-time delivery for every essential service during that interval; freeze before evaluation |
| Background service | Delivered background bytes divided by independently scheduled offered bytes; report intentional shedding separately |
| Latency | Receipt latency distribution for delivered messages, always beside loss/late counts |
| Retry amplification | Total essential transmissions divided by essential logical messages offered |
| Interventions | Proposed, rejected, started, confirmed, partially applied and compensated operations |
| Probe cost | Probe packets, bytes, runtime, and fraction of network load |
| Provider cost | Actual requests, timing, usage fields, failures, and estimated spend using the recorded applicable price schedule |
| Constraint outcomes | Type and count of attempted violations, rejected violations, and actual executed violations |
| Runtime overhead | Supervisor/worker CPU and memory, host load, and controller decision time |
| Prediction quality | Predicted versus observed service effects, interval coverage, optimistic errors and unsupported cases |

No single latency percentile substitutes for the primary delivery outcome: a controller that loses slow messages can make delivered-message latency look better.

## 4. Controller matrix

| Controller | Purpose | Information and control |
| --- | --- | --- |
| Fixed configuration | Demonstrates fault consequences | Frozen initial routing; diagnostic only |
| Priority-aware failover | Simple competent reference | Observed link state, operator priorities, alternate routes, permitted background throttling |
| Adaptive conventional supervisor | Primary comparator | Same telemetry, capacity estimation, bounded active probes, feasible route/rate search, hysteresis, guard and executor |
| LIFELINE with Meta | Proposed method | Same boundary plus model-guided hypotheses, probe selection, evidence-linked belief updates and proposals |
| Schema-inspired structured-model loop | Mechanism comparison | Persistent structured model, backtesting, planning and per-action checks under matched model/compute limits |
| Hidden-state oracle | Diagnostic ceiling | Explicit access to true current capacity; never presented as a fair implementable baseline |

The adaptive supervisor must pass simple known-capacity optima and recoverable outage controls before its use as a comparator. It receives the same immediate failover layer as the AI-assisted system. All adaptive methods receive the same permitted action set, observations, preconditions, probe caps, and effect execution logic.

The Schema-inspired implementation is a bounded reproduction of a workflow, not the authors' system. It does not justify saying LIFELINE outperforms Schema. A direct comparison requires obtaining and verifying an appropriate adaptation of the released code, version, prompts, and execution budget.

Its concrete V1 loop is: update the persistent structured belief from observations, backtest its predictions against retained transitions, select a probe or route/rate plan, execute through the shared guard, and interrupt on prediction error. Match the base model, token/call limits, counterfactual estimator, observations, and action budget to LIFELINE. LIFELINE's additional incident scheduling and service-preservation policy must be named in the comparison; if the implementations become behaviorally identical, collapse them into one method rather than manufacture a distinction.

Conventional traffic engineering already optimizes network use and policy priorities. SWAN also addresses transient congestion during updates. These are reasons to use a strong baseline and test transition states, not features to claim as newly invented here. [SWAN](https://research.google/pubs/achieving-high-utilization-with-software-driven-wan/), [B4](https://research.google/pubs/b4-experience-with-a-globally-deployed-software-defined-wan/).

## 5. Fairness and information boundaries

- Run the same workload schedule, initial capacities, incidents, and offered message IDs for each paired scenario. Keep controller execution order randomized with a retained seed.
- Use actual continuous wall-clock operation for packet experiments. Model calls, probes, and compensation consume time while traffic runs.
- Supply observation age and missingness to every controller. Do not give the AI detailed telemetry while starving the baseline.
- Charge diagnostic operations against common probe and actuation budgets. A model-generated command has no privileged path around a rejected action.
- Keep hidden impairment values, future fault schedules, and benchmark labels outside prompts, controller APIs, and controller-visible file access.
- Freeze baseline tuning and AI prompts before held-out execution. Any tuning on held-out outcomes creates a new development set and requires a new holdout for further generalization claims.
- Log all attempts. A timeout, invalid model decision, or unsuccessful recovery remains a method outcome. Do not drop it as inconvenient data.
- Separate infrastructure-invalid runs from method failures using predeclared rules. An infrastructure-invalid paired case is rerun for all controllers, while retaining the original attempt records.
- Use sequential paired runs for formal scoring unless concurrent emulator isolation is demonstrated. Common seeds do not make Linux scheduling and packet timing identical.

## 6. Scenario populations

### Contract and analytic controls

Use hand-checkable tiny networks for route feasibility, flow conservation, known-capacity allocation, stale evidence, infeasible policy, and counterfactual assumptions. These qualify code behavior and identify mistakes; they are not the performance benchmark.

### Development pilot

Freeze eight development cases for the first comparison:

1. No fault and no overload.
2. One direct-link outage with adequate backup capacity.
3. One outage with competing background load.
4. A link that stays up while capacity falls.
5. Outage followed by capacity reduction on a backup path.
6. Outage plus a scheduled traffic surge and retries.
7. Compound failure with delayed telemetry.
8. A partition that makes one essential service unreachable.

Run `priority`, `adaptive`, and `meta` twice per case: 48 episodes. At 120 seconds each, packet time alone is 96 minutes, excluding setup, deadline tails, provider preflight, and interruptions. This small pilot is exploratory development evidence. Do not interpret it as a powered population study.

### Held-out qualification

Before creating the final split, freeze the generator and sample ranges. Development, validation, and evaluation populations must differ by topology lineage or fault composition, not only by random seed. Canonicalize topology identity and retain parent/derived relationships to detect leakage.

The initial research target is 30 held-out scenarios: five cases in each of six predeclared strata—topology shift, capacity-parameter shift, unseen fault combinations, telemetry degradation, retry/traffic interaction, and impossible-recovery or no-fault controls. Run three repetitions and four controllers (`priority`, `adaptive`, `meta`, and the labeled Schema-inspired baseline): 360 episodes, approximately 12 hours of packet time before overhead.

This research target is outside the minimum hackathon release. Before freezing it, use measured provider usage and wall-clock cost to decide whether it is affordable. If a smaller suite is necessary, set its size and intended claim before inspecting evaluation results. The protocol must not silently downsample losing cases.

The owner or an independent evaluator can retain evaluation fault schedules outside the controller workspace until execution. A hash commitment records which suite was selected; it does not itself make a suite secret from the developer or prove that no tuning occurred.

## 7. Contribution ablations

| Ablation | Change | Question |
| --- | --- | --- |
| Remove Meta | Use the adaptive conventional supervisor | Is the model adding measurable value? |
| Remove active probing | Keep passive observations and ordinary actions | Does information acquisition explain the gain? |
| Freeze beliefs | Keep initial capacity assumptions | Does adaptation matter? |
| Remove persistent evidence | Supply only the current observation under the same budget | Does accumulated knowledge help? |
| Improve telemetry | Supply fresh complete observable counters to all methods | Is the benefit confined to missing information? |
| Remove second failure | Keep only the first incident | Does compound failure distinguish the method? |
| Equal-cost comparison | Limit model and conventional search by declared resource envelopes | Does the benefit survive cost accounting? |

Never remove the action guard in a live packet run to make an ablation more dramatic. Test guard importance with deterministic rejected-action controls and audit attempted violations. A safety-boundary ablation is not required to expose an unsafe network control path.

## 8. Analysis and promotion rules

Compute paired differences in primary delivery rate by scenario, aggregating repetitions within each scenario. Report the mean paired difference, median, per-stratum values, all-case scatter, and the worst observed deficit. Use a bootstrap over scenario groups for a 95% uncertainty interval; do not treat millions of correlated packets as independent observations.

An initial target for a meaningful improvement claim is at least **five percentage points** higher mean on-time essential delivery than the frozen strong baseline on recoverable failure scenarios, with a paired 95% interval above zero. Also require no more than **one percentage point** regression on no-fault controls, zero executed hard-policy violations, and disclosed background-service and resource costs. These are project targets, not findings or universal deployment thresholds.

Report the full population, including partitions and no-fault controls, beside that recoverable-failure analysis. Recovery feasibility is defined by the scenario construction and independent capacity/path check before controller outcomes are inspected.

If the target is missed, publish the actual effect and uncertainty. If intervals are wide, label the result inconclusive. If the baseline wins, retain that finding. G4b can complete as an evaluation even when C4 remains unsupported.

Prespecify exploratory analyses as exploratory. Do not pick the best metric, seed, controller checkpoint, or fault subset after seeing results and present it as the original primary comparison.

## 9. Run validity and artifact contract

Every run bundle contains:

```text
manifest.json
events.jsonl
offered.jsonl
receipts.jsonl
action-receipts.jsonl
provider-events.jsonl
environment.json
summary.json
checksums.json
```

The manifest records the code commit, dirty-tree identity if any, protocol and scenario identities, controller configuration, model/prompt identity, runtime versions, workload, budgets, host, start/end, and terminal status. Never publish credentials, bearer headers, or private participant data.

`events.jsonl` includes observations, hypotheses, forecasts, attempts, rejected actions, confirmations, compensation, provider errors, and run interruption. The offered/receipt files support independent score recomputation. The comparison index includes every scheduled and attempted run and explains any infrastructure-invalid status.

Infrastructure-invalid examples are a host crash before complete capture, a corrupted workload manifest, or failed isolation that mixes traffic from two runs. Model timeout, model error, controller crash, bad proposal, partial action, and failed recovery are controller outcomes when the environment can continue measuring them. Retain a stopped or crashed controller's fixed-policy continuation when possible; otherwise report incomplete outcome and its count explicitly rather than silently scoring a partial horizon.

For an incomplete method run, report a delivery interval: the lower bound treats unobserved scheduled messages as not delivered on time, and the upper bound treats them as delivered on time. These are bounds, not invented observations. Keep the run in the comparison population. An improvement claim must survive the conservative treatment of incomplete AI outcomes and optimistic treatment of incomplete comparator outcomes, or remain unqualified pending complete measurements.

Replay verifies ledger continuity, identities, contract decisions, receipt linkage, and metric recomputation. It does not regenerate identical kernel timing or prove counterfactual causality from one trace.

## 10. Novelty boundaries

Schema already supplies persistent executable environment models, historical consistency checks, planning, and verification during action. LIFELINE's use of an investigation loop does not establish a new learning paradigm. [Schema paper](https://arxiv.org/html/2609.39140v1).

The candidate contribution is a measured improvement in service preservation under explicitly defined failures, incomplete observations, limited experimentation, and continuous decision latency. Whether that combination is a research advance remains a question for the current prior-work review and controlled evaluation.

Do not claim first autonomous network recovery, first AI resilience system, first causal agent, first cross-domain infrastructure controller, or real-world emergency effectiveness from V1. Each is broader than the proposed evidence.

For the longer-term coupled-infrastructure vision, existing work already models interdependent power, water, and transport failures and restoration. Evaluate the new decision capability against such work rather than presenting interconnection itself as the contribution. [InfraRisk](https://arxiv.org/abs/2205.04717).

## 11. Hackathon rubric to evidence

The final-project weights below are from the organizer's official rules, reviewed October 31, 2026. They differ from the application scoring. [Official rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver).

| Criterion | Weight | Project evidence |
| --- | --- | --- |
| Impact | 30% | Specific operator, essential-service outcome, measured preserved delivery, credible next pilot |
| Use of Meta AI tooling | 25% | Real model-led diagnosis/probe/intervention, usage trace, model-removal comparison |
| Demo | 25% | Working two-failure scenario, visible receipts and baseline, rehearsed interruption handling, clear video |
| Technical depth and execution | 20% | Packet backend, strong controller, typed actions, partial-effect recovery, test evidence and reproducible evaluation |

Novelty has no separate numerical category in these published weights. It strengthens the impact, tooling, and execution story when supported by evidence. The plan therefore prioritizes a useful measured result and a convincing live demonstration, while retaining a separate research claim gate.

## 12. Source and assumption record

| Source | Supports | Does not establish |
| --- | --- | --- |
| [Mininet overview](https://mininet.org/overview/) and [setup](https://mininet.org/download/) | Packet emulation with Linux networking; Linux environment options | Physical radio fidelity or the quality of this implementation |
| [Open vSwitch documentation](https://docs.openvswitch.org/en/latest/tutorials/ovs-advanced/) | Available switch behavior and programming primitives | Atomicity of a multi-switch update or a qualified LIFELINE adapter |
| [Meta API overview](https://dev.meta.ai/docs/overview) | Responses API and listed model identifiers | Account access, measured latency, or project improvement |
| [Schema](https://arxiv.org/html/2609.39140v1) | Prior interactive model-building and verification workflow | Infrastructure resilience or performance of a new adaptation |
| [SWAN](https://research.google/pubs/achieving-high-utilization-with-software-driven-wan/) | Existing priority-aware traffic engineering and transition-congestion concerns | An implemented baseline in this repository |
| [B4](https://research.google/pubs/b4-experience-with-a-globally-deployed-software-defined-wan/) | Established production software-defined traffic engineering | A direct benchmark match to emergency networks |
| [InfraRisk](https://arxiv.org/abs/2205.04717) | Prior interdependent infrastructure simulation | Novelty of LIFELINE's future coupled control |
| [Event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) and [rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) | Published dates and judging criteria | Unread authenticated submission-field requirements |

All rates, timeouts, scenario counts, promotion thresholds, and release dates inside the plan are proposed project settings unless explicitly attributed to an external source. Freeze or revise them through a recorded decision before they govern an evaluation.
