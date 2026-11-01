# LIFELINE Meta Run 0

**Run IDs:** `run-20261101063008-lfm1` (cascade), `run-20261101063402-lfm2` and `run-20261101063720-lfm3` (development gray failure); an interrupted attempt `lfm0`. **Date:** November 1, 2026. **Task:** 9, meaningful Meta investigation.

**Result:** Qualified as a working AI-assisted controller with live decision traces. Real Muse Spark responses chose diagnoses, probes and an intervention that went through the shared guard and executor, and their outcomes were measured. The model has not yet improved outcomes. Its calls take 13–18 s on a ~2.7k-token investigation prompt, and its first diagnosis on the gray failure was wrong. The conventional layer recovered first.

## Configuration (frozen for the pilot as `lifeline-investigator-v1`)

| Item | Value | Basis |
| --- | --- | --- |
| Model | `muse-spark-1.3`, Responses API | Owner key, G0 |
| Reasoning effort | `medium` | Default effort used all 4,000 output tokens reasoning on 2/2 gray-failure calls; `low` took 2.6–4.3 s and `medium` 3.6–7.0 s on the smoke prompt, both 3/3 valid |
| Output cap | 6,000 tokens | Headroom over observed 3,933–4,480 tokens on investigation prompts |
| Per-call timeout / decision deadline | 18 s / 30 s, at most 2 calls per decision | Cascade run: 7.9–11.9 s per call; 2/7 calls exceeded 12 s |
| Run budget | 12 model calls, 12 intervention bundles, 256 KiB probe bytes per incident | `policy-v1.json` |
| Role | Deterministic adaptive layer keeps failover and capacity planning; the model investigates new incidents and persistent unexplained degradation; the conventional unexplained-degradation rule runs only in degraded mode | Design D03 |
| Admission | Strict JSON (duplicate keys refused), cited evidence must exist, belief updates must be supported by retained measurements, forecast status must be `ok`, then the shared guard | Tasks 2, 5, 8 |
| No-change decisions | Recorded as `controller_model_decision`; no proposal, no budget | Cascade run spent 5 bundles on retain decisions |

## Tests

```text
node --test test/lifeline/meta-provider.test.mjs     → 14 pass (RED 14/14 on stub; config tests RED then GREEN after each budget change)
node --test test/lifeline/meta-controller.test.mjs   → 9 pass (RED 8/8 on stub; cadence and stop tests RED then GREEN)
npm test                                             → 207 pass
```

Parser controls (`fixtures/lifeline/development/provider-controls.json`, mocked HTTP, parsing only): timeout, HTTP 429, transport error, missing credential (no request), oversized response, duplicate keys, malformed JSON, unknown top-level field, invented evidence, unsupported action, string units, missing field, unknown selected hypothesis, too many actions, unsupported belief update. Controller controls: the deterministic outage response does not wait for the model; one outstanding call; retry once, then visible degraded mode with the conventional rule active; timeout and unavailable provider; exhausted model budget; unsupported belief update rejects the decision; no-change decisions spend nothing; an unchanged outage is investigated once.

## Live runs

The API key was absent from every artifact (checked by searching the bundles for the key value).

**Interrupted attempt `lfm0`:** the SSD disconnected mid-run, detaching the APFS image that holds the VM, and the VM died (exit 137). The ExFAT repository was intact (clean tree, `git fsck` clean), and the guest ext4 journal recovered on restart. The run's six bridges were removed by prefix. The partial bundle is kept as `meta-run-0/interrupted-cascade-lfm0` and is not scored.

**Cascade `lfm1`** (120 s, code `b1af603`): 24,000/24,000 on time; the deterministic layer moved both clinic flows at 25.5 s. Seven model calls: five succeeded in 7.9–11.9 s, two timed out at 12 s. Every model decision was `retain_policy`, with correct statements. After the second incident the model cited backlog of about 247 KB and drops of about 375/s, and stated that r1>r2 had fallen to about 3 Mbit/s while the current routes avoided it. Findings: each retain decision spent an intervention bundle; the unchanged outage was re-investigated every 15 s; the event type field was overwritten by event data (all records present, wrong prefix). All three were fixed in `4e14177`.

**Gray failure `lfm2`** (90 s, `4e14177`, default effort): two calls (15.2 s, 13.9 s) both used exactly 4,000 output tokens with 3,998 reasoning, and were rejected as `invalid_json` (truncated). Degraded mode engaged visibly; the conventional rule probed and moved field-clinic at 54.5 s. On time: 0.970.

**Gray failure `lfm3`** (90 s, `12e0ce3`, medium effort): on time 0.983 (16,994/17,280; 123 late, 163 lost); field-clinic missed deadlines from 20 to 42 s.

| Time (s) | Source | What happened |
| --- | --- | --- |
| 18–20 | Admin | r2 and r3 stop reporting; r2-r3 drops 40% |
| 40.5 | Meta, `resp_6ae6de4b20fdbc8075b6437f`, 17.9 s, 4,480 tokens | Hypotheses: h1 congestion from bulk-field on r1-r2/r2-r3; h2 loss on r2-r3 where counters are missing. Selected h1 (wrong) and throttled bulk-field; forecast [0.95, 1] for field-clinic. Admitted and confirmed; did not restore field-clinic |
| 41.5–46.5 | Deterministic | The capacity planner moved field-clinic to r1-r0-r3 to restore background rate under the lowered load, after a clean probe of r1-r0-r3 (0/16 lost), then restored bulk-field. This is what recovered the flow |
| 54.5 | Meta, `resp_6ae6de58bde12a846b5747ae`, 13.2 s, 3,933 tokens | Selected h1: loss on r2-r3 whose counters are null. Requested two discriminating probes: r1-r2-r3 lost 12/20 (60%), r1-r0-r3 lost 0/20, confirming the hypothesis |

The second response diagnosed the silent lossy link correctly and its probes discriminated it. The first response chose the wrong explanation. Recovery came from the deterministic layer reacting to the model's throttle, not from the model's own reroute. For comparison, the adaptive baseline recovered the analogous pilot case in about 4 s (p6 fixture check, 0.994). A comparable figure under the meta controller is not established here, because these are development runs on a different link.

## What this supports

C2 at the prototype level: Meta participates in actual investigation and intervention through the guarded action boundary, with retained response IDs, usage, hypotheses, cited evidence, forecasts and measured outcomes.

## What remains unqualified

- Any improvement over the adaptive baseline (Task 11 measures it on the frozen pilot).
- Decision latency: 13–18 s per call means the model works on a slower supervisory timescale than the deterministic controller.
- One gray-failure trace; no repetition.

**Next:** Task 10 (session lifecycle, ledger and replay).
