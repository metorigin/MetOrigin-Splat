# Windows1 production pipeline validation

Date: 2026-10-30. Scope: the twelve production Rust pipeline stages, engine adapters, process runner, execution profiles, checkpoint recovery, live file protocol, export and cache reuse. Native WebView interaction, installation and native macOS regression have separate acceptance records. These results do not switch the release default.

The opt-in tests are in [real_windows_pipeline.rs](../../crates/splat-pipeline/tests/real_windows_pipeline.rs). They create isolated projects with Chinese characters and spaces in their paths, verify source hashes, freeze actual engine/device identities, then use `PipelineOrchestrator::new_default_with_config`. No SfM output is injected into these full-pipeline runs.

## Candidate and measured environment

- Windows `10.0.26300.0`, x86_64, NVIDIA GeForce RTX 5080 Laptop GPU, driver 592.01; system RAM 33,752,997,888 bytes. NVIDIA reports 16,303 MiB total VRAM; this is not a WGPU available-budget measurement.
- Brush `1.0.0+metorigin-windows.1`, source `1388f74c6fe0236f68ee4915564bf00e9d2e3747`, executable SHA-256 `4398eeabd0cc4becaf5d82fb81b76dfd377b791b7bd7251b0e2b7ca8fe7e4001`. The fixed cumulative Mac patch and independent Windows delta are recorded by [source-lock.json](../../integrations/brush-windows/source-lock.json) and the generated `BUILD-INFO.json`.
- FFmpeg and FFprobe both report the locked Windows vendor identity `8.1.2-essentials_build-www.gyan.dev`; COLMAP reports `4.1.0`.
- DX12 and the canonical WGPU device ID returned by the actual Gaussian forward/backward probe are frozen in each profile. The training stage repeats the probe using that same backend/device and launches the verified main CLI. No legacy live companion is used.
- COLMAP uses CUDA feature extraction/matching, explicit CPU global positioning and Ceres CPU bundle adjustment. The archive's lack of CUDA Ceres/cuDSS is not represented as a successful GPU global-positioning run.

Effective settings are 3,000 iterations, SH0, maximum resolution 960, 300,000 maximum Gaussians, 256 MiB image cache, two loader/COLMAP threads and LOD 0. The dedicated training-policy budget is 4 GiB. Dynamic WGPU available working set remains unknown and is omitted, rather than recorded as zero or inferred from total VRAM. The requested shared `fast` preset is unchanged. This is candidate coverage on one machine, not a guarantee for every 16 GB adapter or every preset.

## Completed photo and real-video runs

| Case | Source and extraction | Registered | Final Gaussians | Consumed valid live frames | Core elapsed |
| --- | --- | --- | --- | --- | --- |
| James40 photos | Fixed CC0 James/Robson sample, 40 original images | 40/40 | 81,228 | 314 | 453.86 s |
| Captured TUM desk video | Fixed CC-BY-4.0 AVI, 5 fps, cap 120; 102 actual frames | 102/102 | 85,558 | 264 | 305.79 s |

The TUM AVI SHA-256 is `3faa0fa667fa95d28ecf0d231c3383ddef8695f391f07d48f484af39de43a854`. FFprobe measures this actual container as **20.433333 seconds**, 640×480. The original RGB-D sequence's nominal duration is separate. This video has no rotation metadata; it does not establish rotated-phone-video acceptance. The James40 identities remain pinned in the [existing corpus manifest](../../packaging/macos-arm64/fixtures/james-sample-40.json).

Each row includes all of the following checks:

1. A fresh reconstruction from copied raw source media, a successful actual compute probe, and a frozen Windows1 profile containing the real executable hashes and device ID.
2. Cancellation after checkpoint 1,000, a valid retained partial PLY, stopped live session and released project lock.
3. Model-only warm start to iteration 3,000 with an explicit `optimizer_state_restored=false` record.
4. Live request/ACK consumption across isolated UUID sessions. Every received frame has a matching revision filename, valid Gaussian payload and matching declared point count.
5. Completed model export, followed by explicit checkpoint selection at 1,000 and another warm start to 3,000. The prior completed output remains in the checkpoint-restore archive with its original SHA-256.
6. A subsequent cached run skips Brush training; the final scene is valid, all twelve stages are completed/skipped, and both original inputs and the copied authoritative source files remain unchanged.

