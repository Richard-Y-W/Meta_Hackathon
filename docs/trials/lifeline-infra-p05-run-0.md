# LIFELINE Infra P05 Run 0 — Service accounting and private evaluation

**Date:** November 1, 2026. **Task:** P05. **State:** qualified (accounting plumbing; no power or water operation is claimed).

| Item | Value |
| --- | --- |
| Code | `f3757a5` |
| Files | `src/lifeline/kernel/measurement.mjs`, `runtime/infra/scoring.py`, `test/lifeline/infra/measurement.test.mjs`, `runtime/infra/tests/test_scoring.py`, `fixtures/lifeline/infra/analytic-service-cases.json` |

## RED → GREEN

```text
measurement.test.mjs   RED 12/14 on stub (the import-isolation and explanation checks pass trivially) → GREEN 14/14
test_scoring.py        RED 9 errors on stub → GREEN (3 tests)
npm test               326 pass
```

## Hand-calculated cases (both scorers agree with every value)

| Case | Demand | Served | Unmet / missing | Score | Status |
| --- | --- | --- | --- | --- | --- |
| 10 s at 50% supply (power) | 10,000 J | 5,000 J | 5,000 J | 0.5 | scored |
| Tank exhaustion: 600 m3 at 0.1 m3/s over 10,000 s | 1,000 m3 | 600 m3 | 400 m3 | 0.6 | scored |
| Complete partition (water) | 0.1 m3 | 0 | 0.1 m3 | 0 | scored |
| Zero demand | 0 | 0 | 0 | null | scored |
| Pressure below 140 kPa after 4 s | 0.1 m3 | 0.04 m3 | 0.06 m3 | 0.4 | scored |
| Supply unobserved after 6 s | 10,000 J | 6,000–10,000 J (bounds) | 4,000 J missing | null | capture_incomplete |
| Load shed after 5 s | 10,000 J | 5,000 J | 5,000 J | 0.5 | scored |

The censored-recovery case shows that two 5 s excursions above 95% before the 55 s end are not a 10 s sustained recovery, so recovery is censored.

## Properties verified

- **Denominator fixed:** demand comes from the immutable schedule; shedding cannot shrink it.
- **Retries:** two copies of one message count once (V1 receipt scorer via `scoreCommunications`).
- **Missing capture is separate from loss:** missing supply gives `capture_incomplete` with service bounds; observed zero supply is `scored` with score 0.
- **Composites:** a facility's weighted and minimum scores are reported beside every component, and weights must sum to 1.
- **Scorer isolation:** controller notes and claimed service attached to supply records leave scores unchanged; the module imports no controller, model, forecast or belief code.
- **Malformed schedules and supply** are refused rather than scored.
