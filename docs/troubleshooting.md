# Troubleshooting

Use the application's stage error and diagnostic information to identify the failing step. Keep raw logs and media local; redact personal paths and sensitive content before sharing a report.

## Desktop startup

| Symptom | Check |
| --- | --- |
| Port 1420 is already in use | `pnpm tauri dev` already starts Vite. Stop the extra development server you started, then run the desktop command once. |
| Native file selection or engine commands fail in a browser | Run `pnpm tauri dev`. `pnpm dev` alone has no native Tauri backend; `?ui-preview` supplies sample data only. |
| Frontend changed, but native behavior did not | Restart the desktop development process after Rust/Tauri changes. Refreshing Vite does not rebuild the running backend. |
| Rust linking or WebView startup fails | Check the pinned toolchain, C++ Build Tools, Windows SDK and WebView2 Runtime in [development](development.md). |

## Engines unavailable

Open Settings & Engines and inspect each component's path and status. Source checkouts do not include executables. Prepare and verify the pinned pack, or configure existing installations:

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

The prepared directory is `target/distribution/windows-x64/engines`. Select that directory in settings. A packaged integrity failure should be repaired by preparing/reinstalling the matching pack; replacing random executable files can leave its manifest inconsistent. `METORIGIN_ENGINE_DIR` is a development override and is ignored in release mode. See [engine integration](engine-integration.md).

## Import and preflight

- **The image folder picker does not show images:** the current import uses a file picker that displays JPG/JPEG/PNG. Select one image to import its entire parent folder, including subfolders. A Windows dialog restricted to folders is the earlier behavior; restart the current desktop build if it remains visible.
- **Some images are ignored:** inspect valid, damaged and ignored counts. Check actual file format and readability; renaming an unsupported file's extension does not convert it.
- **Continue is disabled after changing a preset:** switching the preset reruns preflight. Wait for the current check; if it fails, resolve the displayed blocking item and retry. Only the latest preset's result can enable continuation.
- **Destination rejected:** check the name, writable parent directory, collision with an existing project and available space. The destination must be separate from the source.
- **Disk space is unknown:** the project center queries the application's executable volume; project-specific checks query the relevant project/destination. Check whether the location is accessible. Unknown is different from a measured zero.

The import and preflight behavior is described in the [user guide](user-operation-flow.zh-CN.md).

## Reconstruction failures

| Stage | What to inspect |
| --- | --- |
| FFmpeg / frame preparation | Source decoding, supported media, source access and output space |
| COLMAP features/matching/mapping | Overlap, blur, texture, reflections, moving objects and whether enough views register into one model |
| COLMAP validation | Registration and connectivity results; inspect warnings before choosing an allowed continuation |
| Brush training | GPU availability, driver compatibility, device memory, prepared dataset and engine error code |
| Export / model validation | Valid completed PLY, output access and free space |

A higher preset cannot compensate for missing viewpoints or wrong camera reconstruction. For a device-memory failure, try a lower preset after reviewing its effect on previously completed stages. Do not manually delete files during a running task.

## Pause, cancel and recovery

Pause/cancel requests are not necessarily instantaneous. Wait for the application to apply the operation and settle its state before restarting or moving the project. A valid saved checkpoint can support geometry recovery, but does not restore the entire optimizer state.

After an interruption, open the full `.splat-project` directory and allow artifact checks to finish. A partial checkpoint is not a completed model. If an engine process failed, use the recorded stage error and retry/recovery action rather than changing `project.json` by hand. See [project format](project-format.md).

## Preview problems

- **No preview yet:** the selected stage may not have produced a viewable artifact. Wait or select a completed stage. COLMAP sparse geometry and a trained Gaussian model are different outputs.
- **Saved model works but training does not update:** check that `brush_live.exe` is beside the configured `brush_app.exe`, start a new training session, follow the current stage and choose “实时” or “低频”. A hidden page or “暂停预览” stops requesting snapshots.
- **Viewing an old checkpoint:** manual checkpoint selection pins that file. Use “跟随当前阶段” to return to current output.
- **PLY rejected:** the Gaussian path accepts complete binary little-endian float32 PLY with required Gaussian properties, SH degree 0–3, up to the implemented 1 GiB limit. Incomplete writes and files outside the validated project path are rejected.
- **WebGL/GPU rendering fails:** use the native desktop environment with WebView2 and a supported GPU/driver. A synthetic browser preview cannot establish rendering compatibility.

For the companion build, model update protocol and native reproduction steps, read [Gaussian live preview](gaussian-live-preview.zh-CN.md).

## Reporting a problem

Include the application version, Windows version, engine versions, GPU/driver, preset, failing stage, error code and steps to reproduce. Use the application's diagnostic export where available and review its contents before sharing. Never attach private project media or credentials to an issue. Security vulnerabilities should be reported through [SECURITY.md](../SECURITY.md).