The photo final PLY SHA-256 is `5cb1f9075784a0995e84921f16fd39d2b6c69d33454d744e2ae8537de76e4916`; the video final PLY SHA-256 is `63772d29c54da99bf9cc320d2d151e44116cc5e07049c8500b05ad64cf21c4e8`. These identify these particular runs; independent numerical training runs are not expected to be byte-identical.

Elapsed times include repeated training, probes, reconstruction, validation, hashing, export, restore and cache checks using a Rust debug test binary. They are not single-training performance measurements.

## Failures retained and fixed

The initial photo attempt stopped before opening the project database because the Windows vendor FFmpeg version token did not equal the Mac-only exact `8.1.2` rule. Windows now accepts the exact locked Gyan suffix while retaining the full reported identity; the Mac exact-version rule remains unchanged. A regression rejects unknown suffixes, release candidates, prefix collisions and future versions.

The next attempt produced live frames and a valid checkpoint, then exposed a real Windows warm-start failure: `sync_all` on a copied file reopened read-only returns access denied because Windows `FlushFileBuffers` requires write access. Windows now reopens its managed temporary resume copy with write access. The Unix reopen/fsync path is unchanged. The NTFS regression covers repeated replacement, a held reader and a failed copy preserving both the prior `init.ply` and the original checkpoint. The subsequent complete photo/video runs passed this path.

## Local evidence and reproduction

Evidence is ignored by Git; source media, binaries and unredacted native logs are not committed:

- `target/windows-alignment-evidence/core-photos-dx12-01.log`: early vendor-version rejection, before pipeline mutation.
- `target/windows-alignment-evidence/core-photos-dx12-02.log` and `target/windows-core-photos-dx12-02/`: retained checkpoint/live/cancellation evidence and the original resume failure.
- `target/windows-core-photos-dx12-03/Windows1 照片 中文 空格.splat-project/runtime/acceptance-evidence.json`: complete photo evidence.
- `target/windows-core-video-dx12-01/Windows1 视频 中文 空格.splat-project/runtime/acceptance-evidence.json`: complete real-video evidence. The adjacent `frames/frames.json` records actual container metadata and extraction settings.

Set absolute engine/fixture paths in `METORIGIN_TEST_FFMPEG`, `METORIGIN_TEST_FFPROBE`, `METORIGIN_TEST_COLMAP`, `METORIGIN_TEST_BRUSH`, `METORIGIN_TEST_IMAGE_DIR` and, for video, `METORIGIN_TEST_VIDEO`. Set a fresh existing `METORIGIN_TEST_PROJECT_ROOT`, measured `METORIGIN_TEST_SYSTEM_MEMORY_BYTES`, `METORIGIN_TEST_ITERATIONS=3000`, and explicit `METORIGIN_BRUSH_BACKEND=dx12`. An optional `METORIGIN_BRUSH_DEVICE_ID` must be the canonical ID; an invalid supplied value is rejected. The tests never overwrite an existing acceptance project.

```powershell
cargo test -p splat-pipeline --test real_windows_pipeline windows_real_photos_cancel_resume_restore_to_scene_ply -- --ignored --exact --nocapture
cargo test -p splat-pipeline --test real_windows_pipeline windows_real_video_cancel_resume_restore_to_scene_ply -- --ignored --exact --nocapture
```

The sandbox's default OS temporary directory denied replacement in existing NTFS tests; setting `TEMP` and `TMP` to an existing test directory inside the checkout made both unchanged held-reader/replacement regressions pass. Native WMI-based resource observations require the native execution context. These environment restrictions are recorded separately from product failures.

## Medium-scene resource run

