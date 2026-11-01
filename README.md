# Blackbox Apprentice

An observation-driven apprentice that learns an unfamiliar virtual device, completes outcome-based tasks, and revises its model when predictions fail.

## LIFELINE project plan

The next project direction is **LIFELINE**, an emergency communications prototype that investigates network failures and tests whether AI-assisted control preserves essential message delivery. The current runnable application remains the Blackbox Apprentice device prototype.

Start with the [living LIFELINE program and TDD plan](docs/superpowers/plans/2026-10-31-lifeline-program.md). It links the architecture, evaluation protocol, release gates, longer-term roadmap, and [current evidence register](docs/trials/lifeline-run-register.md). LIFELINE implementation and performance qualification have not started.

**Storage requirement:** Use `/Volumes/PortableSSD/Meta_Hackathon` as the canonical workspace. All project files, environments, caches, VM disks and outputs must remain on the SSD; see the [storage rule](docs/superpowers/plans/2026-10-31-lifeline-program.md#0-ssd-workspace-and-storage-rule). The old home-directory path is a symlink.

## Run locally

Requires Node.js 22.9 or newer. No dependencies, hardware, camera, or API key are needed for local mode.

```sh
npm start
```

Open **http://127.0.0.1:3210**. The server binds to loopback only.

1. Click **Start discovery**. Watch the surviving hypotheses shrink and inspect the experiment ledger.
2. Choose **Run the motor**, then **Run task**. Success is checked against a fresh device observation.
3. Click **Change hidden rules**. The learner's model is not reset or told about the change.
4. Click **Check & relearn**. A systematic prediction check finds a contradiction and exploration resumes.
5. Run another task and export the session JSON.

**New device** discards the current in-memory session. Export its evidence first if you want to keep it. One local session is shared across browser tabs. This is a local research prototype, not a hosted multi-user service.

## What actually works

- A randomized virtual device runs in a separate child process. Its selected mechanism is never exposed to the learner or browser.
- The learner begins with an explicit family of 36 possible deterministic mechanisms: six button assignments, three motor interlocks, and two amber/motor interactions.
- Active learning compares predicted outcomes and selects informative experiments. Navigation uses transitions on which every surviving hypothesis agrees.
- Contradictions invalidate the current model and trigger identification from fresh evidence.
- A task planner searches transitions supported by all surviving hypotheses and verifies observations after each action.
- Verification systematically covers reachable state/action predictions rather than merely repeating a fixed button sequence.
- Evidence includes predicted outcomes, observed outcomes, surviving hypotheses, model revisions, verified tasks, and operator rule-change boundaries.
- Optional Muse Spark integration selects experiments from the grounded candidate set. Credentials stay on the server.

This is **bounded model identification**, not unrestricted discovery of arbitrary devices. The agent knows the possible mechanism family and the meanings of the three observed booleans. It does not know the selected mechanism. Virtual observations are symbolic; visual grounding with SAM 3.1 is **not implemented**. No physical or model API success is implied by local results.

## Use Muse Spark

Copy `.env.example` to `.env`, add your Meta Model API key as `MODEL_API_KEY`, and restart the server. Select **Muse Spark · Meta API** in the lab. Default model: `muse-spark-1.3`.

The adapter uses Meta's documented `POST https://api.meta.ai/v1/responses`. Muse receives the current observation, surviving hypotheses, recent evidence, and candidate experiments. Its choice must pass validation before an action occurs. Failed API requests or invalid choices stop the operation; there is no silent local fallback. Local information gain and task verification remain explicit deterministic components. Successful live API calls still need to be validated with an available account.

Official API reference: https://dev.meta.ai/docs/overview

## Validation

```sh
npm test
npm run benchmark
npm run demo
```

The tests exhaust all 36 mechanisms, all four goals, and all **1,260 ordered rule changes** between distinct mechanisms, including model-only systematic change detection, relearning, and a post-recovery motor task. HTTP tests exercise the actual isolated simulator, API validation, task verification, evidence export, and mutation behavior.

The reproducible benchmark writes `artifacts/benchmark.json`. Active learning and random exploration share the same hypotheses and observation interface. Random exploration runs 20 seeds per mechanism with a 64-action identification budget. Report censored runs as such; a random run that reaches the budget did not necessarily identify its mechanism. Partial models may still support valid task plans.

`npm run demo` runs the complete discovery → verified task → hidden change → detected contradiction → relearning → verified task sequence against a genuinely randomized simulator process. It exports `artifacts/demo-evidence.json`, including actual predictions and outcomes. This command does not require a browser and uses the local planner only.

## Project map

| File | Responsibility |
| --- | --- |
| `src/device-worker.mjs` | Private randomized virtual mechanism |
| `src/device.mjs` | Observation/action transport; optional future hardware bridge |
| `src/domain.mjs` | Declared hypothesis family and observable state definitions |
| `src/learner.mjs` | Hypothesis elimination, experiment selection, planning, verification |
| `src/session.mjs` | Closed loop, task checks, recovery, evidence |
| `src/meta.mjs` | Optional real Muse Spark experiment selection |
| `server.mjs` | Local HTTP service and configuration |
| `public/` | Browser-based virtual device and discovery lab |
| `docs/competition.md` | Criteria, evidence plan, and honest submission boundaries |

## Next software milestones

1. Validate Muse Spark using a real API account and record latency, usage, decision quality, and failures.
2. Add a rendered-image observation path and SAM 3.1 grounding; compare it with the symbolic observer.
3. Broaden the mechanism family with longer sequences and partial observability, maintaining reproducible held-out evaluations.
4. Add persistent session replay and a concise recorded demonstration.

The current simulator is enough to develop and demonstrate the full symbolic learning/control/recovery loop without buying equipment. A software-only submission should describe the device as virtual throughout.
