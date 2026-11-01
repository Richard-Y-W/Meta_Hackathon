# LIFELINE Hackathon Release

**Date:** November 1, 2026. **Branch:** `lifeline` (local; nothing pushed). **Code identity at packaging:** `ca44647` plus documentation commits. **Protocol:** pilot revision 1 (`fixtures/lifeline/protocol-v1.json`).

## What is being submitted

A working emergency-communications resilience prototype. It runs real packets in an emulated network, keeps a strong conventional controller in charge of immediate failover, and adds a Meta Muse Spark investigator that proposes typed probes and interventions through a guarded action boundary. Every outcome is scored from receiver receipts and verifiable by replay.

## Claim table

| ID | Claim | Status | Evidence |
| --- | --- | --- | --- |
| C1 | Controls a packet network and measures service outcomes | **Supported** | [packet run 0](../trials/lifeline-packet-run-0.md), [execution run 0](../trials/lifeline-execution-run-0.md) |
| C2 | Meta participates in actual investigation or intervention | **Supported (prototype)** | [meta run 0](../trials/lifeline-meta-run-0.md), [pilot run 0](../trials/lifeline-pilot-run-0.md) (39 live calls, 18 rejected proposals), [interface run 0](../trials/lifeline-interface-run-0.md) |
| C3 | Handles the declared compound failures | **Supported** for the 8 development cases, including partitions and stale telemetry | [baseline run 0](../trials/lifeline-baseline-run-0.md), [recovery run 0](../trials/lifeline-recovery-run-0.md), pilot |
| C4 | AI improves essential delivery over the strong baseline | **Not supported** (preliminary pilot: −1.35 pp; 6 ties, 2 losses) | [pilot run 0](../trials/lifeline-pilot-run-0.md) |
| C5–C8 | Mechanism, generalization, research novelty, operator benefit | **Untested** | Tasks 12, 15–19 |

## Rubric mapping (organizer weights from the evaluation protocol §11)

| Criterion | Weight | What to show |
| --- | --- | --- |
| Impact | 30% | The operator's problem (deadline loss under cascading failure), receipt-scored delivery, and an honest result: the strong conventional controller already preserves service, and the model adds diagnosis, not yet better outcomes |
| Use of Meta AI tooling | 25% | Live Muse Spark decisions with hypotheses citing evidence, discriminating probes with measured results, a guarded intervention path, visible degraded mode on provider failure, and a model-removal comparison (the pilot) |
| Demo | 25% | Live two-fault run with judge controls; recorded replay and video from the same commit |
| Technical depth | 20% | Real packets, versioned route updates with read-back and rollback, a hash-chained ledger with replay, 240 Node tests plus Python and root-only integration tests, and a frozen protocol with disclosed tooling corrections |

## Release evidence

| Item | Location |
| --- | --- |
| Rehearsal (a): two-fault live demo, browser-driven, video | `artifacts/lifeline/release-run-0/video-a-two-fault/lifeline-live-two-fault-rehearsal.webm` (about 3 min, no narration); bundle `artifacts/lifeline/guest/live/live-mvxlqkzc-0` |
| Rehearsal (b): unexpected judge faults | `live/live-mvxlv6t0-1` |
| Rehearsal (c): provider interruption | `live/live-mvxlzjpu-0` |
| Pilot comparison | `artifacts/lifeline/guest/pilot-v1/comparison.{json,md}` |
| Run notes | `docs/trials/` |

## Open items owned by the team (not verifiable from this workspace)

- [ ] Read the accepted participant portal: required video length and format, required URLs (repository visibility), team information and existing-work disclosure. These details are not in the public pages.
- [ ] Confirm eligibility and the accepted event terms with the team representative. A working demo is not an eligibility confirmation.
- [ ] Decide whether to publish the repository. The branch is local; publishing is the owner's decision.
- [ ] Record a narrated pitch video (the rehearsal video is a silent screen capture).
- [ ] Disclose existing work: the repository began as the Blackbox Apprentice prototype (commit `d124598`); LIFELINE was built from October 31, 2026.
