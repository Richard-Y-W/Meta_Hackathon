# LIFELINE Metrics Run 0

**Run ID:** `metrics-run-0`. **Date:** October 31, 2026. **Task:** 3, independently correct service metric.

**Result:** Qualified at the contract-test level. The scorer also reproduced the Task 1 packet capture (200 offered, 200 on time).

| Item | Value |
| --- | --- |
| Starting commit | `3d8dca3` |
| Files | `src/lifeline/metrics.mjs`, `test/lifeline/metrics.test.mjs`, `fixtures/lifeline/development/scoring-hand-calculated.json` |
| Fixture sha256 | `343a73add0097296e6f4bf4f79dae56d4d5f32fd2df2307916458aaf8970f1a3` |
| Scorer output | `artifacts/lifeline/metrics-run-0/scorer-output.json`, sha256 `f6062be064e74b8633c0ea36b36d2472103fdb86c13d2f46694c92acb4529675` |

## RED and GREEN

Stubs produced 13 behavioral failures; the immutability test passed trivially on the stub. After implementation, three tests failed with `run_incomplete: receiver_capture_incomplete`. Those test inputs omitted the capture horizon while their deadlines ran past `toMs`; the scorer was right to refuse them. The tests were corrected to state a horizon.

```text
node --test test/lifeline/metrics.test.mjs   → 14 pass, 0 fail
npm test                                     → 81 pass, 0 fail
```

## Scoring rules as implemented

- Denominator: offered messages created in `[fromMs, toMs)`. Lost and late messages stay in it; zero offered gives `deliveryRate: null`.
- Outcome per message: the earliest receipt at or after creation. On time when it is no later than `createdAtMs + deadlineMs`; late otherwise; lost when none exists.
- Receipts before creation are `invalidReceipts`; additional valid copies are `duplicateReceipts`; IDs outside the manifest are `unknownReceipts`. None of these can add delivery.
- Duplicate offered IDs, malformed records and reversed windows raise `workload_invalid`.
- The receiver capture must extend through the largest included deadline (default horizon: `toMs`). Otherwise the scorer raises `run_incomplete/receiver_capture_incomplete` rather than counting loss. A sender manifest that is incomplete or has a different count also raises `run_incomplete`.
- Background throughput uses the independently scheduled offered bytes as its denominator, so throttling cannot raise the delivered fraction.

## Checks

- The plan's boundary case passes as written.
- Hand fixture (window `[1000, 2000)`): 5 offered, 2 on time, 2 late, 1 lost, 1 duplicate, 1 invalid, 1 unknown, rate 0.4; per-flow totals as hand-calculated in the fixture notes.
- 200 randomized trials (seed 20261031) agree with a separately written brute-force reference on offered, on-time, late, lost and rate.
- Task 1 packet capture `lf3000`, with a post-hoc 500 ms deadline: 200 offered, 200 on time, 0 duplicates, 0 unknown.

## Remaining limits

Retry amplification needs sender transmission records, which arrive with the Task 4 traffic generator. Recovery-time and per-interval scoring are not implemented yet.

**Next:** Task 4, real messages over the six-switch scenario.
