# LIFELINE town — three-minute demonstration script

Retained evidence: `artifacts/lifeline/infra/town-release-run-0/` (each bundle verifies with `node scripts/lifeline-infra-replay.mjs --run <bundle> --verify`). Live view: `http://localhost:3311/lifeline/town`.

**Label every screen.** Development town; accelerated modeled 60× (one simulated minute per wall second); modeled communications; synthetic facilities. Any replay speed-up changes presentation only.

| Time | Beat | Show | Say (and only this) |
| --- | --- | --- | --- |
| 0:00–0:20 | Normal town | Start `b-second-fault` with controller `hybrid`; measured strips at 100% | "A CIGRE benchmark feeder, a water network and a SCADA network, joined only by declared physical edges. These strips are independent measurements." |
| 0:20–0:50 | First threat | At 30 simulated min the storm trips line 3-8: essential electricity drops; PU1 shows "no supply" | "Nobody scripted the water problem. The pump has lost its supply, so the tank starts to drain." |
| 0:50–1:20 | Response | Timeline: generator dispatched; ties S1 and S3 refused (`actuator_unavailable`), S2 delivered | "Conventional control acts in about two minutes. Refused actions stay visible as refused." |
| 1:20–1:50 | Surprise | At 60 min line 2-3 trips (the second fault); the pending plan expires and the planner replans; later the residential valve closes | "An outside change expires the old plan. The planner replans from what it can see, and sheds the residential zone to protect the hospital, at a cost." |
| 1:50–2:20 | Interruption | Judge fault: `router_fail rt-pump` | "Telemetry from the pump station is now stale. That is not reported as a physical failure, and local control keeps running." |
| 2:20–3:00 | Comparison | Release table (below) | "Coordination removed essential water loss in two cases, at a non-essential cost. In this release the Meta model changed nothing, and in development it added latency, not value. That is the honest result." |

| Case | Independent: essential water / non-essential water / essential power | Joint comparator (`hybrid`) | Meta (complete, live) |
| --- | --- | --- | --- |
| second fault | 5.88 m3 / 11.8 m3 / 9,729 MJ | 0 / 33.1 / 9,729 | 0 / 25.9 / 9,729 (4 valid answers, no decision changed) |
| unrecoverable HV loss | 5.88 / 11.8 / 11,031 | 0 / 31.7 / 11,031 | — |
| control-channel interruption | 0 / 0 / 6,242 | 0 / 14.4 / 6,242 | provider interrupted: 0 / 14.4 / 6,242 |

**Do not say:** that the AI saves lives, that results transfer to a real utility, or that the town proves any breakthrough. The narrated video and portal submission are owner tasks.
