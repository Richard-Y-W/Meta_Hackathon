# Competition alignment and evidence plan

**For the LIFELINE submission, see the [release note](releases/lifeline-hackathon-release.md).** This document describes the **legacy Blackbox Apprentice prototype**. The current LIFELINE direction, verified final-project rubric, and required evidence are in the [LIFELINE evaluation protocol](research/lifeline-evaluation-protocol.md#11-hackathon-rubric-to-evidence) and [living program](superpowers/plans/2026-10-31-lifeline-program.md). The October 30 assessment below is retained as historical context.

Checked October 30, 2026 against the public organizer pages:

- https://dev.meta.ai/events/global-hackathon
- https://events.cerebralvalley.ai/e/meta-ai-developer-hackathon

The detailed `/details` route was not readable through the research tool (it returned a loading shell). The public pages are the source for the priorities below. They are **not a verified full final judging rubric**. Do not invent numerical scoring weights, submission requirements, or eligibility conclusions from these descriptions. Check the accepted participant portal and final official rules before submitting.

## Published priorities

The public indie-track description emphasizes creativity, technical ambition, and a working result. The startup-track description emphasizes technical execution and production readiness. The Push the Frontier theme includes new machine capabilities and understanding or controlling physical systems. With the user's software-only constraint, this project demonstrates those ideas through a virtual device; physical operation must not be claimed.

The public application scoring is separate: project clarity/feasibility/theme fit and demonstrated technical skill receive equal application weight. Those weights are not established as final-project judging weights.

| Priority | Implementation | Evidence / remaining work |
| --- | --- | --- |
| Creativity | Agent discovers a hidden virtual control mechanism and adapts to changes | Show a continuous discovery → task → change → recovery demonstration |
| Technical ambition | Active experiments, causal mechanism candidates, verified planning, model revision | Export prediction/outcome ledger; document bounded-family assumptions |
| Working result | Runnable local application; exhaustive simulated mechanism and recovery checks | `npm test`; reproducible benchmark; browser visual QA remains pending |
| Meaningful Meta usage | Real Muse Spark decision adapter with observation-grounded candidates | Requires live API configuration and measured evaluation; no live success claimed |
| Frontier theme | Learning a control interface through intervention | Virtual proof of concept only; grounding and arbitrary device transfer remain future work |

## Demo narrative

“The apprentice has never been told this device's button assignments or motor interlocks. It begins with 36 possible mechanisms. Watch it choose experiments, eliminate explanations, and plan a verified task. Now we change the mechanism without updating its model. A failed prediction forces it to learn again.”

Show the observation, the competing predictions, the actual action, and the measured result together. Avoid claiming a scripted interpretation is a model thought process. The local planner's explanation is a description of its measured information-gain calculation. Muse explanations are displayed as model outputs only for real model requests.

## Evidence checklist for the eventual submission

- Record actual local and Meta mode separately.
- Disclose the known hypothesis family and symbolic observation interface.
- Evaluate hidden mechanisms and random baselines under the same action budget.
- Count navigation and failed-prediction actions as experiments.
- Report task successes from observations, including zero-action goals already satisfied.
- Distinguish pre-change learning, change-detection actions, and post-detection relearning.
- Export the whole session; do not omit failure cases from reported denominators.
- Keep captions, pitch, README, and recorded demonstration consistent about virtual-device scope.

## Current gaps

No live API credentials have been supplied. SAM 3.1, camera perception, arbitrary physical devices, persistent replay, noisy observations, and hidden internal states are not implemented. The simulator process boundary prevents accidental direct rule access by application code; it is not a security boundary against a developer who controls the repository. Hash commitments record rule continuity but are not independent proof that a demo was not scripted.
