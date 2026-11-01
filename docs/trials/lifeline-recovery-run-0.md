# LIFELINE Recovery Run 0

**Run IDs:** `run-20261101064251-lfr0` (live Meta cascade with ledger), plus a worker-kill interruption run (`lfx1`). **Date:** November 1, 2026. **Task:** 10, continuous-time recovery loop.

**Result:** Qualified, and G3 qualified. A live Meta run kept traffic and faults running during model calls, met a second incident while investigations were outstanding, recorded every decision in a hash-chained ledger, and was verified by replay. A killed worker produced a recorded incomplete run and a tag-scoped cleanup.

| Item | Value |
| --- | --- |
| Code | `ef062c9` (ledgered meta run), `d52fd92` (interruption run) |
| Files | `src/lifeline/{ledger,session,run-score}.mjs`, `test/lifeline/{ledger,session}.test.mjs`, `scripts/lifeline-replay.mjs`, `runtime/mininet/cleanup.py`; progress bounds in `src/lifeline/controllers/meta.mjs` |

## Tests

```text
node --test test/lifeline/ledger.test.mjs    → 7 pass (RED 7/7 on stub)
node --test test/lifeline/session.test.mjs   → 4 pass (RED 4/4 on stub)
node --test test/lifeline/meta-controller.test.mjs → 10 pass (progress-bound case RED then GREEN)
npm test                                     → 219 pass
```

Ledger: ordered hash-chained records verified against the finalized manifest; altered record (`hash_mismatch` at that sequence); duplicate and out-of-order records (`sequence_error`); a crash-truncated final record is reported with the verified prefix; removed tail records (`manifest_mismatch`); no manifest (`manifest_missing`); no appends after finalization; event data cannot overwrite ledger fields. Session: the design's progression, return to observing from any active stage, distinct degraded and unavailable states that never count as success, and invalid transitions refused and recorded. Progress bounds: an equivalent probe within 20 s, or a third model reroute of a flow in one incident, is refused (`progress_limit`) and control returns to the deterministic layer.

## Live run with ledger and replay

`run-20261101064251-lfr0`: meta controller, `dev-cascade-1`, 120 s. All 24,000 essential messages were on time. The deterministic layer moved both clinic flows after the 20 s outage; the 65 s capacity reduction arrived while investigations were outstanding. The traffic clock never paused. Ledger: 36 records, last hash `790259be…68f0b`. Session: 20 transitions, 0 violations, final state `observing`. API key absent from the bundle.

`node scripts/lifeline-replay.mjs --run artifacts/lifeline/recovery-run-0 --verify` → all checks pass: ledger chain matches the manifest; scenario identity matches; every window's score was recomputed identically from the raw sender and receiver records; 3/3 contract decisions agree; every admitted proposal has exactly one execution. Replay against the older baseline bundle `cascade-adaptive` also matched scores and decisions, and reports `pre_ledger_bundle` for its unchained events.

## Interruption

The worker was killed with SIGKILL 25 s into a 60 s adaptive run. The run recorded `terminal: run_incomplete` with failure `worker_unavailable/exited`, and a finalized ledger of 98 records. The cleanup utility then removed the run's 6 bridges and 16 links, and nothing else; no run-owned processes remained afterwards. Replay exits nonzero for this bundle because there is no complete capture to score. The first attempt at this test was invalid: `pkill -f` matched its own parent shell. The run's leftover bridges motivated the cleanup utility and SIGTERM teardown in the worker.

Earlier, an SSD disconnect killed the VM mid-run (`meta-run-0/interrupted-cascade-lfm0`). The truncated events file is retained, and that run is not scored.

## What this supports

G3: a live Meta trace, a second failure during investigation, visible degraded-mode control ([meta run 0](lifeline-meta-run-0.md), gray failure `lfm2`), complete attempt accounting, and replay verification.

## What remains unqualified

- Supervisor process restart with resumed control (needs read-back through `control_state`; not implemented). A crashed supervisor ends the run as incomplete.
- The hash chain shows the ledger is unchanged since finalization; it does not independently prove the experiment was conducted honestly.

**Next:** Task 11, the frozen pilot comparison.
