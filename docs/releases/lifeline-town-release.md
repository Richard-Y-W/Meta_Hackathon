# LIFELINE coupled-town release (P16, gate Q3)

**Date:** November 3, 2026. **Status:** a measured three-domain prototype with a reproducible demonstration. Q3 is met. B1–B5 are **not** claimed: the research comparisons (P17+) have not been run.

## What is in the release

| Part | Evidence |
| --- | --- |
| Power, water, coupling, planner, comparators, Meta layer, town view | P06–P15 run notes ([register](../trials/lifeline-run-register.md)) |
| Run bundles | `scripts/lifeline-infra-run.mjs`. Each bundle holds: a manifest (case and fixture hashes, clock mapping, code commit, ledger summary); hash-chained receipts of every command and decision; the trace; the case; and a score bound to the manifest hash |
| Replay | `scripts/lifeline-infra-replay.mjs`. It contacts no provider and changes no file. It verifies the receipt chain and order, the workload and fixtures, the clock mapping and the score's binding, then re-simulates the town from the recorded commands and recomputes the score. Tests (`test/lifeline/infra/replay.test.mjs`) show it detecting a changed workload, a reordered receipt, an altered clock mapping, a copied score and an edited score; mutation checks confirm the clock and provenance checks |
| Rehearsal | `artifacts/lifeline/infra/town-release-run-0/`: eight bundles, all verified by replay; no credential in any artifact |

## Rehearsal results (development cases, one run each)

| Case | What it rehearses | Independent | Joint comparator `hybrid` | Meta-assisted |
| --- | --- | --- | --- | --- |
| `b-second-fault` | a developing threat with useful lead time, then a second surprise failure | essential water 5.88 m3, non-essential 11.8 m3, essential power 9,729 MJ | 0 / 33.1 / 9,729 | live, complete mode: 0 / 25.9 / 9,729; 4 valid answers, **no decision changed** |
| `b-unrecoverable` | loss of the HV source, not restored in the run | 5.88 / 11.8 / 11,031 | 0 / 31.7 / 11,031 | — |
| `b-control-interruption` | substation router lost before the storm; provider interruption | 0 / 0 / 6,242 | 0 / 14.4 / 6,242 | provider interrupted: conventional control continued; 0 / 14.4 / 6,242 |

**Attribution.**

- **Coordination:** the joint comparator removes essential water loss in two cases (the generator, plus a demand shift or zone shed), at a non-essential cost of 20–22 m3. Under the control interruption its late-restoration caution sheds the residential zone unnecessarily (14.4 m3).
- **Meta:** neither the release run nor the development comparisons ([P14](../trials/lifeline-infra-p14-run-0.md)) show a benefit.
- **Unrecoverable electricity:** identical for every controller; no action can restore it.

## Reproducibility

- **Environment rebuild:** `.work/environments/town-rebuild` was rebuilt from `runtime/infra/requirements-town.lock` with uv-managed CPython 3.12 under `.work/python`. `uv pip freeze` matches the lockfile exactly, and `test_coupling`, `test_clock`, `test_power`, `test_water` and `test_scoring` pass in it.
- **Code identity:** the bundles record commit `b19633a` with 5 uncommitted P16 files (the run and replay scripts, their test, the episode-result change and two rehearsal cases). Those files were committed unchanged with this release.
- **Communications:** the full packet communications prototype still needs the Lima guest ([README](../../README.md)); the town needs only the host.

## Lineage

LIFELINE grew out of the earlier **Blackbox Apprentice** device-learning demo, which still runs separately, and the communications V1 prototype. Its archive and negative pilot are retained unchanged.

## Owner dependencies

The narrated video, hackathon portal and eligibility decisions, and any publishing remain with the project owner. Nothing has been published or pushed.

## Limits

- One run per condition on development cases, so no uncertainty interval.
- Accelerated modeled time makes each 15–25 s model call cost 15–25 simulated minutes.
- Latency is measured wall time, so results vary with host load.
- Communications in the town are modeled.
- There is no water-quality, transient or protection-coordination model.
