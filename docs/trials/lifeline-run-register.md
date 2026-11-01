# LIFELINE Living Status and Run Register

**Updated:** October 31, 2026. **Project:** Emergency communications first; broader infrastructure resilience after domain-specific qualification.

**Program:** [Living plan](../superpowers/plans/2026-10-31-lifeline-program.md). **Behavior:** [Design](../superpowers/specs/2026-10-31-lifeline-design.md). **Claims and measurement:** [Evaluation protocol](../research/lifeline-evaluation-protocol.md).

## Current handoff

| Field | Current value |
| --- | --- |
| Current state | Tasks 2–7 qualified; G1 qualified; Task 1 provider half blocked on credential |
| Canonical workspace | `/Volumes/PortableSSD/Meta_Hackathon` |
| Storage requirement | All project-controlled files and runtime data on SSD; old home path is a symlink |
| Next task | Task 8 (beliefs, forecast); Task 9 needs `MODEL_API_KEY`; owner decision on harder development cases |
| Minimum hackathon path | Tasks 1–11, then 13–14; research qualification is separately gated |
| Source baseline | `d12459829cce71d65771c2a85236d46800bdfe1d`; work on branch `lifeline` |
| Qualified LIFELINE gates | None |
| LIFELINE packet runs | Task 1: 2 two-host; Task 4: 2 cascade (120 s), 1 partition, 4 short controls; all fixed policy |
| LIFELINE live Meta runs | 0 |
| LIFELINE comparative results | None |
| Platform | Lima `lifeline` VM (Ubuntu 24.04, Mininet 2.3.0, OVS 3.3.9); state on SSD-backed `.work/vm/lifeline-apfs.sparsebundle` mounted at `/Volumes/LifelineVM` |
| Provider dependency | **Blocked:** no `.env`/`MODEL_API_KEY`; smoke recorded `credential_missing` |
| Latest evidence | [Runtime run 0](lifeline-runtime-run-0.md), [contracts run 0](lifeline-contracts-run-0.md), [metrics run 0](lifeline-metrics-run-0.md), [packet run 0](lifeline-packet-run-0.md), [guard run 0](lifeline-guard-run-0.md), [execution run 0](lifeline-execution-run-0.md), [baseline run 0](lifeline-baseline-run-0.md) |
| Owner decisions | Emergency communications selected; ambitious long-term scope retained |

## Initial evidence record

| ID | Date | Observation | Implication |
| --- | --- | --- | --- |
| E001 | 2026-10-31 | Repository is Blackbox Apprentice at the baseline commit | Existing device results cannot be relabeled as network results |
| E002 | 2026-10-31 | Owner selected emergency communications | Network emulation is the first implementation target |
| E003 | 2026-10-31 | An earlier project's TDD and program documents inspected | Use ordered increments, negative controls, retained runs and explicit completion boundaries |
| E004 | 2026-10-31 | Schema overlaps with the earlier general learning proposal | Use prior work as a foundation/comparator; qualify a narrower new outcome |
| E005 | 2026-10-31 | Mininet documents Linux packet emulation | Linux runtime qualification precedes a real-network demo claim |
| E006 | 2026-10-31 | Published deadline remains Nov 4 at 9 PM Eastern | Plan an approximately four-day release and a separate research program |
| E007 | 2026-10-31 | Documentation checks passed for six documents, 17 local links, 19 task IDs, anchors, code fences, whitespace and unresolved markers; task dependencies reviewed and `git diff --check` passed | Planning artifacts are internally checked; no application or packet capability is thereby qualified |
| E008 | 2026-10-31 | Lima VM on SSD-backed APFS image carried 200/200 real UDP messages; link, rate and flow controls read back; teardown clean | Packet half of G0 qualified; no scenario or comparison claim |
| E009 | 2026-10-31 | No `MODEL_API_KEY` configured; smoke sent no request | Provider half of G0 blocked on owner-supplied credential |
| E010 | 2026-10-31 | Fixed-policy cascade on clean `21764ca`: primary on-time 0.630; incident 2 collapses clinic flows to 0.4% with 2.1× retries; partition delivers only shelter | Cascade is causal and measured; baseline comparison still needed |
| E011 | 2026-10-31 | Two versioned route updates and a throttle confirmed on live traffic with 0/4,800 messages lost; cascade regression 0.631 | Execution path qualified without congestion; no controller decisions yet |
| E012 | 2026-10-31 | On `dev-cascade-1`: fixed 0.631, priority 0.9985, adaptive 1.000; controls pass for both conventional controllers | G1 qualified; this cascade leaves no headroom for an AI gain |

The earlier repository review exercised the legacy device prototype. This planning pass inspected the source and reference plans; it does not rerun or extend those legacy performance claims.

## Gate register

| Gate | State | Evidence | Next decisive check |
| --- | --- | --- | --- |
| G0 Runtime and provider | Partial | [Runtime run 0](lifeline-runtime-run-0.md): packets qualified | Live provider response and ten-request distribution |
| G1 Measurement and baseline | Qualified | [Packet run 0](lifeline-packet-run-0.md), [baseline run 0](lifeline-baseline-run-0.md) | Repeat runs for variance before G4a |
| G2 Bounded control | Partial | Guard, executor and live versioned updates ([execution run 0](lifeline-execution-run-0.md)) | Forecast qualification with guard and executor (Task 8) |
| G3 AI prototype | Planned | No run | Real Meta decision with measured consequence |
| G4a Pilot comparison | Planned | No run | All 48 scheduled development episodes accounted for |
| G4b Held-out qualification | Planned | No run | Frozen split, matched controllers, uncertainty and ablations |
| G5 Hackathon release | Planned | No run | Rehearsal, evidence-consistent claims and complete assets |
| G6 Research qualification | Planned | No run | Appropriate prior-work comparison and supported mechanism |
| G7 Operator/domain extension | Planned | No run | Pilot-specific or second-domain acceptance evidence |

