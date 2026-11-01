# LIFELINE

**LIFELINE detects emerging threats, predicts how failures could spread, and coordinates interventions that preserve essential services across power, water, communications, and other infrastructure.**

**Current implementation:** an emergency-communications prototype with a Meta-assisted investigator. It runs a real packet network, watches essential messages as failures develop, and executes guarded route/rate/probe decisions. Receiver receipts independently determine the result. Power, water, coupled planning and the broader breakthrough studies are specified in the [full living program](docs/superpowers/plans/2026-10-31-lifeline-program.md) and remain unimplemented.

Facilities are synthetic: real Linux packets in a Mininet/Open vSwitch emulator, with no connection to any real dispatch, clinic or radio service.

## What we measured

| Claim | Status | Evidence |
| --- | --- | --- |
| Real packet network with independent receipt scoring | Supported | [Packet run 0](docs/trials/lifeline-packet-run-0.md): fixed-policy cascade 63.1% on time; [metrics](docs/trials/lifeline-metrics-run-0.md) |
| Strong conventional baseline | Supported | [Baseline run 0](docs/trials/lifeline-baseline-run-0.md): adaptive 100% on the development cascade; no-fault, partition and stale-telemetry controls pass |
| Meta model takes part in real decisions with measured consequences | Supported (prototype) | [Meta run 0](docs/trials/lifeline-meta-run-0.md): typed hypotheses citing observations, discriminating probes (60% vs 0% loss on a silent lossy link), guarded interventions |
| Failure handling (invalid, stale, partial, provider failure) | Supported | [Guard](docs/trials/lifeline-guard-run-0.md), [execution](docs/trials/lifeline-execution-run-0.md), [recovery](docs/trials/lifeline-recovery-run-0.md) runs; provider interruption rehearsal |
| **AI improves essential delivery over the strong baseline** | **Not supported** | [Pilot run 0](docs/trials/lifeline-pilot-run-0.md): 48 runs (8 cases × 3 controllers × 2 repetitions), meta − adaptive **−1.35 pp** (6 ties at reported precision, p5 −7.24, p6 −0.88) |

**Why the AI did not win.** Live Muse Spark calls took 14–18 s, and 21% of pilot calls timed out. The deterministic layer handles failover in about a second. In this version the model replaced a fast conventional rule for unexplained degradation, so it recovered later. The model's diagnoses were often right ("r4→r3 reduced to ~3 Mbps"), but they came too late to beat the rule. The next protocol revision keeps the rule active and runs the model in parallel. That is a design hypothesis, not a result.

## Architecture of the communications prototype

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

Host (macOS, Apple silicon) prerequisites: Node.js ≥ 22, Lima 2.x, the SSD mounted. Verified on November 1, 2026 by building a second guest from scratch ([clean-room run](docs/trials/lifeline-infra-p00-run-0.md)): 180 s from `limactl start` to a provisioned guest, no manual corrections.

```sh
cd /Volumes/PortableSSD/Meta_Hackathon
python3 scripts/lifeline-preflight.py --storage-only --vm-backing .work/vm --out .work/tmp/preflight.json   # refuses an absent or off-SSD layout

# 1. VM state lives in an APFS image on the SSD (ExFAT cannot hold the VM's sockets)
hdiutil create -size 60g -type SPARSEBUNDLE -fs APFS -volname LifelineVM .work/vm/lifeline-apfs.sparsebundle   # first time only
hdiutil attach -nobrowse .work/vm/lifeline-apfs.sparsebundle          # mounts /Volumes/LifelineVM
export LIMA_HOME=/Volumes/LifelineVM/lima

# 2. Guest image (once): Ubuntu 24.04 arm64 cloud image into .work/downloads, checked against Ubuntu's SHA256SUMS
#    https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-arm64.img

# 3. Create and provision the guest. Packages are pinned in the definition: mininet 2.3.0-1.1,
#    openvswitch 3.3.9-0ubuntu0.24.04.1, iperf3, rsync, Node v24.14.1 (nodejs.org, checksum verified)
limactl start --tty=false --name=lifeline-clean runtime/vm/lifeline-cleanroom.yaml   # later: limactl start lifeline-clean

# 4. Copy the source into the guest's native filesystem; test; start the server there
limactl shell lifeline-clean -- bash -lc 'rsync -a --delete --exclude .work --exclude artifacts /mnt/lifeline-src/ /workspace/Meta_Hackathon/ && cd /workspace/Meta_Hackathon && node --test test/lifeline/*.test.mjs && PORT=3311 node --env-file-if-exists=.env server.mjs'
```

The original demo guest `lifeline` (`runtime/vm/lifeline-lima.yaml`, provisioned by hand on October 31) also works, with the same commands and guest name `lifeline`.

**Credentials are user-supplied inputs.** Create `.env` from `.env.example` and set `MODEL_API_KEY` yourself; it is git-ignored and is copied into the guest with the source. The key stays in the server process, and no artifact records it. Without it, the conventional controllers and replay work, and the Meta-assisted controller is refused as `provider_unavailable`.

Open **http://localhost:3311/lifeline** on the Mac (Lima forwards the port).

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

- [Full living program](docs/superpowers/plans/2026-10-31-lifeline-program.md) · [Infrastructure design](docs/superpowers/specs/2026-11-01-lifeline-infrastructure-design.md) · [Breakthroughs and evaluation](docs/research/lifeline-infrastructure-evaluation.md) · [Run register](docs/trials/lifeline-run-register.md)
- Implementation plans: [foundation](docs/superpowers/plans/2026-11-01-lifeline-foundation.md), [power and water](docs/superpowers/plans/2026-11-01-lifeline-power-water.md), [coordination](docs/superpowers/plans/2026-11-01-lifeline-coordination.md), [research and deployment](docs/superpowers/plans/2026-11-01-lifeline-research-deployment.md).
- Communications V1: [archived program](docs/superpowers/plans/2026-10-31-lifeline-communications-v1-archive.md) · [design](docs/superpowers/specs/2026-10-31-lifeline-design.md) · [protocol](docs/research/lifeline-evaluation-protocol.md) · [prior work](docs/research/lifeline-prior-work-scan.md) · [release](docs/releases/lifeline-hackathon-release.md).

## Limits

Emulated packets on one topology, not radio links. One local operator; not a hosted service. Two repetitions per pilot case, so no uncertainty interval is claimed. Localizing silent loss by probing is established practice (007, NetBouncer), not a LIFELINE invention. No claim about lives saved, real emergency traffic or field deployment.

## Legacy prototype

The earlier **Blackbox Apprentice** device-learning demo still runs at `http://127.0.0.1:3210/` (`npm start`, no VM needed). Its notes are in [docs/competition.md](docs/competition.md). Its results are separate and are not LIFELINE results.
