# LIFELINE repository instructions

## SSD storage requirement

The owner requires all project-created files and project-controlled runtime data to stay on the external SSD.

- The canonical macOS repository is `/Volumes/PortableSSD/Meta_Hackathon`.
- A home-directory symlink to it may exist as a compatibility alias only. Never replace it with an internal-drive checkout.
- Before any write, install, build, environment creation or experiment, confirm the SSD mount and resolve the physical working/output paths. If the SSD is absent, stop; never silently create an internal-drive fallback or a directory pretending to be the missing mount.
- Keep source, Git data, dependencies, environments, caches, downloads, temporary project files, build outputs, logs, captures, evidence and worktrees on the SSD. Use repository-local paths, `.work/` for disposable working data, and `artifacts/lifeline/` for run evidence.
- Configure package-manager, model-cache, VM and container storage locations explicitly before provisioning. Keep VM disks and snapshots on the SSD; do not accept an internal-drive default. Do not repurpose `HOME` or `CODEX_HOME`.
- The host SSD is ExFAT. Use a native guest filesystem inside an SSD-backed VM disk for Linux permissions, symlinks and Unix sockets. Guest-local or RAM-backed runtime paths are allowed when the VM's persistent storage is on the SSD. Record the host-to-guest mapping during preflight.
- Resolve symlinks before accepting output paths. The old home-directory alias is valid only when it resolves to the canonical SSD repository.
- Read-only references to existing projects elsewhere are permitted; new LIFELINE outputs belong on the SSD.

The complete storage layout and implementation gates are in the [living plan](docs/superpowers/plans/2026-10-31-lifeline-program.md#0-ssd-workspace-and-storage-rule). This is a required project constraint, not a claim that every future tool's default paths have already been configured.
