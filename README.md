# LIFELINE

**Emergency communications resilience with a Meta-assisted investigator.** LIFELINE runs a real packet network, watches essential messages (dispatch, clinic, shelter) as failures cascade, investigates what is going wrong, and acts within strict limits to keep messages on time. Every action passes the same guard and executor, whichever controller proposed it. Every result is scored from receiver receipts, never from a controller's own account.

Facilities are synthetic: real Linux packets in a Mininet/Open vSwitch emulator, with no connection to any real dispatch, clinic or radio service.

## What we measured

| Claim | Status | Evidence |
| --- | --- | --- |
| Real packet network with independent receipt scoring | Supported | [Packet run 0](docs/trials/lifeline-packet-run-0.md): fixed-policy cascade 63.1% on time; [metrics](docs/trials/lifeline-metrics-run-0.md) |
| Strong conventional baseline | Supported | [Baseline run 0](docs/trials/lifeline-baseline-run-0.md): adaptive 100% on the development cascade; no-fault, partition and stale-telemetry controls pass |
| Meta model takes part in real decisions with measured consequences | Supported (prototype) | [Meta run 0](docs/trials/lifeline-meta-run-0.md): typed hypotheses citing observations, discriminating probes (60% vs 0% loss on a silent lossy link), guarded interventions |
| Failure handling (invalid, stale, partial, provider failure) | Supported | [Guard](docs/trials/lifeline-guard-run-0.md), [execution](docs/trials/lifeline-execution-run-0.md), [recovery](docs/trials/lifeline-recovery-run-0.md) runs; provider interruption rehearsal |
| **AI improves essential delivery over the strong baseline** | **Not supported** | [Pilot run 0](docs/trials/lifeline-pilot-run-0.md): 48 paired episodes, meta − adaptive **−1.35 pp** (6 ties, p5 −7.24, p6 −0.88) |

**Why the AI did not win.** Live Muse Spark calls took 14–18 s, and 21% of pilot calls timed out. The deterministic layer handles failover in about a second. In this version the model replaced a fast conventional rule for unexplained degradation, so it recovered later. The model's diagnoses were often right ("r4→r3 reduced to ~3 Mbps"), but they came too late to beat the rule. The next protocol revision keeps the rule active and runs the model in parallel. That is a design hypothesis, not a result.

## Architecture

```
judge / benchmark faults ──► isolated Mininet network ◄── bounded executor ◄── guard + forecast ◄── typed proposals
                                   │                                                  ▲
                                   ▼                                                  │
                    telemetry (counters, age; no fault truth) ──► deterministic controller + Meta investigator
                                   │
                                   ▼
               sender/receiver records ──► independent receipt scorer ──► hash-chained ledger ──► replay verifier
```

- **Worker** (`runtime/mininet/`): privileged Python process in the Linux VM; allowlisted commands; only the orchestrator role may build scenarios or inject faults.
- **Supervisor** (`scripts/lifeline-run.mjs`, `src/lifeline/`): typed worker transport, telemetry admission and audit, evidence-linked capacity beliefs, forecasts, the admission guard, the executor (versioned routes, read-back, reconciliation, rollback), the run ledger.
- **Controllers** (`src/lifeline/controllers/`): `priority` (failover and shedding), `adaptive` (measured capacity, probes, exhaustive route × rate search, hysteresis), `meta` (adaptive layer plus the Muse Spark investigator).
- **Interface** (`/lifeline`): network map, receipt-scored service strips, investigation timeline labeled META or DETERMINISTIC, replay scrubber, judge fault controls, pilot comparison, evidence export.

## Run it

**Storage rule:** all project files, environments, caches, VM disks and outputs stay on `/Volumes/PortableSSD/Meta_Hackathon` ([rule](docs/superpowers/plans/2026-10-31-lifeline-program.md#0-ssd-workspace-and-storage-rule)).

Host (macOS) prerequisites: Node.js ≥ 22, Lima 2.x, the SSD mounted.

```sh
# 1. VM state lives in an APFS image on the SSD (ExFAT cannot hold the VM's sockets)
hdiutil attach -nobrowse .work/vm/lifeline-apfs.sparsebundle          # mounts /Volumes/LifelineVM
export LIMA_HOME=/Volumes/LifelineVM/lima
limactl start lifeline                                                  # first time: limactl start --name=lifeline runtime/vm/lifeline-lima.yaml
# first time only, inside the VM: sudo apt-get install -y mininet openvswitch-switch rsync; Node 24 from nodejs.org

# 2. Copy the source into the VM's native filesystem and start the server there
limactl shell lifeline -- bash -lc 'rsync -a --delete --exclude .work --exclude artifacts /mnt/lifeline-src/ /workspace/Meta_Hackathon/ && cd /workspace/Meta_Hackathon && PORT=3311 node --env-file-if-exists=.env server.mjs'
```

Open **http://localhost:3311/lifeline** on the Mac (Lima forwards the port). Put `MODEL_API_KEY=...` in `.env` for the Meta-assisted controller; the key stays in the server process and never reaches the browser or the evidence files.

Demo: choose scenario `operator`, controller **LIFELINE (Meta-assisted)**, **Start live run**, then use **Judge fault** (cut r0-r3, then throttle r3-r4). Recorded runs replay from **Recorded run**. See the [demo script](docs/demo/lifeline-demo-script.md).

## Verify

```sh
npm test                                                     # 240 Node tests (contracts, guard, executor, controllers, ledger, HTTP, ...)
python3 -m unittest discover -s runtime/mininet/tests -p "test_*.py"
# inside the VM, as root, for real OVS integration:
sudo LIFELINE_INTEGRATION=1 python3 -m unittest discover -s runtime/mininet/tests -p test_integration.py
node scripts/lifeline-replay.mjs --run <run bundle> --verify   # ledger, scores from raw receipts, contract decisions, linkage
node --env-file-if-exists=.env scripts/lifeline-evaluate.mjs --protocol fixtures/lifeline/protocol-v1.json --suite pilot --backend mininet --out artifacts/lifeline/pilot-v1
```

## Project documents

- [Living plan](docs/superpowers/plans/2026-10-31-lifeline-program.md) · [Design](docs/superpowers/specs/2026-10-31-lifeline-design.md) · [Evaluation protocol](docs/research/lifeline-evaluation-protocol.md) · [Run register](docs/trials/lifeline-run-register.md) · [Prior-work scan](docs/research/lifeline-prior-work-scan.md) · [Release note](docs/releases/lifeline-hackathon-release.md)

## Limits

Emulated packets on one topology, not radio links. One local operator; not a hosted service. Two repetitions per pilot case, so no uncertainty interval is claimed. Localizing silent loss by probing is established practice (007, NetBouncer), not a LIFELINE invention. No claim about lives saved, real emergency traffic or field deployment.

## Legacy prototype

The earlier **Blackbox Apprentice** device-learning demo still runs at `http://127.0.0.1:3210/` (`npm start`, no VM needed). Its notes are in [docs/competition.md](docs/competition.md). Its results are separate and are not LIFELINE results.
