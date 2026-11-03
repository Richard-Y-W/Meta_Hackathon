# LIFELINE Infra P15 Run 0 — Town interface and experiment controls

**Date:** November 2–3, 2026. **Task:** P15. **State:** qualified. The existing `/lifeline` communications demo is unchanged and still served.

| Item | Value |
| --- | --- |
| Code | `src/lifeline/infra-http.mjs` (town endpoints and live session), `public/lifeline-town.{html,js,css}` (route `/lifeline/town`), `server.mjs` (route registration); town worker `inject` (judge faults with request and effect times) and `trace`; the rolling planner's decisions now carry their predicted worst-scenario outcome |
| Tests | `test/lifeline/infra/http.test.mjs` 5/5 (fake town; real handler and controllers); `npm test` all passing |
| Browser check | `scripts/lifeline-town-browser-check.py` (Playwright Chromium from `.work/cache/ms-playwright`) against the real server and a real town worker: 13/13 passing; `artifacts/lifeline/infra/p15-run-0/{browser-check.json,town-wide.png,town-narrow.png,town-disconnected.png}` |

## What the page shows

**Header.** The mode is always visible: accelerated modeled 60×, modeled communications, model off (the live view runs the conventional comparator; Meta runs are retained replays). It also shows the run ID and state (`idle`, `running`, `stopped`, `finished`, `disconnected`).

**Three linked views:**

1. **What is threatened.** Hospital water, essential electricity, the tank reserve and generator fuel, as measured strips with history. Each strip comes from the plants' service ledgers, not from controller statements. The final measured result appears when a run finishes.
2. **Assets and dependencies.** Ties, pumps (running, supplied, commanded), station mode, the residential valve and routers (up/down, battery), each with what it depends on. The table is read after each tick's commands, so it agrees with the timeline.
3. **Evidence, forecasts and actions.** Judge faults with requested and effective times; observed events (supply lost or restored, router failure, battery exhausted); planner decisions with when they were asked and when they were ready, plus the predicted worst-scenario outcome; every command with its receipt status (`delivered`, `rejected` with reason, `unconfirmed`, `expired`).

**Judge faults** (allowlisted): line trips, pump unavailability, router failure (link degradation) and frozen sensors (missing telemetry). They take effect at the next coupling step.

**Inspection panel.** Collapsed; holds the clock, layers and errors.

## RED → GREEN

The handler was written before its tests, so test power comes from mutations:

- accepting any run ID fails the stale-run test;
- labeling a dead worker `finished` fails the disconnect test.

Browser-check fixes:

- Inline `style` attributes are blocked by the server's CSP, so bar widths are now set through the CSSOM.
- The CSP also forbids Playwright's string predicates. The check polls from Python rather than bypassing the policy it is meant to exercise.
- The asset table lagged one tick behind a delivered tie; it is now read after commands, and a check asserts the agreement.

## Browser evidence (13/13)

- idle state; start by keyboard; a judge fault with request and effect times;
- measured strips rendered;
- tie actions with receipt status, and the asset table agreeing with the delivered tie;
- the narrow (390 px) layout fits the viewport;
- operator stop;
- a stale run ID refused (409 `stale_run`);
- export of the current run;
- a killed worker shown as `disconnected` ("Worker lost");
- no console errors.

The run also showed a real cross-domain effect. Failing the pump-station router hid the station's mains alarm, so the water rule never dispatched the generator.

## Limits

- The browser check exercised the `priority` controller. The `hybrid` option runs its planner asynchronously (its search time passes on the town clock) but was not driven in the browser check.
- The page shows the conventional comparator live; Meta decisions are only available from retained P14 records.
- Predicted effects are the planner's worst declared scenario, shown beside measured strips rather than overlaid on them.