## Decision ledger

| ID | Date | Decision | Basis | Reopen when |
| --- | --- | --- | --- | --- |
| D01 | 2026-10-31 | Emergency communications first | Explicit owner selection | Owner redirects scope |
| D02 | 2026-10-31 | Real packet emulation before physical mesh | Demonstrable outcome with a tractable initial environment | Packet qualification succeeds and a physical pilot has a purpose |
| D03 | 2026-10-31 | Deterministic immediate control; AI supervisory investigation | Continuous network operation and uncertain model latency | Measured timing supports a different role |
| D04 | 2026-10-31 | Fixed offered-message denominator | Prevent delivery-score inflation from dropped demand | New version of the evaluation question |
| D05 | 2026-10-31 | Strong conventional baseline before improvement claims | Established traffic-engineering methods | Never removed for competitive convenience |
| D06 | 2026-10-31 | Structured beliefs in V1 | Bounded implementation and testable proposals | A documented failure requires a richer model |
| D07 | 2026-10-31 | Separate hackathon and research gates | Remaining calendar and evidence requirements | Actual progress warrants broader release scope |
| D08 | 2026-10-31 | Keep all project-controlled files and runtime data on PortableSSD | Owner storage requirement after moving the repository | Owner changes the storage requirement |
| D09 | 2026-10-31 | Lima `vz` VM with `LIMA_HOME` on an SSD-stored APFS sparsebundle | ExFAT cannot hold Lima's Unix sockets; image keeps VM state on the SSD | Image mount or VM performance fails |
| D10 | 2026-10-31 | All controllers receive the same inventory: topology, nominal link ratings, declared workload, reference routes | Operators know their equipment; only impaired capacity is hidden | Owner rejects nominal ratings as controller input |
| D11 | 2026-10-31 | `probe_path` may name the path it tests (optional field), for every controller | A discriminating probe must test a candidate before traffic moves | Contract review |

## Run-note format

Create one note per qualified increment or material failed investigation. Use a stable run ID and link the actual artifact bundle. This is a record format, not a claim that the listed artifacts already exist.

```text
Run ID:
Date and operator:
Task and claim under test:
Starting code commit and dirty-tree identity:
Protocol, scenario, policy, model and prompt identities:
Host and runtime versions:
Expected RED and exact command:
Observed RED and why it is the intended failure:
Implementation boundary:
Focused GREEN command and observed result:
Negative-control results:
Packet/provider evidence level:
Attempted runs, completed runs and interrupted runs:
Measured outcomes and uncertainty:
Artifacts and checksums:
What this supports:
What remains unqualified:
Decision and next task:
```

For a failed investigation, keep the observed failure, its cause when known, and the next discriminating check. Do not fill success fields with planned outcomes.

## Session-close checklist

- [ ] Update the current task and latest verified commit.
- [ ] Attach observed RED/GREEN and relevant packet/provider commands to a run note.
- [ ] Update task boxes only for supported behavior.
- [ ] Record failed attempts and changed assumptions.
- [ ] Reopen any claim invalidated by a new failure or protocol change.
- [ ] Name the next executable action and any real external dependency.
- [ ] Leave the repository and demonstration instructions consistent with the qualified scope.

This checklist is a reusable workflow. It is not an outstanding implementation task for the document-writing session.

## Change history

| Date | Change | Result |
| --- | --- | --- |
| 2026-10-31 | Created design, living TDD program, evaluation protocol and run register | Planning artifacts; zero LIFELINE implementation or performance claims |
| 2026-10-31 | Made SSD storage mandatory in the living plan, root agent instructions, design and README; reserved ignored `.work/` storage | Future provisioning must verify storage before creating project data |
| 2026-10-31 | Task 1 runtime run 0: preflight and provider-smoke contracts (22 tests), Lima VM, two-host packet qualification | Packet runtime qualified; provider unqualified (no credential) |
| 2026-10-31 | Task 2 contracts run 0: canonical identity and ProposalV1 admission (39 tests), policy `f7baa4fa…` pinned | Contract-level qualification |
| 2026-10-31 | Task 3 metrics run 0: receipt scorer (14 tests), hand fixture, 200-trial reference cross-check, real capture rescored | Contract-level qualification |
| 2026-10-31 | Task 4 packet run 0: worker, traffic, telemetry, run script; cascade, partition, restart and boundary controls | Fixed-policy packet experiment qualified |
| 2026-10-31 | Task 5 guard run 0: admission guard and budget ledger (21 tests, 5 mutations caught) | Contract-level qualification |
| 2026-10-31 | Task 6 execution run 0: versioned routes, rollback, rate control, executor reconciliation; live transition run | Bounded execution qualified |
| 2026-10-31 | Task 7 baseline run 0: priority and adaptive controllers, probes, resolved counters; 9 runs of record | G1 qualified |
