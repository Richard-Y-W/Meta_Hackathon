# LIFELINE Infra P14 Runs 0–5 — Meta-assisted investigation and joint decisions

**Date:** November 2, 2026. **Task:** P14. **State:** qualified for the gate wording: live model output reached a real decision with a measured consequence. **No performance benefit is shown:** against the revised conventional comparator the model's participation made the result worse on the one case where it participated.

| Item | Value |
| --- | --- |
| Code | `src/lifeline/controllers/meta-joint.mjs` (evidence packet with a declared asset register and controller-visible command receipts; strict parser; investigation deadline; model layer beside the conventional rules), `src/lifeline/kernel/model-store.mjs`, `fixtures/lifeline/infra/meta-prompt-v1.txt`, `scripts/lifeline-meta-joint-run.mjs`. Town: `receipts`, `closedLinks`, first-essential-loss time and non-essential unmet water in previews. Planner: **service policy revision 2** (non-essential water ranked after essential power) and zone-shedding/restore templates, both added after run 4 exposed the gap |
| Provider | `muse-spark-1.3`, `low` reasoning effort (medium timed out at 18 s in run 0), 30 s cap; provider transport and P01 budgets reused |
| Live use | 41 calls over runs 0–5; 18 parsed; 2 timeouts (run 0); 83,250 input / 91,260 output tokens; median 18.8 s, max 24.4 s per call. Each call is charged on the town clock (×60): about 15–25 simulated minutes |
| Evidence | `artifacts/lifeline/infra/p14-run-{0..5}/meta-joint.json` (every call record; raw text kept for failed parses). A key scan of all P14 artifacts found no credential |
| Tests | `meta-joint.test.mjs` 9, `model-store.test.mjs` 3, planner regression added; `npm test` 381 pass |

## What reaches execution

The model gets only the admitted evidence packet, built from:

- fresh readings with their ages;
- router reachability;
- station mode and generator state;
- this system's own command receipts;
- the advisory ETAs;
- the declared asset register (which consumers are essential, which valve feeds which zone, the generator's rating and setup time, the ties).

Its answer joins the same candidate pool, the same simulations and the same ranking as the conventional templates; the conventional rule layer keeps acting meanwhile. The parser refuses:

- unknown evidence IDs;
- unsupported actions or assets;
- invented or non-canonical units;
- hidden-state fields;
- citation lists over 24 entries.

The investigation is bounded by the remaining opportunity: the earliest predicted essential loss, minus the longest actuation (600 s) and a margin (300 s), divided by the clock's 60×. When loss is already in progress, the call gets the provider cap as mitigation. The model is not called without an incident and a predicted loss.

RED: the parser was written before its tests, so test power comes from mutations. Removing the hidden-field scan, the evidence check, the unit checks or the action schema each fails its RED test.

## What happened

| Run | Change | Result |
| --- | --- | --- |
| 0 | medium effort, 18 s | 2/2 timeouts; a wasted pre-storm call; mitigation calls skipped because the deadline went negative once loss began |
| 1 | low effort, 30 s; gate needs a predicted loss; loss in progress → mitigation | 1/3 parsed; the model planned the disabled ties S1/S3 (it could not see refusals) and confused absolute and relative times |
| 2 | receipts and time conventions in the prompt | 2/14 parsed. 12 rejections were labeled `missing_field`; the real cause was citation lists over 8 IDs (a parser defect, fixed with a precise code and a 24 limit) |
| 3 | citation limit; null expectations allowed (the prompt itself says unknown is null) | 11/14 parsed. No participation: valid plans duplicated a conventional template or lost the ranking. The model modes were slightly worse than `hybrid` (5.68–5.71 vs 5.40 m3), the cost of their latency |
| 4 | declared asset register in the packet | **participation**: at 5,460 s the model's custom plan (start PU2, which was refused; stop the generator-fed PU1; close residential valve PZ) won the ranking. Essential water unmet fell from 5.40 to 0, at the cost of residential unmet rising from 10.8 to 81.4 m3. This happened under policy revision 1, which ignored non-essential service, and with no conventional template that sheds a zone |
| — | P13 run 9: comparator revision 2 (non-essential term; shed and restore templates) | the conventional `hybrid` alone also reaches 0 essential water on this case, with 21.6 m3 non-essential unmet and 9,650 MJ essential power |
| 5 | like for like with revision 2 (complete vs model off) | complete: 0 essential water, **61.9** m3 non-essential, **9,729** MJ essential power, 102 MJ fuel. Model off (`hybrid`): 0 / **21.6** / **9,650** / 120. **The model lost.** It did not change any decision in run 5; its effect was only the added planning latency |

A participation-check defect was found and fixed (regression test). The check recomputed the conventional winner with an older key that lacked the non-essential term, so in run 5 it marked a failed-parse call as participating. Participation now requires a parsed answer and uses the planner's own key.

**Interpretation.**

- The live decision in run 4 is the gate's required evidence: model output changed an admitted action with a measured consequence.
- Its apparent benefit came from a gap in the conventional comparator, the same kind of withheld capability P13 run 0 found for tie S2. Once that gap was closed, the conventional controller matched the model's essential-water result at lower cost.
- On this development evidence the model adds latency, not value.
- Accelerated time (×60) makes each 15–25 s call cost 15–25 simulated minutes. That is the dominant handicap, and it would shrink in a real-time deployment.

## Limits

- Development cases only, one run per condition, and a small number of model decisions.
- The narrator/investigator/complete comparison (run 3) is for debugging, not a result.
- Run 4 predates policy revision 2.
- Asset-register and prompt changes were made during development; they must be frozen before any held-out comparison (P17+).
