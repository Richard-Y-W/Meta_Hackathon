# LIFELINE research-v1 held-out suite: dataset card

**Protocol:** [`fixtures/lifeline/infra/protocol-research-v1.json`](../../fixtures/lifeline/infra/protocol-research-v1.json) (public). **Private manifest:** `fixtures/lifeline/infra/research-v1/private-cases.json`, read by the evaluator only. **Generator:** `scripts/lifeline-infra-freeze.mjs`. **Frozen:** November 3, 2026, at commit `cc9fe67`, suite hash `0069cd54…a6df`, before any held-out outcome existed.

## What it is

There are 16 scenario groups on the coupled development town: the CIGRE MV feeder (pandapower) coupled to the EPANET town water network (WNTR). Each group is a 4 h episode on the 60× modeled clock. Every controller sees the same offered demands, faults, authority and clock rules. The suite exists to test claims B1, B2 and B5 within this one town; it says nothing about other networks.

## Split

| Split | Layout | Pump station (PU1) bus | Backup pump (PU2) bus | Substation router bus |
| --- | --- | --- | --- | --- |
| Development | A | 7 | 14 | 14 |
| Held-out | B | 10 | 13 | 13 |
| Held-out | C | 5 | 14 | 12 |

Every development case is excluded: those in `baseline-policy.json` and `plan-controls.json`, all on layout A. The held-out layouts move dependency edges and the pump load in the physics. A test confirms that a line-8-9 trip cuts PU1 under layout B but not layout A. The fault locations used in held-out cases (lines 8-9, 4-5, 3-4 and 12-13) are not development fault locations, and their tie remedies differ: on layout B only S3 restores the pump bus after a line-8-9 trip, and on layout C only S2 does after a line-4-5 trip.

## Families

| Family | Groups | Purpose |
| --- | --- | --- |
| stable | 1 (B) | No-fault control (low storage, PU2 on maintenance) |
| developing-threat | 2 (B, C) | Threat advisory issued 45 min before the trip; the B1 population |
| abrupt | 2 (B, C) | Trip with no warning; restoration ETA advisory 1 min later |
| compound | 2 (B, C) | Second line trip, or the remedy tie failing after the trip |
| delayed-dependency | 2 (B, C) | Only tie remedy unavailable, low storage |
| partial-observation | 2 (B, C) | Tank level (and on B the pump-bus voltage) frozen before the trip |
| false-alarm | 2 (B, C) | Threat advisory that never materializes |
| impossible-recovery | 1 (B) | Upstream source loss: nothing can restore service |
| no-useful-coupling | 1 (C) | Trip that does not touch the pump station: zero coordination benefit |
| common-cause | 1 (C) | Trip plus loss of the substation router at the same instant |

Every non-stable group keeps PU2 out for maintenance from t = 0, so the pump station's supply is the binding dependency. The headroom reference is the latency-free oracle (perfect information), which is not a comparator.

## Generation

Trip times, restoration delays and initial tank levels come from a seeded generator (seed 20261103) on the 60 s grid:

- **Abrupt-type trips:** at 25–40 min, with restoration 120–180 min later.
- **Threats:** materialize at 55–70 min.
- **Tank levels:** 2.4–3.4 m normally, 1.3–1.8 m for low storage.

Advisories carry two scenarios: nominal, and repair 30 min late.

## Leakage controls (tested in `test/lifeline/infra/protocol.test.mjs`)

- **Role signature.** Each case is reduced to what it does to the dependency structure under its layout:
  - per fault: whether it cuts the pump station, the backup pump or the substation router, how many essential buses it cuts, and how many ties would remedy the pump bus;
  - the storage bucket;
  - for a threat advisory, the same roles for the threatened trip;
  - whether the threat materializes.

  Names, absolute times and seeds do not enter. A renamed or time-shifted copy of a case therefore has the same signature. The freeze refuses on any held-out signature that equals a development signature, and on duplicate signatures within the held-out set.
- **Hidden truth.** Controller prompts are scanned for evaluator fault IDs, and for any future event time paired with its asset that has not been announced by an issued advisory. The scan covers every held-out case at 0, 30 and 90 min.
- **Selected after outcomes.** The freeze refuses if any artifact file written before the freeze mentions a held-out case ID.
- **Commitment.** Each case's canonical SHA-256 is in the public protocol, and the protocol hash is recorded at freeze. The public protocol contains no fault schedule.

## Limitations

- **One network.** All layouts use the same CIGRE feeder and water network. Layout transfer here is a re-wiring of dependencies, not a different town; P21 covers other towns and domains.
- **Small and unbalanced.** There are 16 groups with one run per controller. The development paired SD is 2.0 pp, which gives a 95% half-width of about 1.0 pp and an 80%-power minimum detectable effect of about 1.4 pp. A true effect between the 0.5 pp margin and 1.4 pp would likely be inconclusive. Families are uneven (1–2 groups each), and B1 has only two anticipatory groups, so it can be exploratory at most.
- **Coarse signature.** Two cases with the same signature can still differ in timing and storage. The signature errs toward calling cases duplicates, not toward admitting near-copies.
- **Comparator change at freeze.** The independent rule became layout-independent (revision 3: it reacts to any de-energized monitored bus) so that it is not unfairly blind on the moved layouts. This was not re-run on development cases.
