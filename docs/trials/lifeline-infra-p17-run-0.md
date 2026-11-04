# LIFELINE P17 run 0: held-out research suite frozen

**Date:** November 3, 2026. **Task:** P17. **State:** qualified. The suite is frozen, immutable under test and free of the known leakage paths, and no held-out outcome existed when it was frozen.

| Item | Detail |
| --- | --- |
| Code | `src/lifeline/kernel/research-protocol.mjs` (grid connectivity, role signatures, overlap/duplicate detection, hidden-truth scan, commitments, selected-after-outcomes); `scripts/lifeline-infra-freeze.mjs`; layouts in `runtime/infra/coupling.py` (`apply_layout`) and the worker; the layout-aware asset register in `meta-joint.mjs` |
| Comparator changes at freeze | The independent rule moves to revision 3: it reacts to any de-energized monitored bus, not just buses 7 and 9, so it is not blind on the moved layouts. The priority rule takes restoration ETAs from `line_restore` events; a threat advisory's first event is the threat, not a restoration. Neither change was re-run on development cases. |
| Outputs | `fixtures/lifeline/infra/protocol-research-v1.json` (public); `fixtures/lifeline/infra/research-v1/private-cases.json` (evaluator-private); [dataset card](../research/lifeline-infrastructure-dataset-card.md) |
| Freeze | `frozenAtCommit cc9fe67`, `suiteSha256 0069cd54f78729d25fa935405b02bf8514aafdd81ef27d68c0e0d9b54c88a6df`, 16 groups, 10 families |
| Tests | `protocol.test.mjs` 7/7; `test_coupling.py` 16/16 (the new layout physics test included); `test_clock.py` 3/3 and `test_baselines.py` 3/3 (run before the layout test was added); `npm test` 400 pass, 1 skipped before freezing (the frozen-suite test, which now runs) |
| Evidence | `artifacts/lifeline/infra/p17/mutation-evidence.txt` |

## RED evidence

The integrity code was written before its tests, so RED is shown by mutation. Each control was broken in turn, and the matching test failed:

| Mutation | Caught by |
| --- | --- |
| Signature includes the case name | isomorphic-overlap and derivative-schedule tests |
| Signature includes absolute fault times | derivative-schedule test |
| Hidden-truth scan returns nothing | hidden-truth test |
| Outcome check skips the artifact walk | selected-after-outcomes test |
| Signature ignores the layout roles | **First survived:** the line-8-9 example still differed in remedy count. A line-13-14 case, which differs only in the backup and router roles, was added and catches it. |
| Threat advisory reduced to the bare kind | false-alarm role test |
| `apply_layout` is a no-op | layout physics test (`True is not false`) |

## Freeze refusals and fixes (before any outcome)

The first freeze attempt refused for leakage. Three things were found:

- **`rv1-01-B-stable` matched `b-no-fault`.** No-fault cases are identical in every layout. The held-out stable case became low storage with PU2 on maintenance.
- **`rv1-08-B-impossible-recovery` matched `b-unrecoverable`.** Both were the same source loss. The held-out case moved to low storage.
- **`rv1-13-C-false-alarm` duplicated `rv1-07-B-false-alarm`.** The signature described a threat only by its kind. It now carries the roles of the threatened trip: B's line-8-9 threat would cut the pump and an essential bus, while C's line-4-5 threat cuts the pump only. A regression test covers this.

A second attempt failed while hashing: the freeze field was `undefined`, and the canonical encoder rejects it. Nothing had been written. `suiteHash` now omits the field. That one-line fix was made after commit `cc9fe67` and is committed with the frozen files. It changes hashing only, not case content.

The freeze ran with `.env` loaded, so the recorded Meta model is the one the P18 runner will call (`muse-spark-1.3`). The credential appears in 0 of the frozen files.

## Precision

The development paired S differences (hybrid − independent, 5 cases) were 0, 0, 0.19, 4.54 and 0 pp: mean 0.95 pp, SD 2.0 pp. With 16 groups:

- the 95% half-width is about 1.0 pp;
- the 80%-power minimum detectable effect is about 1.4 pp.

The protocol records these numbers and the consequence: an effect between the 0.5 pp margin and 1.4 pp would likely be inconclusive. B1 has two anticipatory groups and is exploratory at most.

## Gate

The P17 gate is met. The suite is immutable (the commitments and suite hash are checked in the test), and every held-out case is structurally distinct from development and from the other held-out cases. Prompts carry no hidden truth, and the freeze preceded all outcomes. A renamed or time-shifted development case is rejected.

## Correction after P18 (November 3, 2026)

The gate statement above calls the suite "adequately discriminating". That was judged from structural distinctness only, and P18 shows it was too strong.
- **Layout C.** In all 8 layout-C groups, no controller and not the perfect-information oracle had any essential deficit. Those groups can reveal only non-essential differences.
- **Layout B.** The informative population for essential service was the 8 layout-B groups, 6 of which have headroom.
- **Precision.** The frozen precision statement assumed 16 informative groups, so the study's precision was lower than stated.
- **Future suites.** A suite should check headroom before freezing, with a controller-independent diagnostic such as no-action and oracle runs that report only whether essential loss is possible.

The original text is kept unchanged above.
