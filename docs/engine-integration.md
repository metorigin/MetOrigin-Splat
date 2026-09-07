# Engine integration

The application runs FFmpeg, COLMAP and Brush as local child processes. Engine adapters construct arguments and parse results; `splat-process` owns execution, output capture and cancellation. Pages do not build shell commands or launch engines directly.

## Version authority and setup

[engine-lock.json](../packaging/windows-x64/engine-lock.json) is the authority for packaged archives, versions, download locations and SHA-256 values. The current set is FFmpeg/FFprobe **8.1.2**, COLMAP **4.1.0 CUDA** and Brush **0.3.0**, with the locked Microsoft VC++ runtime prerequisite. A different executable passing a version command does not establish full pipeline compatibility.

Configure local executable paths or a containing engine directory through Settings & Engines. To prepare the locked pack from the repository root:

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

The engine directory is `target/distribution/windows-x64/engines`. Select it in Settings & Engines for development. Downloads are cached under `.engines/downloads`; generated files stay out of Git. See [Windows packaging](../packaging/windows-x64/README.md) for offline preparation and distribution requirements.

## Resolution and integrity

Path selection is implemented by [EngineLocator](../crates/splat-hardware/src/locator.rs), with desktop context supplied by [system commands](../apps/desktop/src-tauri/src/commands/system.rs).

- Development mode accepts `METORIGIN_ENGINE_DIR` as an explicit developer override. Otherwise it considers configured executable/directory paths, available resource engines and then `PATH` for missing components.
- The desktop application can discover a local or portable `.engines` directory. A prepared pack can also be selected explicitly in settings.
- Release mode ignores `METORIGIN_ENGINE_DIR` and prefers the verified resource pack. Missing or corrupt expected pack resources are surfaced as errors rather than silently switching to arbitrary executables on `PATH`.
- Manifest verification checks the packaged inventory and integrity. Engine status and reconstruction use the resolved paths, avoiding a separate unverified launch path.

The exact fallback behavior is defined by the locator and its tests. Preserve the distinction between an absent development engine and a corrupt packaged engine.

## Adapter responsibilities

| Adapter | Inputs and outputs |
| --- | --- |
| [FFmpeg](../crates/splat-engine-ffmpeg/src/) | FFprobe metadata; planned video extraction; progress parsing; frame files and manifest |
| [COLMAP](../crates/splat-engine-colmap/src/) | Prepared images; database, features and matches; sparse models; selected-model and quality information |
| [Brush](../crates/splat-engine-brush/src/) | Prepared COLMAP dataset and preset; training progress, PLY checkpoints and optional live snapshots |

Video import extracts frames; image-folder import validates and prepares existing images. Preprocessing preserves aspect ratio. Frame limits and training parameters come from [presets](../presets/) and project settings.

COLMAP may produce more than one sparse model. Downstream stages use the selected model recorded in `colmap/result.json`; they must not assume model `0`. Quality checks report registration rate, sparse-point count, reprojection error and reconstruction-attempt information when available.

Brush v0.3.0 uses a positional dataset path with options such as `--total-steps`, `--sh-degree`, `--export-every`, `--export-path` and `--export-name`. It has no `train` subcommand. The adapter is the authority for the emitted arguments; the [historical baseline](validation/engine-baseline.md) explains compatibility issues found during real runs.

## Brush live-preview companion

The stock CLI emits saved checkpoints. Continuous inspection of the unsaved training model uses `brush_live.exe`, built from the pinned Brush v0.3.0 source plus the files in [integrations/brush-live](../integrations/brush-live/).

```powershell
pnpm build:brush:live
# Use cached source and Cargo dependencies:
pnpm build:brush:live -Offline
# Build beside a separately installed Brush executable:
pnpm build:brush:live -OutputDirectory 'D:/Engines/Brush'
```

The default companion output directory is `.engines/brush-v0.3.0-windows-x64`. The script verifies the source archive and builds in isolated directories under `target/`; the generated upstream copy and executable are not repository source. Pack preparation includes the companion and its license.

When the companion is beside the configured `brush_app.exe`, new training sessions select it automatically. An already running stock process is not replaced. Preview snapshots are demand-driven, acknowledged and session-scoped; they do not change recovery checkpoint intervals. See [Gaussian live preview](gaussian-live-preview.zh-CN.md) for the rendering protocol and limitations.

## Recovery and failure handling

- Completed stages validate their artifacts before reusing them. A partial output file alone does not establish successful completion.
- Brush recovery loads a valid PLY checkpoint and iteration. This restores geometry, not optimizer state.
- `training/result.json` must refer to a valid final model before training is treated as complete.
- Missing metrics remain unknown. In particular, stock Brush CLI output does not provide training loss; the application does not invent one.
- Cancellation is applied through the process runner and preserves valid checkpoints. Failure details go to diagnostics; user-facing errors retain stable codes and localized explanations.

Use the opt-in [real-engine tests](development.md) after changing argument generation, output parsing, engine versions, cancellation or recovery. Record the actual engine/GPU/input context, and keep private media and raw reports out of Git.
