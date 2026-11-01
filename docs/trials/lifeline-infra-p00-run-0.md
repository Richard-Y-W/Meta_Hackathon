# LIFELINE Infra P00 Run 0 — Preserve evidence and reproduce setup

**Date:** November 1, 2026. **Task:** P00. **State:** qualified.

**Result:** The V1 evidence is snapshotted with hashes, and the 48 first attempts are separated from the 9 withdrawn reruns. The preflight now refuses off-SSD caches, insufficient capacity, and VM disks whose image file is not on the SSD. A second guest built only from the pinned definition ran the unit suites, packet controls, a guarded route update and replay, and cleaned up after itself. The demo guest `lifeline` was left intact.

## Identity

| Item | Value |
| --- | --- |
| Starting commit | `b4d7591` (owner's program rewrite, committed unchanged as the baseline) |
| Evidence snapshot | `artifacts/lifeline/infra/p00-run-0/release-manifest.json`, sha256 `ad90aaa7…8430`: 158 retained bundles hashed; 48 first attempts (all valid; 3 by the disclosed reclassification); 9 withdrawn reruns; frozen `protocol-v1.json`, `policy-v1.json` and the V1 archive plan hashed. No frozen file or original bundle was modified |
| Host preflight | `artifacts/lifeline/infra/p00-run-0/preflight-host.json`, sha256 `01eec45e…08e6`: storage `ok`; VM disk `/Volumes/LifelineVM/lima/lifeline/disk` resolved through `hdiutil` to `.work/vm/lifeline-apfs.sparsebundle`; 235.5 GB free against 5.5 GB required (0.5 GB projected + 5 GB reserve) |
| Clean-room definition | `runtime/vm/lifeline-cleanroom.yaml`, sha256 `ea504191…4d00c` |

## Preflight (RED → GREEN)

The new flags were first added as no-ops, so the five new tests failed on behavior, not argument parsing: an explicit internal cache path admitted (`ok` instead of `storage_path_rejected`); `PLAYWRIGHT_BROWSERS_PATH` on the internal drive admitted; a petabyte batch admitted (`ok` instead of `storage_insufficient`); a VM disk on a mounted image not resolved; physical work roots not reported. After implementation, `node --test test/lifeline/preflight.test.mjs` passed 28/28.

The fixtures control every path; the live SSD was not disconnected. Mounted-image resolution has a test-only `--disk-image-fixture`; live runs use `hdiutil info -plist`. Guest-role admission also checks the RAM-backed `/run` scratch, which filled during the pilot.

## Clean-room guest

`LIMA_HOME=/Volumes/LifelineVM/lima limactl start --tty=false --name=lifeline-clean runtime/vm/lifeline-cleanroom.yaml` → ready and provisioned in 180 s, exit 0, no manual corrections. Downloads: the Ubuntu image was reused from `.work/downloads` (digest-checked by Lima); apt packages from the Ubuntu archive; the Node tarball from nodejs.org with its SHA-256 checked. Resources: 2 vCPU, 3 GiB, 16 GiB disk, while the 6 GiB demo guest kept running.

| Check in `lifeline-clean` | Result |
| --- | --- |
| Pinned versions | Ubuntu 24.04.5, kernel 6.8.0-147, mininet 2.3.0-1.1, openvswitch 3.3.9-0ubuntu0.24.04.1, iperf3 3.16-1build2, rsync 3.2.7-1ubuntu1.5, Node v24.14.1 |
| Unit suites | Node 227 pass, 20 skipped (host-SSD tests); Python contracts pass; root-only OVS integration 2 pass |
| Guest preflight | storage `ok`, 13.2 GB workspace free, 302 MB `/run` scratch free; packet-ready; credential present only because the user-supplied `.env` was copied with the source |
| Packet control ×2 (start/stop/cleanup) | Both `completed`, 2,400/2,400 on time, no run-owned bridges, links or processes, audit clean |
| Guarded route update (scripted diagnostic) | 3/3 actions confirmed, 4,800/4,800 on time, 0 lost |
| Replay | New route-update and packet-control bundles, and the retained `recovery-run-0`, verify |
| Orphans after all runs | 0 bridges, 0 run links, 0 worker/traffic processes |

Evidence: `artifacts/lifeline/cleanroom/{packet-control-1,packet-control-2,route-update}`.

One defect was found and fixed: the root-only integration tests left their `/run/lifeline/itest-*` directories (up to 340 KB of traffic logs) in the RAM-backed tmpfs. Repeated runs would refill `/run`, the failure class seen in the pilot. Test teardown now removes them, and a rerun left 0 directories.

## Other verification

```text
npm test (host)                                    → 247 pass, 0 fail (includes 5 new preflight and 2 release-manifest tests)
python3 -m unittest … test_*.py (host)             → pass (2 integration tests skipped with reason)
```

The README "Run it" section was rewritten from this observed setup, with credentials as user-supplied inputs.

## Remaining limits

- The clean room shares the APFS image volume with the demo guest. A fully separate host or disk was not exercised.
- The host-side `hdiutil` image resolution covers macOS only.
