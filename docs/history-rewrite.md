# Commit ID map after the history rewrite

On November 4, 2026 the `lifeline` branch history was rewritten to remove personal details (local paths and private references) from older versions of documentation files. File contents of the final commit were unchanged except two sentences. Every commit therefore has a new ID. Run notes, the frozen research protocol (`frozenAtCommit`) and commit messages written before the rewrite cite the old IDs; this table maps them. Order and contents of all commits are otherwise identical.

| Old ID | New ID | Commit |
| --- | --- | --- |
| `d124598` | `d124598` | Build Blackbox Apprentice software prototype |
| `fbbb966` | `a6cb4ad` | Add LIFELINE design, living plan, evaluation protocol and run register |
| `2758747` | `0fe46af` | Add LIFELINE storage preflight, capability report and provider smoke |
| `45163a5` | `5180014` | Qualify LIFELINE packet runtime in an SSD-backed Lima VM |
| `3d8dca3` | `8eb9b23` | Add LIFELINE canonical identities and ProposalV1 admission contracts |
| `b7e2f4c` | `0b5021b` | Add LIFELINE receipt-based deadline scorer |
| `21764ca` | `980aa73` | Add LIFELINE packet worker, scenario traffic and single-run orchestrator |
| `28772e8` | `f5f56a5` | Record LIFELINE packet run 0: fixed-policy cascade and controls |
| `de0df54` | `2ebdce4` | Use run-of-record telemetry figures in packet run 0 note |
| `c9513a5` | `e734886` | Add LIFELINE admission guard and run budget ledger |
| `e2f0310` | `216e851` | Add LIFELINE versioned route/rate execution with reconciliation |
| `13a16a3` | `24fafa8` | Record LIFELINE execution run 0: versioned updates on live traffic |
| `f465d5f` | `241cf7f` | Add LIFELINE priority and adaptive conventional controllers |
| `7630226` | `b8b11ee` | Record LIFELINE baseline run 0 and qualify G1 |
| `d5b2c9c` | `1d1a399` | Qualify LIFELINE G0 with live Meta provider measurements |
| `3c9aadc` | `f9821ce` | Ignore macOS AppleDouble files created on the ExFAT SSD |
| `b7c4a27` | `eecf614` | Add LIFELINE evidence-linked beliefs and bounded forecast |
| `c07e340` | `7ea9719` | Record LIFELINE forecast run 0 and qualify G2 |
| `b14dc7b` | `b1cd646` | Add gray-failure faults, unexplained-degradation rule and pilot fixtures |
| `2f5be7a` | `281b79c` | Make the lossy switch the silent one in the p6 gray-failure fixture |
| `d8eb0ae` | `1c55159` | Silence both ends of the lossy link in the p6 gray-failure fixture |
| `90bc5b6` | `654e7d9` | Freeze LIFELINE pilot protocol revision 1 before any meta result |
| `b1af603` | `cbba703` | Add LIFELINE Meta investigator: provider client, strict parser, controller |
| `2191fe3` | `4bb1f82` | Add development-only gray-failure fixture for investigator development |
| `4e14177` | `7f8af31` | Tune LIFELINE investigator cadence and timeouts from the first live run |
| `12e0ce3` | `54e6528` | Bound investigator reasoning effort after truncated gray-failure decisions |
| `6e9cc32` | `c1fedb0` | Record LIFELINE meta run 0: live investigator traces |
| `ef062c9` | `b1d6670` | Add LIFELINE hash-chained ledger, lifecycle states, progress bounds, replay |
| `d52fd92` | `07a991a` | Clean up run-owned objects after an interrupted worker |
| `e04df4b` | `fbf863a` | Record LIFELINE recovery run 0 and qualify G3 |
| `69bf7c1` | `b1b86b1` | Add LIFELINE frozen-protocol pilot evaluation |
| `abccfb4` | `d7e3b97` | Record prior-work scan bounding the pilot's comparator claims |
| `82a4e8f` | `db96397` | Cite 007 only through the retrieved overview |
| `16061da` | `5a81fa7` | Add LIFELINE operator and judge interface |
| `75591fa` | `c9a191f` | Draft LIFELINE demo script pending pilot results |
| `478e590` | `92e64eb` | Update LIFELINE plan and register: pilot running, interface built |
| `74667be` | `0a5b71d` | Fix pilot tooling: contract-only replay check, tmpfs release, rerun tags |
| `3e10f72` | `1c12516` | Record LIFELINE pilot run 0: negative preliminary comparison |
| `9909e45` | `2049ba9` | Show finished live runs as recordings and report how a live run ended |
| `c156bfb` | `61c5e1a` | Record LIFELINE interface run 0 |
| `ca44647` | `133c772` | Replay scoring windows from the faults actually applied |
| `127ba02` | `769cbd8` | Package the LIFELINE hackathon release |
| `b4d7591` | `13faabd` | Rewrite LIFELINE as an infrastructure-wide program (P00-P31) |
| `7f7f501` | `13858e7` | P00: preserve V1 evidence and reproduce setup in a clean-room guest |
| `1613f70` | `efcfabe` | P01: run investigations in parallel with full conventional recovery |
| `1c2374e` | `967fd38` | P01: whole-millisecond call timeouts; stop re-proposing refused plans |
| `2208c10` | `f97b3a7` | Record LIFELINE P01 run 0 |
| `718f3a9` | `8c38fc2` | P02: freeze communications protocol revision 2 before any v2 run |
| `cb119c8` | `037a4de` | Preflight: admit batch bytes against the workspace and per-run peak against /run |
| `6c21e4f` | `00fbfc9` | P03: versioned infrastructure contracts, episode clock, communications adapter |
| `c220543` | `0d17c62` | P04: arbitration, authority and partial execution kernel |
| `f3757a5` | `7ef88a9` | P05: independent service accounting with a Python reference scorer |
| `9778037` | `fda90af` | Record LIFELINE P03 and P05 run notes |
| `f1cd87b` | `eec9902` | Qualify LIFELINE P06 electrical adapter on pandapower |
| `92e89c0` | `f9debf2` | Qualify LIFELINE P07 electrical control and Grid2Op profile |
| `b27b6a1` | `ada1e2b` | Record LIFELINE communications v2 result and freeze P04 scheduling budget |
| `82d836d` | `866401c` | Qualify LIFELINE P03 with a live adapter-driven communications run; Q1 met |
| `8847676` | `88b4ee7` | Correct P03 state line and register gate summary |
| `4eb0dd7` | `b8bd102` | Qualify LIFELINE P08 water adapter on EPANET 2.2 via WNTR |
| `2e24fdd` | `2f2194b` | Qualify LIFELINE P09 water control and constrained preservation |
| `aa09cde` | `7254414` | Qualify LIFELINE P10 forecasts with lead time and scored uncertainty; Q2 met |
| `39a9e25` | `29ebfc5` | Record P00–P10 progress in the LIFELINE master plan |
| `9359a23` | `1ececdc` | Qualify LIFELINE P11 coupled town state, clocks and conservation |
| `d8402c1` | `f14c622` | Qualify LIFELINE P12 joint plans and resource-aware intervention search |
| `d025dbd` | `e275e36` | Qualify LIFELINE P13 conventional joint comparator |
| `94487c6` | `dee8787` | Qualify LIFELINE P14 Meta-assisted joint decisions; comparator revision 2 |
| `b19633a` | `8dcbdfa` | Qualify LIFELINE P15 town interface and experiment controls |
| `0c0c569` | `9d24130` | Qualify LIFELINE P16 coupled demonstration and release gate; Q3 met |
| `cc9fe67` | `db44006` | Add LIFELINE P17 held-out protocol code: layouts, role signatures, leakage checks |
| `a5a66e2` | `fccccec` | Freeze LIFELINE research-v1 held-out suite (P17 qualified) |
| `55a3ccf` | `68c9b0c` | Add LIFELINE P18 evaluator and analysis before the held-out run |
| `a9c71e9` | `b79a152` | Freeze LIFELINE P19 ablation protocol and variants before the ablation run |
| `c1f1b5b` | `f7b2bb6` | Record LIFELINE P18 held-out comparison: negative for Meta-assisted claims |
| `e9740ba` | `0e51cf1` | Record host sleep during LIFELINE P18/P19 runs and add the overlap check |
| `2a96d43` | `adc8778` | Add LIFELINE v2: brain reads warning signs, verified act-now steps, armed reflexes |
| `9735e3a` | `7706f98` | Add LIFELINE operations view, cyber storyline and pitch script |
| `fa3e112` | `24a77e9` | Record LIFELINE v2 run 0 results (live Meta brain) and use them in the pitch |
| `cf9413c` | `6aa09ba` | Complete LIFELINE v2 recorded results; README and pitch for the submission |
| `7b7d775` | `14610c7` | Fix LIFELINE act-now in live sessions; table marks only real wins |
| `3af7198` | `ff1fab3` | Remove personal details from repository files |
