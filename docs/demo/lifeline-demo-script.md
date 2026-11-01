# LIFELINE Demo Script

**Status:** Draft, written before the pilot comparison finished. Every number spoken in the demo must come from a retained run or `artifacts/lifeline/pilot-v1/comparison.json`. Placeholders are marked `[from pilot]`.

**Length:** about 3 minutes live, with the recorded replay as fallback. **Screen:** `http://127.0.0.1:3210/lifeline`, served from the Linux VM (port forwarded by Lima).

## 1. The problem (20 s)

"After a disaster, a temporary network carries dispatch, clinic and shelter traffic. When links fail, congestion and retries cascade, and messages miss their deadlines. LIFELINE watches that network, investigates what is going wrong, and acts within strict limits to keep essential messages on time."

Point out the disclaimer line: the facilities are synthetic, the packets and receivers are real, and nothing connects to a real service.

## 2. Messages flowing (20 s)

Start a live run: scenario `operator`, controller **LIFELINE (Meta-assisted)**. Show the six-switch network, the three service strips at 100%, and the mode badge `LIVE · META-ASSISTED`.

"Every percentage here comes from the senders' own counters while live, and from receiver receipts once the run is scored. Nothing is inferred by the model."

## 3. First failure (40 s)

Judge fault: **Cut link r0-r3**. The timeline shows `JUDGE FAULT`, labeled as hidden from every controller.

"The deterministic layer reacts immediately: it probes the alternatives and moves the clinic flows. Meanwhile the Meta model investigates in parallel; it does not hold up failover."

Show the `DETERMINISTIC` probe and route entries, then the `MODEL CALL` entry with its latency and tokens.

## 4. Second failure: the hard one (60 s)

Judge fault: **40% silent loss** on the link the traffic now uses, after the run's counters for that switch are unavailable (use the recorded `p6` or `dev-gray` replay if the live network does not have silent counters).

"Now nothing looks congested. Connectivity checks pass. But deadlines fail. The model lists competing explanations, cites the observations behind each, and asks for discriminating probes."

Show a `META` entry: hypotheses with evidence IDs, the selected one (★), the expected outcome, and **Guard: admitted**. Then the receipts: e.g. "probe r1→r2→r3: 8/20 returned (60% loss); probe r1→r0→r3: 20/20" (from `meta-run-0/gray-dev-2`).

Be explicit about what the evidence shows: the model's first diagnosis in that trace was wrong, its second was right, and the deterministic layer recovered the flow first.

## 5. What we measured (30 s)

Switch to the **Pilot comparison** panel: 8 frozen cases × 3 controllers × 2 repetitions, receipt-scored. Read the actual row values `[from pilot]`. State the result plainly, whether gain, tie or loss: "On these cases LIFELINE was [from pilot] the adaptive baseline."

## 6. Trust and failure handling (20 s)

"Every model decision is parsed strictly, its evidence checked, its effect forecast, and it passes the same guard as any other controller. When the model times out or returns something invalid, control visibly drops to the deterministic layer (`MODE` entries). Every run is a hash-chained ledger; replay recomputes the score from raw receipts."

Click **Export evidence**.

## Rehearsal checklist (Task 14)

- [ ] Ordinary two-fault live run from a clean start.
- [ ] An unexpected admitted fault chosen by someone else.
- [ ] Provider interruption (remove the key or block the endpoint) showing degraded mode.
- [ ] Recorded replay of the same commit, labeled `RECORDED REPLAY`.
- [ ] Video recorded from the same qualified commit.