The separate ignored `windows_medium_video_resource_and_recovery` test uses the same fixed captured AVI at **15 fps, maximum 320 frames**, an isolated project and the same 3,000-step recovery/live protocol. The actual result is **307/307 registered frames, 26,597 initial sparse points, 135,837 final Gaussians and 211 valid consumed live snapshots**. Cancellation at 1,000, warm start to 3,000, explicit restore at 1,000, preserved prior output, cached skip and unchanged source all passed. The final PLY SHA-256 is `7f8cac3b73f0724cd3997e64b2b50fc683e36ac932607a28df70e2f39a4676ad`. The 5 fps acceptance case remains unchanged.

The original run was interrupted accidentally during COLMAP reconstruction. A native process inventory established that its harness, COLMAP owner and sampler had exited; a stale log was not treated as proof that a process was still active or that the job had succeeded. The continuation explicitly selected the same project through `METORIGIN_TEST_RESUME_PROJECT`, acquired its project lock, archived incomplete mapping attempts and old profile/pending/log evidence under a unique `runtime/acceptance-interruptions/` entry, then reused validated feature/matching caches and reran mapping. It did not overwrite the imported raw video. The first continuation setup attempt stopped because its test-only archive parent directory was missing; the fixture was preserved and the harness setup was corrected before the successful continuation. No production recovery policy was changed for this setup issue.

The accepted continuation took 706.55 seconds including reconstruction, three training processes, validation, restore and cache checks. It is not an uninterrupted fresh-run performance figure. Evidence is at `target/windows-core-medium-dx12-01/Windows1 中型视频 中文 空格.splat-project/runtime/acceptance-evidence.json`; the record explicitly marks `continued_after_external_interruption=true`.

The native sampler writes the original `medium-resource-samples.jsonl`, short failed-setup `medium-resource-samples-continue-01.jsonl`, and accepted `medium-resource-samples-continue-02.jsonl` under `target/windows-alignment-evidence/`. Each segment is retained. The accepted segment starts before the continuation and ends after final training/cache checks, with 393 observations at a measured average interval of about 1.85 seconds. Native queries add overhead to the one-second loop delay.

It records known engine PID/creation identity, RSS/private bytes, system available RAM, bounded training-log timing hints and global NVIDIA observations. Three actual training processes have 10, 14 and 13 memory samples across fresh/cancel, resume and restore. Their first observations are 1.04–2.06 seconds after process creation; loading completion and train/live processing also appear in the timing hints. Shorter initialization or loading peaks can be missed. Maximum observed Brush RSS is **570,855,424 bytes** and private bytes **848,265,216 bytes**. These sampled peaks are lower bounds, not continuous initialization maxima. In the accepted segment system available RAM stayed at least **16,803,921,920 bytes**; global NVIDIA used memory ranged **1,659–2,104 MiB**.

The old F089 native viewer retained a minimized GPU context during part of this continuation and briefly restored/saved near **14:37:29 UTC** before natural exit. Controlled-fixture generation/preparation also ran on CPU during parts of the medium run. Global GPU/system figures therefore include concurrent contexts and are **not** attributed to Brush or used as the selected adapter's dynamic available budget. The source-bound summary with per-PID timestamps and sample-file hashes is `target/windows-alignment-evidence/medium-resource-summary.json`. Native viewer GPU model replacement, six-round-trip renderer trends and pressure pause/release behavior remain separate from this CLI producer/file-consumer resource measurement.

## Controlled mixed and rotated inputs

The Windows-only [fixture generator](../../scripts/windows/prepare-input-fixtures.py) preserves the fixed 40 CC0 originals and creates four ten-image groups with mixed dimensions, synthetic camera identities A/B and EXIF orientations 1–8. It also creates an eight-orientation repeated-view oracle, constant-color low-texture and pairwise-disjoint crop inputs, corrupt files, an empty folder and unsupported input. Synthetic tags are grouping controls, not claims of independently calibrated physical cameras. The generated manifest SHA-256 is `fa641b0210d11c913bd4d44eaa5a9b976bc301bb7bd92b15cd8dcf8b04aea8f0`.

The [video recipe](../../scripts/windows/prepare-rotated-video.py) stream-copies the captured TUM video into an MP4 carrying a real 90-degree display matrix. FFprobe verifies rotation 90 and duration 20.433333 seconds. Its SHA-256 is `e6091bf4505edbcd1b777ce9832282916598f0bd4417413288ce45201048342b`. This is a controlled metadata derivative of captured footage, not a separate phone capture. The original AVI remains byte-identical. The independent reference decodes an unrotated 5 fps frame and applies Pillow's counterclockwise transform, separately from the product's FFmpeg transpose filter.

