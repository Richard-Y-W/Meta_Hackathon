# LIFELINE Runtime Run 0

**Run ID:** `runtime-run-0`. **Date:** October 31, 2026. **Task:** 1, qualify storage, Linux packet runtime and Meta provider.

**Result:** Storage and the packet runtime are qualified. The Meta provider is not: no credential is configured, so the smoke recorded `provider_unavailable/credential_missing` without sending a request. **G0 remains unqualified.**

## Code and environment identity

| Item | Value |
| --- | --- |
| Starting commit | `fbbb966` (planning baseline on branch `lifeline`, from `d124598`) |
| Contract tests commit | `2758747` |
| Host | Apple M4, 10 CPUs, 16 GiB, macOS Darwin 25.6.0, Node v24.14.1, Python 3.9.6 |
| Host load at preflight | 2.75 / 2.72 / 2.65 (1/5/15 min) |
| VM | Lima 2.1.2, `vz`, 4 vCPU, 6 GiB (5,910 MiB visible), 24 GiB disk |
| Guest | Ubuntu 24.04 arm64 cloud image, sha256 `50e24e1f…348e` (matches Ubuntu SHA256SUMS), kernel 6.8.0-147-generic |
| Guest software | Python 3.12.3, Node v24.14.1 (nodejs.org tarball, checksum verified), Mininet 2.3.0, Open vSwitch 3.3.9, iperf3 (Ubuntu archive) |
| Guest load at packet run | 0.23 / 0.17 / 0.07 |

## Storage mapping

| Material | Physical location |
| --- | --- |
| Repository | `/Volumes/PortableSSD/Meta_Hackathon` (ExFAT, 252.7 GB free at preflight) |
| VM state (`LIMA_HOME`) | `/Volumes/LifelineVM/lima`, an APFS volume whose only backing store is `.work/vm/lifeline-apfs.sparsebundle` on the SSD (2.6 GB used) |
| Guest disk | `/Volumes/LifelineVM/lima/lifeline/disk` |
| Guest workspace | `/workspace/Meta_Hackathon` on the guest's native ext4 root, a copy synced from the read-only `/mnt/lifeline-src` virtiofs mount |
| Guest evidence | `/mnt/lifeline-artifacts` → `artifacts/lifeline/guest/` on the SSD (the only writable host mount) |
| Downloads | `.work/downloads/` (cloud image and SHA256SUMS) |
| VM definition | `runtime/vm/lifeline-lima.yaml` (no home-directory mount, containerd disabled) |

`hdiutil attach -mountpoint` onto the ExFAT repository directory was refused (`Permission denied`), so the image mounts at its default `/Volumes/LifelineVM`. That mount point is a disk image volume, not a substitute for the SSD. After boot, `~/.lima` and `~/Library/Caches/lima` did not exist. The preflight's `--vm-backing` check resolves paths on the SSD; it does not yet resolve an attached image's mount point to its backing file, so the mapping above was verified with `hdiutil info`.

Reattach after a reboot with `hdiutil attach -nobrowse .work/vm/lifeline-apfs.sparsebundle`, then `LIMA_HOME=/Volumes/LifelineVM/lima limactl start lifeline`.

## Tests

RED was first a missing-script error, which is not the intended failure. A stub that printed an empty report produced the intended behavioral RED: 13 assertion failures on missing storage codes and capability fields. The provider tests failed on missing exports. The import of `admitOutputPath` from the wrong module was a test error and was corrected.

```text
node --test test/lifeline/preflight.test.mjs   → 22 pass, 0 fail
npm test                                       → 28 pass, 0 fail (legacy 6 unchanged)
```

Negative controls covered: absent mount, a plain directory standing in for the mount, an internal-drive repository, an output symlink escaping to `/Users/Shared`, off-SSD VM backing, each missing capability code, a fixture marked as non-evidence, credential non-disclosure, missing credential (no request sent), timeout, HTTP 401 with the key scrubbed from the body, malformed and incomplete model output.

## Live results

| Command | Outcome |
| --- | --- |
| `python3 scripts/lifeline-preflight.py --vm-backing .work/vm --out artifacts/lifeline/preflight-host.json` | Storage `ok`; macOS host missing every packet capability, as expected |
| Guest: `python3 scripts/lifeline-preflight.py --role guest …` | Storage `ok`; `packetReady: true`; missing only `credential_missing` |
| Guest: `sudo python3 runtime/mininet/packet_smoke.py --out …` (two runs) | Both: 200 offered, 200 unique receipts, 0 unknown IDs; teardown left no run-owned bridges or links |
| `node --env-file-if-exists=.env scripts/lifeline-provider-smoke.mjs --out artifacts/lifeline/provider-smoke.json` | 1 attempt, `provider_unavailable/credential_missing`, no request sent |

Packet run 2 (`lf3000`, retained as `packet-smoke.json`): 1,024-byte UDP messages every 10 ms across two 10 Mbit/s, 5 ms links. One-way delay was 10.27 / 11.52 / 12.20 ms (min/median/max) on `CLOCK_MONOTONIC` in the same kernel. Ping RTT in run 1 averaged 28.7 ms over 5 packets. Supported controls, each read back: link down (unreachable) and up (reachable), HTB rate change to 2 Mbit/s (`tc class show`), and OpenFlow rule install and removal by cookie. Mininet ran without a controller in OVS `standalone` mode. `mn -c` was never used.

The ten-request latency sample was not attempted.

## Artifacts (sha256)

```text
a382d2768f2a1782fbdecf0fb83cdb8614d0f070c0769c759e257a05afdccc69  artifacts/lifeline/guest/packet-smoke/lf2843/offered.jsonl
4dc6ddedf83db0d1d30404bf8ea410dca5ebb5f9cd1e262c39da8950ab298e29  artifacts/lifeline/guest/packet-smoke/lf2843/receipts.jsonl
077fa1fac9b71e347fd500b4658c43d9d088ed2c32c4821458ff97e199c58861  artifacts/lifeline/guest/packet-smoke/lf3000/offered.jsonl
d803126d822cd43c6fde3cdb6df777596bc93b5b58b5e2b62f71e65905e6771d  artifacts/lifeline/guest/packet-smoke/lf3000/receipts.jsonl
cba1207d50bb0a7d3d1fd2f9d1b99852dce47bbf69ae8001efd444b9db7d406d  artifacts/lifeline/guest/packet-smoke/packet-smoke.json
f0f8ca429b7ed4832c762e0cb49ba1af048bdb3d7729831e342e56560173cdf6  artifacts/lifeline/guest/preflight-guest.json
f7ec04312b93b2ff64e532a6727ca3efa74832a39c634c34151c380ac26f28c6  artifacts/lifeline/preflight-host.json
5373ecde115ffbc37448a18f42049205977503268305bc9473ee7b5afb7d1262  artifacts/lifeline/provider-smoke.json
```

## What this supports

The VM can create a run-owned Mininet network, carry real UDP messages, measure receipts on a shared monotonic clock, apply and read back the four control primitives, and remove only its own objects. Project state for this run stayed on the SSD.

## What remains unqualified

- Any live Meta response, its latency distribution, usage and parser behavior. Requires `MODEL_API_KEY` in `.env`, then the single smoke and `--count 10`.
- Clean deletion with pre-existing unrelated bridges present (none existed in the guest).
- The six-switch scenario, background contention and fault cascades (Task 4).
- Packet timing under heavier load; one quiet VM measurement only.

## Decision and next task

Packet work proceeds to Tasks 2–3, which need neither networking nor a model. G0 qualifies when a real provider call succeeds and the ten-request distribution is retained.
