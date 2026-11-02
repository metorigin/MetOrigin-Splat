# macOS packaging history, 2026-10-27

> Archived from the release process on 2026-11-01. Candidate names, pending checks and preservation statements below describe that record, not the latest local package or current retention. See [project status](../../status.md) and [current release policy](../../release-process.md).

<!-- archive-note:end -->

The historical runtime-fixed 2026-10-27 candidate completed the entire script with exit 0,
including the actual frozen-pack Rust release resolver without a cache, strict
ad-hoc signature verification and a read-only DMG mount whose
app exactly matched the initially verified bundle. Its DMG SHA-256 is
`852180d7ba7de5d712f95abef9244494bd10c4502cc86f6f1e22be2f5c803d4b`.
It subsequently failed native application version preflight; the complete Brush
version matcher and FFprobe parser have since been corrected and checked against
the actual frozen pack.
The previous restoration-fixed candidate failed native preflight because the runtime assumed thin
Mach-O headers and rejected a valid one-slice arm64 fat dylib. The earlier
candidate was rejected after native restoration reused stale Export output.
All three historical apps, DMGs and evidence sets remain preserved. Both the
resource resolver and production application adapter/version preflight are now
required before every full build. A subsequent full run correctly stopped before
Tauri at COLMAP's ten-second first-path startup limit. Only macOS COLMAP `-h` now
uses a 45-second execution deadline, with one attempt, no retry and unchanged
64 KiB capture/process cleanup; other probes retain ten seconds. A new physical
pack path passed the actual application gate on the same host.

The new full internal Alpha build completed from the beginning with exit 0,
both real gates passing, and exact signed-app/read-only DMG agreement. Its main
executable SHA-256 is
`8656d4e02678cd6d2f30fb92a2c19a26a5ef38ada8af93cb3f93b9b0bb9d03a3`;
the new `build.07osYS` DMG SHA-256 is
`77e5c8e411873037e64d8cb4e988377788a7b393a197a99262cbb4bc99402bf0`.
See the [candidate and retained failure evidence](../../validation/macos-engine-pack.md#historical-internal-alpha-candidate-application-preflight-passed).
Its `.6` 311-image balanced workload and Chinese/space-path native execution
remain pending in this packaging record; packaging and application preflight
success is not final app acceptance.

The selected minimum deployment version is macOS 15.0. Current evidence comes from one M1 Pro / 32 GB / macOS 27.0.1 development machine. Minimum-OS and 16 GB clean-machine installation, Windows regression, and Developer ID signing/notarization remain separate acceptance requirements. Local relocation and configured CI are recorded as such, not as clean-machine or executed-CI evidence. See the [acceptance plan](../plans/macos-gaussian-generation-plan.zh-CN.md).
