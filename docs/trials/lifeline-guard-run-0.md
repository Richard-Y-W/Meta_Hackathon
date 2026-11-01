# LIFELINE Guard Run 0

**Run ID:** `guard-run-0`. **Date:** October 31, 2026. **Task:** 5, authority, freshness and budgets.

**Result:** Qualified at the contract-test level. `admitProposal` is pure apart from charging the budget ledger. It has no worker handle, so a rejected proposal cannot reach the network. The executor tests in Task 6 must confirm that boundary end to end.

| Item | Value |
| --- | --- |
| Starting commit | `de0df54` |
| Files | `src/lifeline/guard.mjs`, `test/lifeline/guard.test.mjs` |
| Policy | `policy-v1.json`, identity `f7baa4fa…dd25` (unchanged) |

## RED and GREEN

A stub returning `unimplemented` failed 20 of 21 tests; the immutability test passed trivially. The implementation passed 21 of 21 on its first run. To check that those tests constrain behavior, five mutations were applied one at a time. Each was caught by the suite:

| Mutation | Failing tests |
| --- | --- |
| Skip rejection for routes over links observed down | 2 |
| Skip precondition rejection | 3 |
| Skip transition rejection | 1 |
| Stop charging admission attempts | 2 |
| Never detect a transition overload | 1 |

```text
node --test test/lifeline/guard.test.mjs   → 21 pass, 0 fail
npm test                                   → 123 pass, 0 fail
```

## Behavior

- Stable codes for wrong policy, stale configuration (both proposal and observation revision), expired proposal, stale admission sample, unknown flow, data or acknowledgement route over a link observed down, route loop, throttling an essential source, changed link state, recovered service and missing measurement.
- Every admission attempt is charged one intervention bundle, including rejections. After 12, further attempts, including resubmissions under new proposal IDs, are refused as `budget_exhausted` and still recorded. Timeouts and actual probe bytes are charged by the caller through the same ledger; refunds are refused. A new incident restores only the per-incident probe allowance.
- Transition check: each intermediate state and the final state of a bundle is evaluated with measured per-flow rates and capacity lower bounds. A directed link may not exceed its bound unless it was already at least as loaded. Moving `dispatch-clinic` onto the ring before throttling `bulk-field` is rejected; the reverse order is admitted.
- Rule capacity counts the old and new route versions together (make-before-break).
- When no capacity bounds are supplied, the decision records `transition: evaluated false`, not a pass.
- Confidence, explanation and override fields passed beside a proposal are ignored; inside a proposal they are unknown fields.

## Remaining limits

- `service_on_time_below` reads `recentOnTimeFraction`, which the worker does not emit. The supervisor must derive it from successive observations (Task 7).
- Capacity bounds and per-flow rates come from Task 8 beliefs; until then transition checks run only when a caller supplies them.
- The session (Task 10) must charge provider timeouts and actual probe bytes.

**Next:** Task 6, executing and reconciling real network effects.
