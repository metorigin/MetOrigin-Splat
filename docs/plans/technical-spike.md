# Real Pipeline Technical Spike

## Scope

This spike verifies the Windows desktop pipeline against one complete video using the Fast preset. Machine-specific paths are intentionally replaced with aliases:

- Input: `<DATASET_ROOT>/video/20260701_C0115.MP4`
- Project: `<PROJECT_ROOT>/.artifacts/technical-spike/ffmpeg-fast.splat-project`
- Engines: `<PROJECT_ROOT>/.engines`

The raw dataset, engine packages, logs, checkpoints, and generated models are local test artifacts and are not committed.

Test date: 2026-07-13 (Asia/Shanghai). Host: Windows, NVIDIA GeForce RTX 5080 Laptop GPU, driver 592.01, 16,303 MiB reported VRAM. More than 20 GiB of free space was confirmed before the run.

## Reproducible engine set

| Engine | Package and source | SHA-256 | Runtime evidence | License note |
| --- | --- | --- | --- | --- |
| FFmpeg / FFprobe | `ffmpeg-release-essentials.zip` from <https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip> | `db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec` | `ffmpeg version 8.1.2-essentials_build-www.gyan.dev`, GCC 16.1.0 | This build reports `--enable-gpl --enable-version3`; redistribution must preserve the build license and notices. |
| COLMAP CUDA | `colmap-4.1.0-x64-windows-cuda.zip` from the official [COLMAP 4.1.0 release](https://github.com/colmap/colmap/releases/tag/4.1.0) | `ccd2f8c5b44f3e0ce645170d6abad30ff763ede97eeb0e6e23af1993e624e64b` | `COLMAP 4.1.0 (Commit fa8e3b3 on 2026-06-26 with CUDA)` | COLMAP upstream is BSD-licensed; a distributable engine pack must also include notices for bundled dependencies. |
| Brush | [`brush-app-x86_64-pc-windows-msvc.zip`](https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-x86_64-pc-windows-msvc.zip) | `b68e3e9cf052d51bf3ee30776fa5a364de7f2ba13b58443128ff797bb7bcfcd6` | `brush-cli 0.3.0` | Apache-2.0; the package's `LICENSE` file was inspected. |

`EngineLocator` resolved this set from `METORIGIN_ENGINE_DIR`, application resources, then `PATH`. Both engine checks and pipeline execution use the same resolved paths. The tested Brush executable is named `brush_app.exe`.

## Input profile

| Property | Measured value |
| --- | --- |
| Size | 1,669,378,064 bytes (about 1.55 GiB) |
| Duration | 133.133 seconds |
| Resolution | 3840 x 2160 |
| Codec | H.264 |
| Frame rate | 29.97003 fps |
| Reported source frames | 3,990 |
| Rotation metadata | None |

## Verified command templates

Values in angle brackets are substituted with resolved, OS-native paths. Commands are launched without a shell, and stdout/stderr are streamed to stage logs.

```text
ffprobe -v quiet -print_format json -show_format -show_streams <INPUT_VIDEO>

ffmpeg -progress pipe:2 -nostats -i <INPUT_VIDEO>
  -vf "fps=2,scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease"
  -q:v 2 -frames:v 267 -start_number 0 -fps_mode vfr -y <FRAMES>/%06d.jpg

colmap database_creator --database_path <COLMAP>/database.db

colmap feature_extractor --database_path <COLMAP>/database.db --image_path <IMAGES>
  --FeatureExtraction.use_gpu 1 --SiftExtraction.max_num_features 8192
  --ImageReader.single_camera 1 --ImageReader.camera_model PINHOLE

colmap sequential_matcher --database_path <COLMAP>/database.db
  --SequentialMatching.overlap 10

colmap mapper --database_path <COLMAP>/database.db --image_path <IMAGES>
  --output_path <COLMAP>/sparse

colmap model_analyzer --path <COLMAP>/sparse/<MODEL_ID>

brush_app <TRAINING_DATASET> --total-steps 3000 --sh-degree 0
  --export-every 500 --export-path <CHECKPOINTS>
  --export-name checkpoint_{iter}.ply --eval-every 300
  [--start-iter <CHECKPOINT_ITERATION>]
```

Brush v0.3.0 does not have a `train` subcommand and does not accept the previously estimated `--colmap`, `--images`, `--output`, or `--iterations` flags. The positional dataset argument and flags above were verified against the packaged `--help` output and a real run.

## Results

### FFmpeg frame extraction

| Metric | Result |
| --- | --- |
| Preset | Fast, 2 fps, maximum 1280 x 720 |
| Planned / actual frames | 267 / 266; one-frame deviation accepted after validation |
| Output validation | 266 non-empty JPEG files, all 1280 x 720 |
| Output size | 27,488,724 bytes |
| First run | about 21 seconds |
| Cancellation acknowledgement | about 1.74 seconds; project lock released |
| Cached rerun | about 0.06 seconds |
| Manifest | Atomic `frames/frames.json` with source metadata, plan, per-frame dimensions and sizes |

Progress was parsed from FFmpeg's machine-readable stderr stream. Cancellation terminated the running Windows process tree and retained a consistent project state.

### COLMAP reconstruction

The pipeline selected `processed/` when populated and otherwise used `frames/`. This run used the validated video frames and sequential matching.

| Stage / metric | Result |
| --- | --- |
| Feature extraction wall time | about 67 seconds |
| Matching wall time | about 6 seconds |
| Mapping wall time | about 16 minutes 17 seconds |
| Database images | 266 |
| Keypoints | 741,151 |
| Matched image pairs | 1,056 |
| Verified matches | 328,455 |
| Selected model | `colmap/sparse/0` |
| Registered images | 196 / 266 (73.7%) |
| Sparse points | 28,365 |
| Observations | 178,286 |
| Mean track length | 6.285422 |
| Mean reprojection error | 0.715018 px |
| Validation | Passed: registration rate, point count, and reprojection error thresholds |
| Cached full-pipeline rerun | about 0.34 seconds through the COLMAP stages |

`colmap/result.json` records the selected model relative path; downstream stages do not assume that model `0` is always the best result.

### Brush training and export

`training/dataset` was assembled as an isolated COLMAP dataset using hard links where possible and copies as fallback. Checkpoints were exported every 500 steps.

| Metric | Result |
| --- | --- |
| Preset / target | Fast / 3,000 steps |
| Cancellation test | Cancelled at the 500-step PLY checkpoint; checkpoint retained and project lock released |
| Recovery test | Resumed geometry from step 500 and completed step 3,000 |
| Successful recovery segment | 44.569 seconds |
| Checkpoint sequence | `checkpoint_0500.ply` through `checkpoint_3000.ply` |
| Final output | `output/scene.ply` |
| Final size | 3,922,395 bytes (3.74 MiB) |
| Parsed splat/vertex count | 70,035 |
| Baseline / peak GPU memory | 1,960 / 2,947 MiB; about 987 MiB incremental |
| Peak GPU utilization | 98% across 96 samples |
| Cached rerun | Less than 5 seconds |
| Export metadata | `output/manifest.json` plus Gaussian-splat preview entry |

Brush v0.3.0 exposes training loss internally but does not emit it on stdout or stderr. Therefore `final_loss` is deliberately `null`. A PLY checkpoint plus `--start-iter` restores geometry, not optimizer state, so `optimizer_state_restored` is deliberately `false`.

## Cancellation, restart, and caching evidence

1. A real FFmpeg run was cancelled; the child process tree exited, the stage became cancelled, and the project lock was released.
2. A real Brush run was cancelled after `checkpoint_0500.ply` appeared; the checkpoint remained valid.
3. The pipeline was recreated to simulate an application restart. Crash recovery did not treat the partial Brush stage as complete, selected the latest valid checkpoint, and finished training and export.
4. A second cancellation/recovery run reproduced the same behavior.
5. Running the completed project again validated outputs and skipped valid stages from cache instead of re-running the engines.

The recovery rule is intentionally strict: Brush is complete only when `training/result.json` points to a valid final PLY. A partial checkpoint alone means resumable, not complete.

## Failures and compatibility findings

- COLMAP 4.1 moved the GPU option used here from the older `SiftExtraction.use_gpu` form to `FeatureExtraction.use_gpu`. The former failed against the pinned binary; the adapter now emits the verified flag.
- `colmap model_analyzer` writes its report to stderr with glog prefixes. Parsing only stdout produced an empty model report; the implementation now handles the real output stream and prefix format.
- The old Brush command shape was speculative and incompatible with v0.3.0. The adapter now uses only flags present in the pinned binary's help output.
- A manually launched background PowerShell Job caused Brush/CubeCL to panic when the job lacked the expected CubeCL cache environment. Normal `ProcessRunner` execution was not affected and completed twice; background-job sampling is not used by the product pipeline.
- Brush does not expose Loss through its CLI output. The pipeline records an unknown value instead of manufacturing a metric.
- Video reconstruction registered 73.7% of frames rather than all frames. This passes the current 50% quality threshold but should remain visible as a capture-quality signal.

## Verification commands

The Brush implementation and documentation were accepted only after the following passed on the same host:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
cargo test -p splat-pipeline --test real_brush -- --ignored --nocapture
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd build
pnpm.cmd --dir apps/desktop tauri build --debug --no-bundle
```

The real FFmpeg, COLMAP, and Brush tests are ignored by default because they require pinned local engines, the private test dataset, substantial disk space, and a compatible NVIDIA GPU.

## Remaining coverage gaps

- Only one complete video dataset has been verified; the roadmap target of three datasets is not complete.
- Independent photo input, exhaustive matching, portrait/rotation footage, mixed image formats, long paths, constrained disk/VRAM, a second GPU class, and full application-close recovery still require evidence.
- Engine redistribution notices and installer packaging remain release work even though local resolution and checksums are verified.