The [input tests](../../crates/splat-pipeline/tests/real_windows_inputs.rs) and [independent pixel audit](../../scripts/windows/audit-input-fixtures.py) use predeclared bounds of MAE ≤6, P99 absolute channel error ≤28 and PSNR ≥28 dB. Fresh preparation run `target/windows-input-preparation-02/` passed all eight case expectations: 40 mixed images with four ten-member camera groups, eight EXIF directions, 24 low-texture images, 24 disjoint crops, corrupt-only rejection E-1102, two-good-plus-truncated rejection E-1103, and empty/unsupported-folder rejection E-1102. No failed case published a frame manifest. Both focal-length metadata controls (50 mm and 35 mm equivalent 80) were read by production code. The independent 48-image pixel audit passed with worst MAE **1.10028**, worst P99 **6** and minimum PSNR **43.2148 dB**; all source hashes remained unchanged.

The mixed40 full twelve-stage run also passed at 3,000 steps: **38/40 registered, 8,250 sparse points, mean track 4.641212, mean reprojection error 0.251670 px, and 87,087 final Gaussians**. This meets the predeclared ≥36 registered, ≥1,000 points, track ≥2.5 and error (0,3] px criteria. Its final PLY SHA-256 is `0c63dff50f5cfc0d2bdb0cab247523563444df3eea331ab9a396c9b5a45eb7d5`; evidence is `target/windows-input-mixed-01/Windows 输入 中文 positive-mixed.splat-project/runtime/derived-input-evidence.json`. It does not establish numerical or quality equivalence with historical Mac runs at different settings, and does not close their existing comparison questions.

The rotated captured-video derivative passed the full twelve-stage run at 3,000 steps: **102/102 registered, 8,522 sparse points, mean track 5.590120, mean reprojection error 0.821798 px, and 91,766 final Gaussians**. The actual production probe reports rotation 90; the recorded extraction correction is `transpose=cclock`, and all prepared frames are 480×640. The independent Pillow first-frame audit passes with MAE **1.76103**, P99 **9** and PSNR **40.0149 dB**. Its final scene SHA-256 is `557a3c99e3f0828f5898ee054f02006014c6e40e7b4011031e6c3ecef8106dee`. Evidence and the separate pixel audit are in `target/windows-input-rotated-video-01/Windows 输入 中文 rotated-video.splat-project/runtime/`.

Both actual CUDA SfM negative cases also pass their expected-rejection contracts. The 24 constant-color images produce zero features and E-3010 with texture/readability advice. The 24 source-disjoint crops produce E-3020 with overlap/matching advice. Neither case produces `training/result.json` or `output/scene.ply`; their raw and copied source hashes remain unchanged and their project locks are released. Their evidence lives under `target/windows-input-low-texture-01/` and `target/windows-input-low-overlap-01/`. These are controlled synthetic failure inputs, not claims of independent field captures. Native error-card presentation is a separate UI check.

The first preparation run reached all eight expected behavior checks but its final whole-fixture inventory assertion failed because test setup concurrently added the video/reference files. A retained correction records eight added paths, no removed paths and no changes to existing files. The successful preparation run used the now-frozen fixture and a fresh project root. This scheduling failure is not presented as a product success or product defect.

Pillow 11.3.0 was installed only in ignored test tooling, without application dependency changes. Its CPython 3.13 Windows x64 wheel SHA-256 is `0bce5c4fd0921f99d2e858dc4d4d64193407e1b99478bc5cacecba2311abde51`.

All added controlled-input tests run against production stages and the frozen paired Windows engines. Mixed and rotated positive cases run all twelve stages with 3,000-step training; expected failures stop before training. They do not duplicate the recovery/live matrix already exercised by the photo, real-video and medium cases. Native macOS regression, native viewer/editor/export/exit and clean installation remain governed by their own evidence and [the overall alignment validation](windows-alignment.md).
