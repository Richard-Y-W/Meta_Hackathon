# LIFELINE Release Run 0

**Date:** November 1, 2026. **Task:** 14, rehearsal and packaging.

**Result:** The release package is prepared. The three required rehearsals passed from a restarted server on a clean tree. Submitted claims match the retained evidence ([release note](../releases/lifeline-hackathon-release.md)). G5 remains open until the team completes the portal and eligibility items the release note lists.

## Rehearsals (browser-driven through `/lifeline`, server in the VM, clean tree)

| Rehearsal | Live ID | Judge faults | Outcome | Receipt-scored on time |
| --- | --- | --- | --- | --- |
| (a) ordinary two-fault demo, video recorded | `live-mvxlqkzc-0` | cut r0-r3 at ~40 s; r3-r4 to 3 Mbit/s at ~85 s | `completed`; 7 model calls, 4 Meta decisions, 24 deterministic decisions | 91.4% (31,176/34,104) |
| (b) unexpected admitted faults | `live-mvxlv6t0-1` | 40% silent loss on r1-r2 at ~40 s; cut r5-r0 at ~90 s | `completed`; 2 model calls, 1 Meta decision | 100.0% (34,095/34,104; 9 lost) |
| (c) provider interruption (server started with an invalid key) | `live-mvxlzjpu-0` | as (a) | `completed`; 6 model calls, all `provider_unavailable` (HTTP 401); 6 visible mode transitions to deterministic control | 97.9% (33,377/34,080) |

All three replay-verify (ledger, scores from raw receipts, contract decisions, linkage). Neither the real nor the rehearsal key appears in any artifact. No page errors in any rehearsal.

As in the pilot, the run with the model failing (c) scored higher than the run with the model working (a). That is consistent with the finding that model latency delays recovery; it is a single pair of runs, not a measurement.

## Defect found during rehearsal

Replay rebuilt scoring windows from the scenario's scheduled faults, so it disagreed with live runs scored around judge-injected faults. It now reads the applied faults from the ledger (`ca44647`). All 48 pilot first attempts and all four live bundles verify.

## Final checks

```text
npm test                                   → 240 pass, 0 fail
python3 -m unittest (host)                 → pass (2 integration tests skipped with reason)
git diff --check                           → clean
replay --verify                            → 48/48 pilot first attempts, 4/4 live bundles, recovery-run-0
```

## Not done here

The README setup was exercised on the existing VM (restart, sync, server start); a from-scratch VM build was not repeated. A narrated video, portal requirements and eligibility confirmation are owner items.
