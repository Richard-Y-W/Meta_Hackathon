# LIFELINE Interface Run 0

**Run IDs:** replay inspection of `meta-run-0/gray-dev-2` (`run-20261101063720-lfm3`); live runs `live-mvxlfjgp-0` (browser-driven, operator-stopped) and `live-mvxlkv2s-0` (API-driven, completed). **Date:** November 1, 2026. **Task:** 13, operator and judge interface.

**Result:** Qualified for the declared scope: a local single-operator research demo. Recorded replay and live operation work end to end. The browser cannot reach the worker or submit proposals.

| Item | Value |
| --- | --- |
| Code | `16061da` (interface), `9909e45` (finished-run listing and end-state banners) |
| Files | `src/lifeline/http.mjs`, `public/lifeline.{html,js,css}`, `test/lifeline/http.test.mjs`; `server.mjs` mounts `/lifeline` and `/api/lifeline/*` beside the unchanged legacy demo |
| Deployment | Server in the VM (`PORT=3311`), reached from the Mac at `http://localhost:3311/lifeline` through Lima port forwarding |
| Evidence | `artifacts/lifeline/interface-run-0/*.png`, `artifacts/lifeline/guest/live/` |

## Tests

```text
node --test test/lifeline/http.test.mjs → 9 pass (RED 8/8 on stub; finished-live-run case RED then GREEN)
npm test → 240 pass
```

Run listing as `recorded-replay`; run view with topology, events, observations and score; path traversal refused; export of a failed run with its incomplete status; one live run at a time with explicit start and stop; unknown scenarios and controllers refused; the Meta controller refused without a server credential (`provider_unavailable`); judge faults limited to admitted kinds, registered links and bounded quantities, bound to the live run ID, appended only to the orchestrator's control file; event resumption after a sequence number; a dead run shown as `disconnected`, never green; a finished live run listed as a recording with its terminal state; mutations require JSON and a same-origin request.

## Inspection with actual traces (Playwright, Chromium headless, installed on the SSD)

- Replay at 1440 px and 420 px: no horizontal overflow; scrubbing to 45 s dims the 7 later events; the map shows silent links as dashed "no counters"; the Meta decision shows its hypotheses with cited observation IDs, the selected one, the expected outcome and the guard result. A label collision where r0-r3 and r1-r4 cross was fixed. Two test-script errors were corrected: range input `fill`, and a `wait_for_function` that the page's CSP correctly blocked.
- Live, browser-driven (`live-mvxlfjgp-0`): start → `LIVE · META-ASSISTED` → judge cut r0-r3 (applied 38.1 s) → deterministic probes and reroute → model call (13.6 s) → model decision refused by the progress bound (`progress_limit`: it re-requested a path probed seconds earlier) → visible degraded mode, then restored → judge 40% loss on r1-r4 → deterministic reaction → operator stop. The terminal state is `stopped`; the partial capture is retained and not scored. The banner now says exactly that.
- Live, API-driven (`live-mvxlkv2s-0`, 180 s): judge cut r0-r3 at ~40 s and throttled r3-r4 to 3 Mbit/s at ~80 s. Terminal `completed`; receipt-scored primary 0.9545 (32,576/34,128), after the second judge fault 0.9367; controller-view audit clean over 366 observations; 194-record ledger; 139 lifecycle transitions, 0 violations. Four model calls (14.2–16.0 s) diagnosed the shared r1-r2 path after the cut and "r4→r3 reduced to ~3 Mbps" after the throttle; the third decision throttled background and rerouted, the fourth chose no change.

## Remaining limits

- Single local operator; no authentication beyond loopback and same-origin checks; not a hosted service.
- The live service strips use sender-reported resolved counters; the receipt score appears when the run ends.
- Side-by-side live controllers are not offered (CPU isolation not measured); the comparison panel shows the retained pilot.
