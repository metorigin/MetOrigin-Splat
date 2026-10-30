# macOS resource observations and preview backpressure

This implementation adds runtime-only resource data. It does not migrate `project.json` v1, change shared Windows presets, infer a Metal compute result, or change training parameters while training is running.

Current follow-up (2026-10-28): unchanged `a2146f95` / `build.OX71fC` has completed
the subsequent [bounded VM-category diagnostic](#2026-10-28-unchanged-release-vm-category-diagnostic).
All 490 pressure observations are normal and system swap is available. Later
WebContent growth concentrates in WebKit Malloc and Untagged, while WASM and
graphics dirty categories are approximately stable and GPU-service footprint
slightly decreases. Live ownership remains unresolved; **memory stability is
still unaccepted**. This diagnostic does not replace the prior 460-sample run's
unknown pressure/swap observations or constitute a new acceptance pass.
The production [OrbitControls repair and earlier Release result](#2026-10-28-orbitcontrols-root-repair-and-release-observation)
retain their original evidence and scope.
The earlier `0f85289e` mixed-viewer growth and `6a5c7be6` mixed-viewer/Spark-only
retention findings remain open. The sort-disposal fix and shared-resource
mechanism tests do not by themselves establish the cause or resolution of the
native observations. Historical collector evidence does not change production
telemetry or retroactively attribute earlier samples.

## Observations

The earlier bounded diagnosis is recorded below; its production repair and
subsequent Release observation are recorded at the end of this document.

### 2026-10-28 developer census and OrbitControls root mismatch

The [frozen closeout](../../target/macos-m4/native-retention-census-20261028/diagnostic-closeout.json)
binds the complete evidence. An [independent audit](../../target/macos-m4/native-retention-census-20261028/independent-census-resource-review.json)
passed 65 checks, including all per-instance resource statistics and phase windows.

The temporary `478f67f4` debug app used exact, hash-bound response-only hooks in
the production preview and installed Spark source. WeakRefs hold targets; only
explicit UI snapshots dereference them. Seven V8 observer test groups validate
the census mechanism, not JSC collection behavior. Vite, StrictMode and Inspector
make this a diagnostic run rather than Release acceptance. See the
[predeclared protocol](../../target/macos-m4/native-retention-census-20261028/preparation.json)
and [offline analysis](../../target/macos-m4/native-retention-census-20261028/census-offline-analysis.json).

Six Spark/Home pairs at 614,263 Gaussians produced 13 natural checkpoints; final
Home dwell was 183.635 seconds. The persisted census has 1,420 consecutive events
(0–1,419) and 233 server ACKs. Sampled drop/failure counts were zero, but there is
no terminal runtime-drained event proving absence of unsent events at exit. The
first analyzer's quit-label mismatch is preserved; the compatible analysis reports
zero errors/warnings. [Independent visual review](../../target/macos-m4/native-retention-census-20261028/independent-visual-audit.json)
passed all 13 natural captures and separately examined five diagnostic captures.

At natural checkpoint 13, all 12 renderer, Spark, owner, viewer and scene objects,
36 accumulators, six meshes and six input PLY byte arrays were finalized and no
longer dereferenceable. Six controls, six cameras and six canvases remained, one
per real cycle, as did one decoder worker and its wrapper. StrictMode produced
12 viewer generations for six user cycles. The same live IDs remained at separate
checkpoints 14 and 15 before and after one Inspector “Collect garbage” request.
WeakRef liveness alone does not establish a strong root or complete GC.

The [actual-library reproduction](../../target/macos-m4/native-retention-census-20261028/orbit-root-mismatch-repro.json)
uses installed Three 0.185.1 and jsdom 25.0.1 without controls/EventTarget stubs.
Attached disposal removes the Document keydown listener; detaching the host first
leaves the bound listener on Document. A Control key event still updates the
disposed controls, which reference camera and canvas. Fixture-only removal using
the saved registration root clears it. All three expected outcomes passed. This
proves that mechanism, not a WKWebView heap path or its native-memory contribution.
React passive cleanup after host deletion is the source-supported application
candidate. No production repair was installed during this diagnosis. The later
tracked repair, actual-React regression and Release test are recorded below.

The [resource summary](../../target/macos-m4/native-retention-census-20261028/native/resource-summary.json)
preserves all 16 instances by PID/start/UUID/path/coalitions, including separate
Inspector processes. All 855 samples reported normal pressure. WebContent PID
3633 had Home-window footprint medians of 68.66 MiB at baseline, then 201.08,
223.35, 271.10, 267.10, 288.17 and 313.36 MiB. These unweighted descriptive samples
do not collapse by role, sum processes, establish exclusive viewer ownership or
quantify a Release effect. Initial Inspector was closed before the protocol;
later Inspector interaction and GC are separate. Three Tauri listener promise
errors, three worker source-map errors and 12 Three.Clock warnings are retained
as debug-context findings, not automatically transferred to Release.

After normal CUA ⌘Q, the sampler ended with ESRCH/exit 0 and all 16 observed
identities were absent in the [scoped check](../../target/macos-m4/native-retention-census-20261028/native/exit-confirmation.json).
The app OS exit code is unknown. The loopback server ended on SIGINT. The one
after-scan confirms [439 unchanged files / 1,047,169,524 bytes](../../target/macos-m4/native-retention-census-20261028/native/project-integrity.json).
No editor, save, training, induced pressure, context loss, Dock or sleep occurred.
The unusual reported CUA launch delay is retained without inferring its cause.
Historical Release `.app` is absent at its build path; the DMG still matches its
verified hash. The freeze script failed at that final app check after writing
valid resource/exit/integrity receipts; [artifact status](../../target/macos-m4/native-retention-census-20261028/native/release-artifact-status.json)
preserves this boundary. M3 memory, M4 and public release remain unaccepted.

### Production resource policy

`get_resource_metrics` now reports system memory kind, available memory, swap, optional OS pressure, owned process RSS, the persisted execution profile's effective training settings and the current preview policy. On Apple Silicon, system RAM is labelled unified memory. Dedicated GPU memory, GPU utilization and temperature remain `null` when no supported measurement exists; total RAM is never reported as VRAM. Windows retains its NVIDIA measurements and numeric values.

Memory pressure comes from the read-only `kern.memorystatus_vm_pressure_level` system API: 1 normal, 2 warning, 4 critical. Failed or unknown values stay unknown. System totals, used memory and swap use the existing `sysinfo` runtime. macOS headroom uses the supported `host_statistics64` Mach API directly: `(free_count + inactive_count) * page_size`, capped to physical RAM and explicitly labelled as an estimate. Free pages already include speculative pages, and purgeable pages overlap other categories; neither is added again. Compressed pages are reported separately and are not subtracted from free/inactive pages. Failed observations remain unknown. Available memory is an OS observation, not a guarantee that Metal can allocate that amount. The profile's Metal working-set recommendation remains unknown when it was not measured.

The settings panel shows requested preset, actual iterations/SH/resolution, loader threads, image-cache limit, maximum Gaussians and training budget, alongside CPU COLMAP and the measured Metal device. Budgets are explicitly described as policy rather than hard process allocation limits. Summary panels distinguish unified RAM from VRAM and keep unavailable measurements visibly unknown.

Process entries contain only the application and identified Brush, COLMAP or WebKit descendants. Zero/unavailable RSS observations are omitted. Shared pages can occur in several processes, so these values are not summed. macOS WebKit XPC helpers commonly have `launchd` as their parent. A read-only process inventory on the development host confirmed that the native application and several WebKit helper sets all had parent PID 1; proximity of PIDs is not evidence of ownership. The standard `launchctl procinfo` attribution query required root privileges. No privilege elevation to root or speculative grouping was performed. Unattributed WebKit memory remains unknown; this is a residual acceptance limitation.

Startup version/validation queries and NVIDIA status queries use `splat-process::probe_output_sync`: a dedicated thread owns a Tokio runtime, a default ten-second execution deadline and a fixed 64 KiB capture limit. macOS COLMAP `-h` version/validation/discovery queries use a single 45-second execution deadline through `probe_output_sync_with_timeout`; no automatic retry is added. Other engines and non-macOS COLMAP retain the ten-second default. Spawn and existing cleanup grace periods are separate from the execution deadline, so 45 seconds is not a strict total wall-clock guarantee.

The process scope is drained before either synchronous API returns, including capture failures and worker panics; failed cleanup remains in the existing retry registry. Native arguments, added environment variables and the working directory survive the conversion to the shared runner, including COLMAP's portable Windows environment. Seven focused tests cover nested-runtime use, Unicode/environment/cwd and nonzero exit handling, excessive output, a caller-selected 100 ms timeout with descendant writers, fixed 64 KiB capture under a custom deadline, and an exited leader with inherited output pipes. No unit test waits 45 seconds. The macOS process-group cleanup is tested; Windows retains the existing runner's `taskkill` behavior and has no new real-machine acceptance claim or cross-platform hard bound on total cleanup time.

The exception follows a real application-preflight failure under the old ten-second budget. Six serial, 30-second-capped `COLMAP -h` measurements on the same host all exited 0:

| Path | First measured complete launch | Immediate repeat |
| --- | ---: | ---: |
| Active frozen pack | 25.265 s | 0.071 s |
| New physical Chinese/space path 1 | 16.923 s | 0.073 s |
| New physical Chinese/space path 2 | 9.601 s | 0.075 s |

Copied runtime files had distinct inodes and matching hashes; no source engine bytes, OS caches or network settings were changed. These are **same-host first-path measurements**, not cold-host acceptance, and they do not separate dyld, signature checks and other initialization costs. Evidence and cwd/environment limitations are retained in [timings.json](../../target/macos-m4/colmap-startup-timing-20261027.sr9c71c6/timings.json); the [failed application gate](../../target/macos-m4/colmap-startup-timing-20261027.sr9c71c6/failed-application-preflight.log) remains preserved. Process tests passed 57 and COLMAP tests passed 127 after the deadline change, with Clippy passing.

## Preview policy

Windows keeps its existing 500 ms polling behavior. On macOS the normal preview interval starts at 2 s for physical RAM of at least 32 GiB, 5 s at 16 GiB, and 10 s below that or when physical memory is unknown. Unknown pressure never becomes “normal”; it uses at least a 5 s cadence.

A warning pressure level or available memory below the larger of 1 GiB and 10% of physical RAM pauses requests for new live frames. Critical pressure or at most 512 MiB available memory releases the currently displayed model. The producer receives `mode: off`; training continues with the same algorithm parameters and checkpoint files. After recovery, the retained disk frame can be loaded again without claiming optimizer recovery.

The response-buffer policy allows at most `min(1 GiB, (available - 512 MiB) / 6)` of PLY bytes, or 64 MiB when availability is unknown. The factor reserves headroom for decoding, old/new meshes and uploads. It is a conservative engineering estimate, not a measured GPU or RSS limit. The IPC checks the policy before allocating its one response buffer. A model above this bound is deferred whole, never silently sampled.

A separate lightweight pressure command runs independently of serialized frame loading. Pressure changes invalidate the current loading epoch. Both the byte-read and mesh-initialization await points recheck the epoch before installation or ACK. A model fetched before critical pressure therefore cannot reappear after the displayed model has been released. Stopping training selects the completed checkpoint/output when available rather than indefinitely preserving an older acknowledged live frame.

## Validation and current-host evidence

Automated coverage includes unknown metrics, 16/32 GiB policy thresholds, Windows behavior, warning/critical request suppression, preserved recovery files, restoration after pressure subsides, finite PLY byte checks, no ACK for an invalidated in-flight read or mesh initialization, and final-checkpoint fallback. Frontend tests also verify that an unknown GPU utilization is not rendered as zero and that requested versus effective settings are distinct.

Protocol and PLY-response tests inject deterministic resource observations so concurrent work on the test machine cannot invalidate their assumptions. Production IPC samples the actual policy immediately before allocating its response buffer. Separate tests exercise both warning/critical rejection and the snapshot byte cap without modifying the model on disk.

The ignored Rust test `records_real_host_resource_observations` writes fresh evidence only, never overwriting an earlier run. It accepts `METORIGIN_RESOURCE_EVIDENCE`, optionally `METORIGIN_RESOURCE_PROJECT`, and optionally a currently verified `METORIGIN_RESOURCE_APP_PID`. Without the last parameter its process entry describes the test collector itself, not the native GUI application.

For longer native sessions, `scripts/macos/sample-native-resources.py` writes a fresh JSONL stream every five seconds. Supply a currently verified `--pid`, its exact `ps` executable path as `--binary`, and an ignored `--output` path. It defaults to a ten-minute maximum; `--stop-file` allows early termination. Each sample rechecks the root executable and includes only identified descendants. It records OS pressure, raw swap observations and `vm_stat` without inventing a GPU-memory or available-memory calculation. A process that starts and exits between samples may be missed, so observed peaks are lower bounds on actual peaks.

Three observations in `target/macos-m3/resources/current-host-01.json` on 2026-10-27 recorded Apple M1 Pro, macOS 27.0.1, 34,359,738,368 physical bytes (32 GiB), normal system pressure and zero swap. The original sysinfo-based available-memory estimate ranged from 4,081,827,840 to 4,138,909,696 bytes; that historical estimator was subsequently found unsuitable and replaced as described below. The collector's own RSS ranged from 18,317,312 to 21,807,104 bytes. The policy allowed a 2 s preview cadence. The persisted public-fixture profile correctly reported CPU COLMAP, Metal/Apple M1 Pro, 300 iterations, SH0, 960 px, four loader threads, 256 MiB image cache and 300,000 maximum splats, while keeping the Metal working-set recommendation unknown.

### Native run observations and headroom correction

Three read-only segments in `target/macos-m3/resources/native-session-01.jsonl` through `native-session-03.jsonl` contain 210 samples between 04:05:49 and 04:24:02 UTC on 2026-10-27. The sampler was stopped after the native 40-photo run completed. Segment boundaries, gaps, hashes, per-PID observations and offline calculations are bound in `native-session-summary.json`. Sampling used the verified native application PID 53883 and descendant relationships. Other development activities were present on this host; global pressure and swap cannot be attributed solely to training.

| Observed process | Maximum sampled RSS |
| --- | ---: |
| Application | 418,660,352 bytes |
| COLMAP | 7,841,660,928 bytes |
| Brush | 396,935,168 bytes |

These are separate per-process lower bounds on peak RSS, not a sum, Metal allocations or physical footprints. WebKit XPC ownership remains unknown. Kernel pressure was normal in 195 samples and warning in 15; no critical sample was observed. Swap changed from zero to 231.56 MiB used out of 1 GiB allocated.

The run exposed a measurement defect: `sysinfo` 0.33.1's Apple estimator subtracts compressor pages from `free + inactive + purgeable`, saturating at zero. At 04:23:16 UTC, kernel pressure was normal, page size was 16,384 bytes, and free/inactive/purgeable/compressed counts were 163,558 / 486,543 / 17,079 / 695,555. Its formula reported zero despite 10,651,254,784 bytes of free-plus-inactive pages. This caused the native preview to remain released after training; waking the poll loop alone could not recover it.

The replacement reads Mach page counters directly and reports both the estimate and its source, free, inactive and compressed byte counts. It does not claim that all inactive pages can be immediately allocated by Metal. The same 512 MiB release, 10%-or-1-GiB pause, warning and critical thresholds remain intact. Applying the old formula to the saved samples yields 200 release / 9 pause / 1 allow outcomes; the corrected estimate yields 195 allow / 15 pause, with all 15 warnings still pausing. This is an offline comparison of saved observations, not a claim that the earlier native binary contained the fix. Regression tests preserve the concrete sample and both pressure overrides.

The same-host rebuilt native application subsequently displayed the completed 155,469-Gaussian model. `target/macos-m3/native-ui/headroom-fixed-final.png` records the rendered scene and count, replacing the earlier stuck release state. This confirms the completed-model display after the headroom correction; it does not prove a full warning/critical/recovery cycle or attach the older 210-sample resource series to the newer binary. Native build identity and live/pause/resume/quit sequences belong to the separate [native UI ledger](macos-native-ui.md). All three resource samplers have stopped, so later native activity is not silently included in their measurements.

The last resource-specific Rust run passed five tests with one explicit host-observation test ignored. The complete frontend run passed 32 files / 172 tests, with lint, typecheck and production build passing at that revision; only the existing large-chunk build warning remained. These are historical verification results, not assertions that later lifecycle changes have already passed the final quality gate.

### 311-photo room workload and native run

On 2026-10-27, the single `room` scene from [Mip-NeRF 360](https://jonbarron.info/mipnerf360/) was prepared and then used in the native 32 GiB run described below. The [fixed metadata-only fixture manifest](../../packaging/macos-arm64/fixtures/mipnerf360-room-311.json) lists every selected filename, source ZIP offset, byte count, dimensions, CRC32 and SHA-256. Its SHA-256 is `36aace9c15841c019ebeab78d089641069086228a6dd30b5d0ec4208c19be298`. Source photographs remain under ignored `target/macos-m3/datasets/mipnerf360-room-311/images/`; no photographs are committed or bundled into the application.

| Prepared input | Images | Original dataset JPEG bytes | Scope |
| --- | ---: | ---: | --- |
| James40 smoke subset | 40 | 116,721,061 | Approximately 0.1 m volcanic-bomb object |
| Mip-NeRF 360 room | 311 | 971,803,336 | One furnished living room; exact metric dimensions unmeasured |

The new selection is all 311 original `room/images/DSCF4667.JPG` through `DSCF4977.JPG` files, each 3114 × 2075 pixels. It meets the planned 300–600-photo input count. No other scenes, copies, synthetic frames or `images_2`/`images_4`/`images_8` resolution variants are mixed in. Each dataset JPEG payload and filename is unchanged. All 311 decompressed sizes and ZIP CRC32 values passed, and all 311 SHA-256 values are distinct. The supplied `poses_bounds.npy` contains 311 distinct camera matrices and centers, also distinct after rounding centers to six decimals. These are source pose observations, not a new registration result or a proof of complete perceptual deduplication. First/middle/last image spot checks confirmed the room setting and differing viewpoints.

The original archive is 12,535,427,936 bytes, with Google object generation `1648484397541962` and provider ETag/MD5 `cef2ef3aeaf0c062dbe65130bc249870`. Only the contiguous original-image range of 969,312,588 bytes and a 29,956-byte pose/camera metadata range were downloaded. HTTP 206, exact Content-Range, object generation and ETag were checked before extraction. The complete archive was not downloaded, so its provider MD5 is not presented as a locally recomputed whole-archive hash. Selected byte-range SHA-256 values are recorded in the public manifest.

The authors' [official SMERF page](https://smerf-3d.github.io/) explicitly licenses the datasets and checkpoints under **CC BY 4.0** in its “Datasets & Teacher Checkpoints” section. The following table separately identifies Mip-NeRF 360 in the Photos column and links directly to the original project above. This first-party statement covers the linked photograph dataset; the code repository's license is not used as a substitute. The captured HTML SHA-256 is `3f026e8d05649856ed520039c38c8f53351e76c8536e5cb03f97289c12f9037f`. Credit Jonathan T. Barron, Ben Mildenhall, Dor Verbin, Pratul P. Srinivasan and Peter Hedman; link the [source project](https://jonbarron.info/mipnerf360/) and [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/), and identify this room-only selection. The full license text, captured grant page and attribution record are retained with the ignored source evidence. No image resizing or recompression occurred during preparation.

The frozen local preparation manifest SHA-256 is `6c77217795814486c2a0cca62c04b4fb9208190ac3d433c3807b3d793d012bdc`; it includes additional local acquisition evidence, so it intentionally differs from the public fixture metadata hash above. Supplied camera/pose files remain in `source-evidence/`, outside the selected image folder, to avoid bypassing the application's SfM stages. Preparing or verifying this dataset did not launch the application, SfM, Brush or GPU work.

#### Completed pipeline and retained sources

The native run completed on 2026-10-27 at 08:32:35 UTC on Apple M1 Pro, macOS 27.0.1 and 32 GiB unified memory. The release executable SHA-256 was `8656d4e02678cd6d2f30fb92a2c19a26a5ef38ada8af93cb3f93b9b0bb9d03a3`, with embedded Brush `1.0.0+metorigin-macos.6` (`f8fb8784d394e224f9057243bbb6e1f33039ea34063ec8fa91c339853c144e1c`). The native wizard created project `01a17c42-0cbd-75b0-bb61-6d041b54bfe9` on an owned case-sensitive APFS sparse image. Both application and project paths included Chinese, spaces and emoji. This tests a simulated case-sensitive volume, not an external physical disk. Earlier integrity/version preflight failures remain separate evidence segments `01`/`02` and are excluded from the completed run.

The persisted profile confirms `balanced`, 7,000 iterations, SH1, 1920 px, a 1 GiB image cache, a 1,500,000-splat ceiling, six loader threads, LOD0 and a 16 GiB training policy budget. COLMAP feature extraction, matching, global positioning and Ceres bundle adjustment used CPU; the real compute probe and Brush runtime identified Metal on Apple M1 Pro. The budget is not a measured allocation ceiling. Requested COLMAP long edge was 4096 px. The initial profile and all engine hashes are preserved in [project provenance](../../target/macos-m4/release-311-balanced/project-03-provenance.json) and the [final audit](../../target/macos-m4/release-311-balanced/final-result.json).

| Pipeline result | Observed value |
| --- | --- |
| Imported / registered source photographs | 311 / 311 |
| Selected SfM attempt | `images-exhaustive-global`, first candidate; no fallback |
| Sparse points / observations | 136,436 / 1,257,911 |
| Mean reprojection error / mean track length | 0.679604 px / 9.219788 |
| Final checkpoint and exported scene | 7,000 iterations; 737,307 Gaussians; SH1; 67,832,961 bytes |
| Final PLY SHA-256 | `3d96938cbe61664ba8c0b76d11b633599194357b86aed60fa25a0bfb42c210e2` |

Native CmdQ during training left the project paused and retained checkpoint 1000, with 203,422 Gaussians and 18,715,541 bytes. The operator's first poll with both application and Brush absent occurred 0.50038 s after the quit request; this is an observed polling latency, not a universal exit bound. Reopening the same release application and choosing Continue loaded `init.ply`, first logged refinement at iteration 1001, and produced later checkpoints through 7000. This is **PLY warm start with optimizer reset**, not complete optimizer-state recovery. The final independent audit confirmed validated output, equality between checkpoint 7000 and exported scene hashes, preserved output equality, completed pipeline stages and no project lock. Brush's resumed-run result records 1,381.894 s; it excludes initial training before CmdQ and all SfM time.

After training, final audit and resource sampling had stopped, a read-only SHA-256 check at 08:35:54–08:35:56 UTC verified both the 311 fixture originals and the 311 imported project `source/` originals against the fixed manifest. Each set retained all names, exactly 971,803,336 bytes, 311 unique matching hashes and no extra files. No image decoding, copying or reencoding was used for this final check. [Source-preservation evidence](../../target/macos-m4/release-311-balanced/final-source-preservation.json) records every file. Application-generated processed/training images are separate from these retained originals.

#### Resources and preview behavior

[Segment 03](../../target/macos-m4/release-311-balanced/resources-03-summary.json) covers initial import, CPU SfM, initial Brush training and CmdQ; [segment 04](../../target/macos-m4/release-311-balanced/resources-04-summary.json) covers native reopening, warm start and completion. Both collectors and observers exited successfully after their explicit stop files. The [combined summary](../../target/macos-m4/release-311-balanced/resources-03-04-summary.json) retains separate process identities and an unsampled reopening gap of 104.895 s.

| Resource segment | Duration / samples | Normal / warning / critical | Global swap, first → last; peak |
| --- | --- | --- | --- |
| 03, through CmdQ | 2,622.324 s / 516 | 483 / 33 / 0 | 231.56 → 2,508.75 MiB; 4,356.75 MiB |
| 04, resumed run | 1,463.997 s / 289 | 188 / 101 / 0 | 2,500.75 → 2,364.75 MiB; 2,500.75 MiB |
| Both observed segments | 4,086.321 s / 805 | 671 / 134 / 0 | 231.56 → 2,364.75 MiB; 4,356.75 MiB |

The first 231.56 MiB of swap predates this run. The complete scan found the global swap peak at 07:28:50 UTC during feature extraction; it supersedes lower peaks reported during live monitoring. All 33 segment-03 warnings occurred in feature extraction, and all 101 segment-04 warnings occurred during resumed Brush training. Source verification briefly read the imported originals at 07:30:16–07:30:18 UTC; the first feature-extraction warning preceded that read. Final source verification occurred after sampling stopped and is not included in the resource series.

| Process or engine phase | Maximum sampled RSS, separately |
| --- | ---: |
| Native application, segment 03 / 04 | 240,467,968 / 298,123,264 bytes |
| COLMAP feature extraction | 11,557,191,680 bytes |
| COLMAP matching | 905,068,544 bytes |
| COLMAP mapping | 3,118,678,016 bytes |
| COLMAP undistortion | 466,124,800 bytes |
| Brush, initial / resumed | 2,035,875,840 / 2,766,618,624 bytes |

Five-second samples are lower bounds on peaks. RSS can contain shared pages and must not be summed. Global pressure and swap include other host activity and are not exclusive application consumption. Of 805 samples, 789 verified the application identity; the 16 after CmdQ were unattributed, not a zero-RSS application. WebKit XPC ownership and Metal/GPU allocations remain unknown. The native CPU percentage display was unreliable during this run and is not accepted as CPU-utilization evidence.

Observed phase intervals were approximately 340.5 s for feature extraction, 933.8 s for matching, 294.2 s for mapping plus validation, 460.7 s for training preparation, 176.9 s for initial training through CmdQ and 1,398.4 s for the resumed training stage including its finalization. Training preparation includes serial JPEG reencoding after undistortion. These intervals and the 4,191.225 s span from first sampler start to last sampler stop are current-host observations, not an uninterrupted engine benchmark or a performance comparison with James40.

During resumed training, warning intervals began at 08:17:43, 08:23:32 and 08:31:28 UTC and returned to normal after approximately 329.1, 131.6 and 50.7 s. The operator captured native warning/normal state, and actual new frames rendered after recovery, including iterations 5719 and 5790; producer logs also resumed publishing frames. No critical sample or forced critical-release cycle occurred. This supports observed warning pause/recovery behavior without proving GPU allocation release.

**Completed output and final display are separate outcomes.** The first completed native screenshot at 08:33:08 UTC retained the older acknowledged live frame at iteration 6094 / 703,793 Gaussians while already labelling it as a static render. Without a button or project-switch action, the final 737,307-Gaussian scene subsequently loaded; a fresh AX observation at 08:35:23 showed the final count and no iteration badge, with a displayed update time of 08:34:37. The final screenshot confirms the model. The remaining issue is the misleading label while the final model is loading, not permanent failure to replace it. No cause is assigned to the loading duration without further evidence. The [native UI ledger](macos-native-ui.md) and `final-native-render.json` retain both observations and their identity; a label fix still needs its own build and retest.

### bb13 native engineering-video resource session

A separate native session on 2026-10-27 used application SHA-256 `bb13a6ee182b825216b05e7f98fe121f33a3fc319e34e2b3ef25d7e275300ded`, application PID 47493 and project `01a17cc0-8c53-7f21-a1bd-0037943b04b7` on the same 32 GiB M1 Pro/macOS 27.0.1 host. This identity is separate from the earlier 311-photo run. The input was the fixed 20-second, 40-frame James40 engineering video encoded from photographs; it is not real-shot video or the planned 100–200-frame video workload. The persisted fast profile used 3,000 iterations, SH0, 1280 px, six loader threads, a 1 GiB image cache, a 1,500,000-splat ceiling and a 16 GiB policy budget. The [independent final audit](../../target/macos-m4/final-native-video-readonlyfix-20261027/final-result.json) records 40/40 registration, 81,368 Gaussians, a 4,557,109-byte final PLY, matching checkpoint/output hashes and unchanged source-video content.

The [new resource summary](../../target/macos-m4/final-native-video-readonlyfix-20261027/resources-01-summary.json) binds the immutable JSONL, stage observations and final audit by file hash. Sampling ran from 09:37:35.502 to 09:52:48.377 UTC, then stopped by explicit stop file; the operator confirmed sampler exit 0 and observer completion. All 180 samples verified the application identity and reported normal pressure: zero warning and zero critical. The full session includes preflight and destination checks, generation, and completed-model viewing/audit. Its duration is not training time. The five component rows below partition that session.

| Observed window | Duration | Samples | Global swap, first → last sampled value |
| --- | ---: | ---: | --- |
| Whole session | 912.876 s | 180 | 1,908.44 → 1,884.44 MiB |
| Before project creation: preflight and destination checks | 500.549 s | 99 | 1,908.44 → 1,900.44 MiB |
| Project creation through start of Brush stage | 44.653 s | 9 | 1,900.44 → 1,900.44 MiB |
| Brush training stage | 132.817 s | 26 | 1,900.44 → 1,884.44 MiB |
| Post-training validation, export and preview completion | 0.171 s | 0 | Not sampled |
| Completed-model viewing/audit through sampler stop | 234.685 s | 46 | 1,884.44 → 1,884.44 MiB |

The Brush stage boundaries were 09:46:40.703974–09:48:53.520968 UTC, taken from the persisted start in the observer record and end in the final audit. Its 132.817 s includes stage orchestration; `training.duration_ms=130155` measures the narrower Brush process segment. Project creation through completed state took 177.641 s and contained 35 samples. Neither time includes the preceding native preflight interaction. The brief finalization interval fell between resource samples, so it has no measured pressure or RSS value rather than a zero-use result.

| Identified process | Maximum sampled RSS | Samples containing that process |
| --- | ---: | ---: |
| Application PID 47493 | 178,749,440 bytes | 180 |
| COLMAP PID 48524, during feature extraction | 1,175,502,848 bytes | 1 |
| COLMAP PID 48536, during mapping | 225,656,832 bytes | 5 |
| Brush PID 48598 | 359,825,408 bytes | 26 |

Application and Brush sampled RSS peaks occurred during the training window at 09:48:45.102 UTC. The five-second sampler did not observe owned matching or undistortion processes; their peak consumption is unknown. Short FFmpeg or compute-probe processes may also fall between samples. These per-process RSS values can share pages, must not be summed into unified-memory consumption and are lower bounds on peaks. The 1,908.44 MiB baseline swap already existed when sampling began; the 24 MiB session decrease is a global host observation, not memory attributed to or released by the application. WebKit XPC ownership and Metal/GPU allocations remain unknown, and this collector does not establish CPU-utilization correctness.

This short, all-normal video session adds no warning/critical recovery evidence and does not replace the larger 311-photo resource run. Its case-sensitive APFS sparse image remains simulated storage, not a physical external drive. The series does not establish real-shot video, native offline UI, 16 GiB, minimum-OS, clean-host or Windows acceptance. Subsequent editing, restoration and UI checks retain their own evidence and are not inferred from these resource samples.

### Remaining current-host acceptance scope

The M1 Pro / 32 GiB host can additionally validate project/window switching and manual sleep/wake followed by state/checkpoint reconciliation; the run above already supplies native repeated-frame, warning-recovery and CmdQ evidence. A controlled sleep test must retain the last complete checkpoint and capture pre/post run ownership, engine processes, durable project state and live-session state; successful idle-sleep assertion creation is a different check. No resource test above forced sleep, induced OOM, or simulated a Metal device loss. Manual sleep and lid closure are not blocked by the optional idle-sleep setting.

The 311-photo room run above completed the native 32 GiB reconstruction/training/export path and eventual final display, with retained-source verification, CmdQ/warm-start evidence and observed warning recovery. It does not close the final-loading label issue or the remaining lifecycle tests. The 40-photo run remains smoke evidence and does not substitute for this workload. The current host cannot establish a 16 GiB result, macOS 15 compatibility or a clean-machine installation result by lowering application budgets, checking deployment metadata, clearing PATH or using a fresh HOME. Those checks remain separately labelled and open.

These observations and deterministic tests do not establish a 16 GiB real-machine acceptance result, complete application/Brush/COLMAP/WebKit or Metal peak memory, actual OOM behavior, or complete M3 acceptance. The remaining 32 GiB UI/lifecycle criteria and the separate sustained 16 GiB run remain open.

### cfba real-video continuation after rotation correction

The closed 2026-10-27 session used release executable SHA-256 `cfba918efdb73a09e48a905dde03b465e14e82f73041850aa49a9a7ac60863af`, native PID 65724, on the same Apple M1 Pro / macOS 27.0.1 / 32 GiB development host. [Run summary](../../target/macos-m4/native-rotation-recovered-20261027/run-summary.json) and [resource summary](../../target/macos-m4/native-rotation-recovered-20261027/resource-summary.json) bind the raw JSONL, launch/exit records, frozen event copy, screenshots and independent data audit by hash. This is a continuation of paused project `01a17d05-dae3-7662-bd32-eb7c18c51d72`, run `01a17d1c-3265-7d61-8ae4-dccdaeaea702`. MediaValidation retained its earlier completion; FrameExtraction and the following ten stages ran again. It was not a new project run or a repeat of the earlier failed candidate's resource segment.

The real Objectron video produced 119 corrected 1440×1920 frames at the explicitly selected 5 fps. All 119 registered; training consumed 959×1280 undistorted images and produced 651,384 SH0 Gaussians at iteration 3000. The effective settings were six loader threads, a 1 GiB image cache, a 1,500,000-splat ceiling and a 16 GiB policy budget. These are policy settings on a 32 GiB machine, not a measured allocation ceiling or a 16 GiB machine test. The original video and frozen faulty project remained unchanged, and the final checkpoint/output SHA-256 agreed. The [native ledger](macos-native-ui.md) records the full data and UI scope.

The resource collector requested a two-second interval. Its 470 samples cover 11:25:34.415285–11:41:44.346871 UTC, a sample span of 969.931586 s; the end record is 11:41:46.354734, elapsed 971.988 s, reason `stop_file`. There were 322 normal, 148 warning, zero critical and zero unknown pressure samples. Application identity matched in 446 samples. The final 24 samples did not match: the first occurred just before process exit while `ps` no longer returned the exact executable path, and 23 were after exit. They are unobserved application RSS, not zero-memory measurements.

All 470 system swap readings were identical: 1,668.44 MiB used out of 3,072 MiB allocated. This swap was already present at the first sample and cannot be attributed to this run. Warning began in the sample at 11:34:34.963154 and normal returned at 11:39:40.406999; 68 warning samples fell within BrushTraining and 80 after pipeline completion. No critical sample or forced critical-release cycle was observed.

The table groups samples by this continuation's timestamped `stage_started` / `stage_completed` events. RSS columns are separate per-process maxima; they must not be added.

| Phase | Samples | Native app peak RSS, bytes | Separate engine peak RSS, bytes |
| --- | ---: | ---: | ---: |
| Before Continue | 14 | 128,565,248 | Brush probe PID 65930: 10,715,136 |
| FrameExtraction | 1 | 129,482,752 | FFmpeg RSS not collected |
| ColmapFeatureExtraction | 32 | 129,875,968 | COLMAP PID 65975: 4,987,142,144 |
| ColmapMatching | 17 | 108,822,528 | COLMAP PID 66275: 970,932,224 |
| ColmapMapping | 47 | 113,557,504 | COLMAP PID 66433: 1,748,697,088 |
| TrainingPreparation | 51 | 122,372,096 | COLMAP undistorter PID 66813: 250,085,376 |
| BrushTraining | 167 | 228,442,112 | Brush PID 67229: 1,495,023,616 |
| Completed viewing and audit, before exit | 118 | 146,259,968 | No engine RSS sample |
| After native exit | 23 | Unobserved | Unobserved |

ImagePreprocessing, ColmapValidation, ModelValidation, Export and PreviewGeneration completed but each had zero resource samples; this does not mean their resource consumption was zero. The complete per-stage and per-PID records remain in the summary. The sampler intentionally identifies the app, Brush, COLMAP and attributable WebKit descendants; it does not collect FFmpeg RSS. Brief processes can also fall between samples. Shared pages, unattributed WebKit XPC, GPU/Metal allocations and physical footprint prevent interpreting these values as total application memory.

Observed stage-event durations were 2.344 s for extraction, 67.308 s for feature extraction, 35.272 s for matching, 96.390 s for mapping, 105.195 s for training preparation and 343.570 s for BrushTraining. The Brush result's 339.974 s process duration has a narrower scope than the stage. FrameExtraction start to pipeline completion was 651.332 s. The longer resource session includes pre-continuation checks, final viewing, independent audit and post-exit samples; it is not training duration or an isolated performance benchmark. The independent audit's lightweight Python/three-frame FFmpeg work at 11:39:38.571174–11:39:53.363103 was outside native descendant RSS scope but could affect system observations, as could other concurrent host activity.

`training-live.*` captured 751 steps / 165,492 Gaussians. `final-native.*` captured the completed pipeline while the viewer retained 2,133 steps / 461,130 Gaussians with an explicit pressure-pause label. Without clicking or switching projects, `final-autorecovered.png` later showed the final 651,384-Gaussian model, no iteration badge and a displayed model update time of 19:39:41 local, immediately after the first sampled return to normal. This is observed automatic recovery, not a stuck-preview defect. The saved AX file is a diff and does not itself repeat the final count; the screenshot and operator's no-interaction observation supply that evidence. Broken frame thumbnails observed earlier in this session remain a separate limitation; correct decoded disk frames do not prove native thumbnail display.

The app was launched directly under process-scoped `sandbox-exec` network denial, with no system network change. Four loopback positive/negative controls passed; 892 process samples recorded 1,420 owned observations across eight identities, all with generic inbound/outbound `sandbox_check=(1,1)`. Eleven other WebKit XPC identities remained unattributed and are excluded from ownership, RSS and isolation claims. These observations do not establish Finder-plus-offline acceptance, brokered XPC isolation or system-wide offline operation.

Normal native CmdQ at 11:40:57 UTC returned exit 0 at 11:40:57.427840 with `remaining_known=[]`. Root confirmed sampler session 7852 and stage observer 80205 exited 0; the sampler's own end record independently confirms the explicit stop file. This closes collection for this candidate. It does not close clean-host, macOS 15, real 16 GiB, Windows, complete peak-memory or broader M3/M4 acceptance.

### 4e76 fresh Objectron119 completion, 2026-10-27

This section covers only the first fresh run of project `01a17d49-2341-7603-a9d0-a24a6655fb8b`, native PID 79115, using application SHA-256 `4e763b5864705fd0c91fa5a63a547cb4119552e4a6c9a6113f017ba40a17ef3d`. The explicit package receipt and native launch match. The [frozen audit](../../target/macos-m4/native-abnormal-recovery-20261027/fresh-completed-audit/audit-summary.json), SHA-256 `7f6dd5a1035ba69ef859466c1b51e1ffa8abd7d15ce68bf81dd0e5c841da3903`, binds `resources-initial.jsonl`, `stages.jsonl` and the completed project's events. All 419 frozen files remained unchanged. Subsequent checkpoint restoration and abnormal-recovery work are separate and are not included in these measurements.

The project was created with all twelve stages pending. Before execution, with the app closed, `frame_fps` was explicitly changed from null to 5 and `max_frames` from 300 to 150; all other settings remained unchanged. The 23.796667-second Objectron MOV yielded 119 upright 1440×1920 frames and 119 registered views. Training used 959×1280 undistorted images, 3,000 steps, SH0, six threads, a 1 GiB image cache and a 1,500,000-splat ceiling. The machine had 32 GiB physical memory; the 16 GiB policy budget was not a measured allocation limit or a 16 GiB-machine test.

The two-second collector contains 334 samples from 12:18:39.171128 through 12:30:06.194970 UTC. Its end record at 12:30:08.205981 reports 689.081 seconds and `stop_file`. All 334 samples verified the application identity. Pressure was normal in 291 samples and warning in 43, with no critical or unknown sample. Warning first appeared at 12:28:39.581359 and persisted through the last sample: two warning samples were within BrushTraining and 41 were after pipeline completion. No return to normal or critical-release cycle was captured.

| Identified process | Maximum sampled individual RSS | Peak time UTC | Stage at peak | Process observations |
| --- | ---: | --- | --- | ---: |
| Application PID 79115 | 293,519,360 bytes | 12:28:21.027670 | BrushTraining | 334 |
| COLMAP, peak PID 79820 | 5,003,231,232 bytes | 12:19:59.863104 | ColmapFeatureExtraction | 107 across five PIDs |
| Brush PID 81140 | 1,815,445,504 bytes | 12:28:37.517027 | BrushTraining | 132 |

These RSS maxima are independent per-process observations and must not be summed. Shared pages, unattributed WebKit/XPC services and unmeasured GPU/Metal allocations prevent treating them as total application memory. The sampling interval can miss short processes and transient peaks. System swap used was 1,620.44 MiB in every sample, including the initial baseline; it is a host-wide observation, not memory allocated by this run. CPU utilization, temperature and GPU memory are absent from this collector, so no conclusions about those metrics are drawn.

The 89 stage snapshots span 12:18:40.243013–12:28:43.076725 UTC: one ready snapshot with all stages pending, 87 running and one completed. The frozen event log independently records one start and completion for each of the twelve stages. Actual `pipeline_completed` time is **12:28:42.153266 UTC**, with project `updated_at=12:28:42.153509Z`; 12:28:53 was a later operator observation, not the completion timestamp. MediaValidation start to pipeline completion took 585.656492 seconds. Recorded durations were 1.996 seconds for frame extraction, 62.181 for feature extraction, 33.252 for matching, 108.102 for mapping, 104.714 for training preparation and 274.186 for BrushTraining. The Brush result's 270.615-second duration covers the narrower engine-process segment. The longer resource session includes time before and after the pipeline and is not an isolated performance benchmark.

The completed snapshot contains a valid 647,529-splat SH0 final model and six valid checkpoints; its final checkpoint and output hashes agree. `current-1229.jpg`, however, retains the 2,961-step live frame under a pressure-pause warning. This session does not prove installation of the final static model in the native viewer or automatic final-preview recovery after pressure falls. The earlier cfba automatic-recovery observation is not transferred to this run. The lightweight frozen-data audit ran later at 12:36:19.835091–12:36:45.374420 UTC, after this resource collector stopped, and therefore is outside this sampling window.

The attempted controlled capture at 12:28:29 failed to read argv and recorded no process signal request or project modification. These measurements describe normal fresh completion, not successful abnormal termination/recovery. Root reported both collectors exited 0; the resource log independently records its stop-file end, while the stage JSONL ends at completed state. The exact app was launched directly under process-scoped network denial, but this resource audit adds no OS-wide, brokered-XPC or Finder-plus-offline claim. Final native preview, later recovery work, full memory accounting and external-host acceptance retain their separate evidence boundaries.

### 4e76 native controlled mixed40, 2026-10-27

This observation binds only application SHA-256 `4e763b5864705fd0c91fa5a63a547cb4119552e4a6c9a6113f017ba40a17ef3d`, native PID 85772, project `01a17d7e-fe9f-7fd0-a127-a28681b353f7` and run `01a17d7f-0b0f-7de0-9e51-b6f02d919ca5`. It ran on the same Apple M1 Pro / macOS 27.0.1 / 32 GiB host. The 40 same-scene images form four controlled groups using synthetic EXIF identities and mixed dimensions; they are not a real multicamera acquisition. Native selection used byte-identical flat staging copies while preserving the four-directory fixture. This does not certify selecting a root containing only subdirectories. The [native ledger](macos-native-ui.md) records the input, complete pipeline and final-viewer evidence.

Fast settings were 3,000 iterations, SH0, training long edge 1280, six threads, 1 GiB image cache, 1,500,000 maximum splats and a 16 GiB policy budget. Actual reconstruction dimensions were at most 1536, below the configured 2560 limit. Four undistorted camera groups measured 1280×851, 1205×800, 1280×850 and 1157×768. All 40 views registered and trained from iteration 0; the final model contains 121,334 Gaussians. The policy budget is not a measured allocation ceiling or a 16 GiB-machine result.

The [resource summary](../../target/macos-m4/native-mixed-input-20261027/independent-audit/resource-summary-after-exit.json), SHA-256 `9b78367be7c7ecf1bdcf6d721ef1e5729d4564f9c2293e2fcdfaa45cc9bde610`, binds the raw collector and timestamped project events. The requested interval was two seconds. Its 155 samples span 13:13:31.669463–13:18:48.715325 UTC, or 317.045862 seconds; the explicit stop-file end is 13:18:50.727986, elapsed 319.101 seconds. Every sample verified the exact app identity. All 155 pressure samples were normal, with no warning, critical or unknown value. All system swap readings were identical at 1,612.44 MiB used out of 3,072 MiB allocated. That swap was already present at baseline and cannot be attributed to this run. No warning/critical preview-release or recovery cycle was exercised in this window.

The table separates process maxima and groups samples by actual stage events. RSS values must not be added.

| Phase | Samples | Native app peak RSS, bytes | Separate engine peak RSS, bytes |
| --- | ---: | ---: | ---: |
| Before pipeline | 14 | 154,976,256 | No engine RSS sample |
| FrameExtraction | 1 | 178,421,760 | No engine RSS sample |
| ColmapFeatureExtraction | 5 | 186,204,160 | COLMAP PID 87886: 3,655,827,456 |
| ColmapMatching | 4 | 176,324,608 | COLMAP PID 87924: 316,145,664 |
| ColmapMapping | 11 | 177,078,272 | COLMAP PID 88005: 350,830,592 |
| TrainingPreparation | 9 | 168,706,048 | COLMAP PID 88097: 150,814,720 |
| BrushTraining | 89 | 176,226,304 | Brush PID 88198: 475,660,288 |
| Completed viewing | 22 | 164,429,824 | No engine RSS sample |

The application peak occurred at 13:14:02.617954, the COLMAP peak at 13:14:10.960490 and the Brush peak at 13:17:53.058032 UTC. There were 155 app, 21 COLMAP and 88 Brush process observations. MediaValidation, ImagePreprocessing, ColmapValidation, ModelValidation, Export and PreviewGeneration completed but had no sample within their short event intervals; this does not imply zero consumption. Shared pages, unattributed WebKit/XPC and unmeasured Metal allocations prevent interpreting these measurements as total application memory. FFmpeg RSS is outside the collector's role selection. Short processes and transient peaks may fall between samples; CPU utilization, temperature and GPU memory are not collected.

The twelve fresh stages completed in a 243.318288-second event span, from 13:14:00.352309 to 13:18:03.670597 UTC. Project creation to the final persisted update was 246.518923 seconds. Feature extraction took 9.780704 seconds, matching 8.611907, mapping 22.136478, training preparation 18.915368 and BrushTraining 182.085403. The Brush result's 179.486-second duration covers the narrower engine-process segment. Resource collection includes pre-pipeline and final-viewing time, and is not an isolated performance benchmark. It ended before the independent data audit and subsequent native negative-case work; those later activities are not part of these RSS observations. Other concurrent host activity may affect system-wide measurements.

Native live frames advanced from 716 to 2,189 steps, and the final screenshot shows the automatically loaded 121,334-Gaussian model without a live-step label. Normal native CmdQ produced exit 0 at 13:27:02.619330 UTC with `remaining_known=[]`; this exit is later than the resource collection, so there is no post-exit RSS sample. Root reported the resource sampler exited 0; its own end record independently confirms explicit stop. The separate launch-wide process monitor contains 1,734 samples and 1,958 owned observations across 19 identities, all with inbound/outbound network checks denied. Its longer 12:56:32–13:27:02 scope includes setup and later negative cases and must not be presented as mixed40 training alone. Ten unattributed WebKit/XPC PIDs remain excluded from ownership and isolation claims.

The [post-exit integrity receipt](../../target/macos-m4/native-mixed-input-20261027/independent-audit/closeout-receipt.json), SHA-256 `05e76cd2f476998416b2b6a094c3a8693bb13c374a1d4788b379217b5a2b06a3`, confirms the prior 945 bound files, exact 220-file mixed40 project tree, 445 packaged source inputs and complete 4,751-entry bundle inventory remain unchanged. This closes the recorded positive-case collection and normal exit for 4e76. It does not close total-memory accounting, pressure escalation, genuine multicamera field input, nested-root native selection, OS/XPC-wide offline operation, clean-host, macOS 15, real 16 GiB, Windows or public-release gates.


## 2026-10-28 six viewer cycles and explicit WebKit attribution

The unchanged `0f85289e` application, PID 64253, opened the authorized Objectron
test copy on M1 Pro / 32 GiB / macOS 27.0.1. Six clean editor-load/return-to-Spark
cycles each displayed 614,263 Gaussians. The [independent visual review](../../target/macos-m4/native-preview-cycles-20261028/native/visual-cycle-review.json)
checked all 13 loaded-view captures, including the initial Spark view. The
operator observed no dirty prompt or failure during these actions. No model edit,
save, training, pressure induction, sleep, Dock or window-minimize test occurred.

The [ordinary sampler summary](../../target/macos-m4/native-preview-cycles-20261028/resources-summary.json)
contains 843 samples over its 900-second session. Only the main application was
attributed: sampled RSS ranged up to 164.44 MiB, with first/last 115.83/122.02 MiB.
All pressure observations were normal and host-wide swap remained 1524.44 MiB;
these are not exclusively application consumption. The final sample preceded the
sixth Spark-ready capture, so that stable window, Home and quit have no ordinary
sampler coverage. Main-process RSS cannot resolve the WebContent finding below.

A separate [non-root attribution probe](../../target/macos-m4/native-preview-cycles-20261028/native/coalition-attribution.json)
used kernel-returned resource/jetsam coalition IDs 73790/73884 and the scoped
member-list API. Eight identities were confirmed, including WebKit GPU 64255,
WebContent 64257 and Networking 64258. The [coalition collector](../../target/macos-m4/native-preview-cycles-20261028/native/coalition-summary.json)
then produced 300 samples from 19:54:28.877189 to 20:04:28.465758 UTC, validating
membership, executable path, process start and UUID within each observation.
It began during cycle 2's Spark dwell and did not measure earlier WebKit phases.
This private coalition ABI is version-sensitive and remains an acceptance tool;
it is not a macOS 15 compatibility claim or a production telemetry change.
Per-process RSS and physical footprint are reported separately, never summed.
The counters do not isolate an iframe, allocation type or all Metal residency.

The following are WebContent **physical-footprint medians in MiB** for samples
wholly between a loaded-view capture and the next logged action. They are
process observations while each viewer is visible, not allocations attributed
to that viewer alone. Cycle 1 is warm-up; cycle 2 Spark has only a sampled tail.

| Cycle | Spark visible | Editor visible |
| --- | ---: | ---: |
| 2 | 459.11 | Not sampled |
| 3 | 461.73 | 572.16 |
| 4 | 521.95 | 576.46 |
| 5 | 588.56 | 641.05 |
| 6 | 649.88 | 702.88 |

The [growth finding](../../target/macos-m4/native-preview-cycles-20261028/native/memory-growth-finding.json)
binds the exact raw data, action times, capture receipts and per-process
statistics. These observations do not support passing the no-sustained-growth
gate. They do not alone distinguish a leak, retained cache or delayed reclamation.
A bounded investigation of the actual renderer, worker and iframe disposal paths
is required before selecting a fix; no quality threshold is relaxed.

Returning to Home removed the visible model view. Only one continuous coalition
sample followed the Home-ready capture before the 600-second collector ended.
A later CUA capture reconfirmed Home, followed by one separate resource snapshot.
The [endpoint comparison](../../target/macos-m4/native-preview-cycles-20261028/native/coalition-home-snapshot-summary.json)
retains a 361.402435-second unsampled gap and verifies the same eight identities;
it is not appended to the continuous series. At that later endpoint, WebContent
physical footprint was about 597.60 MiB and GPU-process footprint about 53.19 MiB.
The lower GPU counter does not establish complete release or its timing.

Cmd+Q then returned `App quit`; the exact application PID/path disappeared, with
OS exit status unknown. A [separate identity check](../../target/macos-m4/native-preview-cycles-20261028/native/observed-identities-after-quit.json)
found all eight previously observed identities absent (ESRCH), without process
signals or broad enumeration. The [single-copy integrity audit](../../target/macos-m4/native-preview-cycles-20261028/native/project-integrity.json)
confirmed all 439 files / 1,047,169,524 bytes unchanged. UI round trips and scoped
exit therefore have evidence, while memory stability and complete M3/M4 remain
open. Both bounded samplers ended normally; no observer or application was left
running, and no source change or fresh build is part of this observation session.

## 2026-10-28 bounded Spark disposal reproduction

The [deterministic reproduction report](../../target/macos-m4/native-preview-cycles-20261028/diagnosis/spark-dispose-race-report.json),
SHA-256 `ad9ed1f3f08a6cc65741eb3d40da4b945edfc3413b828cca771d8d4f3e49f435`,
imports the unchanged installed Spark 2.1.0 module and invokes its real constructor,
accumulator, `ensureGenerate`, `driveSort`, `readbackDepth` and `dispose` methods.
With a submitted GPU readback deliberately allowed to resolve after disposal,
the real sort path constructs a replacement SplatWorker wrapper and an actual
Three DataTexture containing a 65,536-byte CPU array. The original worker was
terminated and the old texture disposed before those replacements appeared.
A control that disposes while the worker call is pending rejects with
`Error: Worker terminate` and creates neither replacement.

The GPU interface and Browser Worker are stubs; there is no GPU allocation,
native worker or real WASM sorting evidence. The harness does not execute the
real Three WebGLRenderer's cleanup. Successful readback completion after the
application-equivalent Spark disposal is an injected condition, not a native
observation; the harness does not simulate WKWebView teardown.
This establishes a conditional Spark lifecycle defect, not the cause or size
of the six-cycle WebContent growth. All worker stubs were cleaned up after the
observations. The bounded process exited 0; no production source, package,
native application session or project file changed during this diagnosis.

The separate [SuperSplat disposal review](../../target/macos-m4/native-preview-cycles-20261028/diagnosis/supersplat-disposal-review.json),
SHA-256 `e24eda1c2982ba80f0b215c5b97fd14b6af1cb54f3d3394f0c20a81e7631f094`,
confirms normal parent bridge cleanup and iframe unmount. It records the lack
of an explicit child-scene release protocol and PlayCanvas deferred GPU
destruction as candidates, without proving retention of an old realm or GPU
device. A minimal lifecycle correction still needs focused tests, a fresh
package and comparable native memory observations. M3 memory and full M4
remain open; the original native growth finding remains unchanged.

## 2026-10-28 Spark lifecycle patch awaiting native memory retest

The [tracked Spark integration](../../integrations/spark/README.md) applies a
fixed pnpm patch to Spark 2.1.0's exported ESM/CJS modules and declaration. It
marks disposal before cleanup, cancels scheduled update/sort callbacks and checks
lifetime after every await in the non-LOD sorting path. Disposed work settles
without recreating the covered resources; live-renderer errors still propagate.
An independent review caught and corrected an `onDirty` ordering regression
before installation, preserving `sorting=false` before the callback and safe
synchronous reentry.

The unchanged real-module regression cases passed 2 and failed 12 on the
unpatched baseline, then passed all 14 after the patch. The final provenance
suite adds 17 checks, including exclusion of local machine paths from
distributable evidence. The [gate record](../../target/macos-m4/spark-lifecycle-fix-20261028/gates.json)
also binds fresh frontend 290, schema 36, typecheck, lint and the production
build. Rust 738 / 15 ignored plus fmt/Clippy are prior results reused only for
the documented unchanged bound Rust inputs; no fresh full Rust run is claimed.

The [new package receipt](../../target/macos-m4/spark-lifecycle-fix-20261028/acceptance-summary.json)
binds executable `6a5c7be6`, complete `build.Vw47qp` DMG, 587 stable source inputs,
before/after installed-patch checks, and 726 license files with no findings.
The initial build was deliberately interrupted during preflight to remove a
development-machine path from the new bundled record; it produced no candidate.
Both the failed attempt and the old `0f85` DMG remain available.

At package completion, native retesting of `6a5c7be6` was pending; the completed
follow-up below still observes growth. The fix does not
cancel underlying GPU Promises or short pause timers, cover LOD/cube/environment
helpers, or establish a cause for the observed native growth. Comparable native
cycles with attributed WebContent/GPU measurements are still required. Neither
the previous image-export result nor memory stability is transferred to this
executable, and M3 memory / full M4 remain unaccepted.

## 2026-10-28 patched candidate still shows native growth

Candidate `6a5c7be6`, PID 77997, completed the same six clean
Spark/SuperSplat round trips on the existing Objectron test copy, with 614,263
Gaussians at each loaded capture. The host was M1 Pro / 32 GiB / macOS 27.0.1.
The [root observation](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/root-native-observation.json)
binds all 15 capture receipts, including 13 loaded views and Home before/after.
Each loaded phase remained visible for at least 30 seconds; Home remained
visible for 142.856 seconds before normal Cmd+Q. Actual capture-to-action
durations are retained; action-to-capture is not measured rendering latency.

The [numerical review](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/independent-resource-review.json)
checks root PID/path/start/UUID and coalition 75035/75036 throughout. Eight
process identities remained fixed. Primary sampling started before the first
Spark action and produced 450 complete samples. Because the actual UI protocol
exceeded the initial 900-second limit, a separate 300-second bounded collector
started before that limit and ended after quit with 96 samples. Both raw files
are preserved. Analysis retains all primary samples and 66 continuation samples
after the last primary sample, excluding 30 overlapping observations. The
516-sample sequence spans 21:04:20.311802–21:21:28.763139 UTC; its splice gap is
0.426622 seconds and its largest end-to-next-start gap is 1.997699 seconds.
The [extension receipt](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/collection-extension.json)
records this protocol change. The original `coalition-summary.json` covers only
the primary stream and cannot establish the full Home dwell.

All 12 cycle ready windows contain 15 complete samples in their first 30
seconds. Home has 72 complete samples, including 61 within its first 120
seconds; exact boundary gaps are recorded. This remains discrete, non-atomic
sampling. Primary system-pressure observations were all normal and reported
1508.38 MiB host-wide swap used. Continuation pressure/swap queries were denied
by the execution sandbox: all 66 retained continuation values are unknown.
Home therefore has only six known-normal pressure samples and 66 unknowns.
No all-normal Home or full-session pressure claim is made.

WebContent PID 78003 physical-footprint medians, in MiB, for complete samples
between each ready capture and the next action:

| Cycle | Spark visible | Editor visible |
| --- | ---: | ---: |
| 1 | 355.67 | 429.66 |
| 2 | 422.50 | 473.61 |
| 3 | 486.74 | 539.27 |
| 4 | 552.63 | 606.16 |
| 5 | 617.88 | 674.42 |
| 6 | 681.21 | 734.38 |

Home WebContent median/observed peak were 632.16/656.75 MiB; GPU-process
median/peak were 52.94/53.47 MiB. Counters remain separate per process, without
summing shared residency or attributing allocations exclusively to a viewer.
This result **does not pass the no-sustained-growth gate**. The Spark patch fixes
the tested conditional disposal defect, but has not resolved this native
observation. These measurements do not distinguish a leak, cache retention or
delayed reclamation, or establish the contribution of Spark versus the editor.
Different dwell/coverage from the old run prevents a causal before/after effect
estimate. The next investigation must isolate those paths before another fix.

CUA reported `App quit`; application OS exit code is unknown. Both collectors
returned exit 0. [Scoped exit checks](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/exit-confirmation.json)
found all eight previously observed PIDs absent (ESRCH), and the executable hash
still matched the launch binding. The [single-copy integrity comparison](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/project-integrity.json)
found all 439 files / 1,047,169,524 bytes unchanged. No model edit/save,
generation, forced GC/context loss, pressure induction, Dock/minimize or real
sleep occurred. Native round trips and scoped exit have evidence; M3 memory,
full M4, target environments and public distribution remain unaccepted.

## 2026-10-28 Spark-only isolation and shared-resource diagnosis

The [closeout](../../target/macos-m4/native-spark-only-isolation-20261028/native/closeout.json)
and [retention finding](../../target/macos-m4/native-spark-only-isolation-20261028/native/memory-retention-finding.json)
freeze this run; the candidate pointer at that closeout referenced them while preserving
the previous pointer and mixed-viewer evidence.

The unchanged `6a5c7be6` candidate completed a fresh Home baseline followed by
six Spark/Home pairs on the same authorized Objectron test copy. No editor was
entered. Each loaded Spark and Home phase lasted at least 30 seconds; final
Home lasted 141.093 seconds. The [root observation](../../target/macos-m4/native-spark-only-isolation-20261028/native/root-native-observation.json)
and [independent visual review](../../target/macos-m4/native-spark-only-isolation-20261028/native/independent-visual-review.json)
bind 13 screenshots, AX texts and receipts. Six Spark captures show 614,263
Gaussians and recognizable shoes/carpet; seven Home captures have no model
view. Home hardware detection and GPU indicators remained pending. Static
captures establish their capture times; the no-editor sequence also relies on
the operator record and the six open/return action pairs.

The [summary](../../target/macos-m4/native-spark-only-isolation-20261028/native/spark-only-summary.json)
contains 441 complete samples with fixed eight-process identities. The
[independent resource review](../../target/macos-m4/native-spark-only-isolation-20261028/native/independent-spark-only-resource-review.json)
recomputed 40 windows and 240 metric arrays. All 441 system-pressure readings
were normal; host-wide swap used was 1500.38 MiB, not an app allocation. Every
phase has 15 complete samples in its first 30 seconds; final Home has 70 samples,
including 60 in its first 120 seconds. There was no continuation stream. The
original summary script failed because a writer variable shadowed a helper;
the [retained repair receipt](../../target/macos-m4/native-spark-only-isolation-20261028/native/summarize-spark-only-v2-fix.json)
records the failure and the v2 variable-only correction, which exited 0.

WebContent physical-footprint medians in MiB, over complete samples between
each ready capture and the next action:

| Phase | Spark | Home |
| --- | ---: | ---: |
| Initial baseline | — | 101.06 |
| 1 | 304.85 | 205.36 |
| 2 | 278.63 | 228.15 |
| 3 | 303.42 | 248.35 |
| 4 | 347.52 | 316.30 |
| 5 | 366.60 | 312.39 |
| 6 | 386.35 | 336.42 |

Retention also occurs without entering the editor. Neither series is strictly
monotonic. These observations do not prove a leak, exclusive Spark ownership,
the editor's numerical contribution or a causal comparison with mixed-viewer
runs with different dwell durations. Metrics remain separate per process;
this is not full Metal residency accounting. **M3 memory stability remains
unaccepted.**

CUA returned `App quit` after normal ⌘Q. [Exit confirmation](../../target/macos-m4/native-spark-only-isolation-20261028/native/exit-confirmation.json)
records all eight scoped PIDs absent with ESRCH; application OS exit code is
unknown, separately from sampler exit 0. The [integrity comparison](../../target/macos-m4/native-spark-only-isolation-20261028/native/project-integrity.json)
found the same 439 files / 1,047,169,524 bytes before and after, also matching
the previous run's stored after-snapshot. The executable hash was unchanged.
No editing/save, generation, forced GC/context loss, induced pressure,
Dock/minimize or real sleep occurred.

The [Spark source review](../../target/macos-m4/native-spark-only-isolation-20261028/diagnosis/spark-retention-source-review.json)
identified module-static fullscreen geometry retaining renderer-specific
dispose listeners. A [real-module reproduction](../../target/macos-m4/native-spark-only-isolation-20261028/diagnosis/shared-geometry-listener-repro-report.json),
with [execution receipt](../../target/macos-m4/native-spark-only-isolation-20261028/diagnosis/shared-geometry-listener-repro-execution.json),
used the actual Spark quad and Three WebGLObjects/Geometries/Attributes with
stub GL buffer operations: listener counts increased from zero to six after
objects disposal and local-handle release. Shared geometry disposal called all
six closures and cleared them. A parallel control also deleted a still-live
renderer's buffers, requiring reupload; blanket global disposal is therefore
not a safe renderer-local fix. This did not construct/dispose a full actual
WebGLRenderer or measure native GPU memory and does not establish the cause or
amount of native retention.

The [reviewable ownership design](../../target/macos-m4/native-spark-only-isolation-20261028/diagnosis/renderer-resource-ownership-design.json)
proposes renderer-local geometry, materials and fallback texture wrappers,
with explicit consumer leases and cleanup after the last user. It covers
independent renderers, multiple Spark users of one renderer and standalone
helpers; resize cleanup must not release a live user's lease, and shared texture
Source data must remain intact. This is an unimplemented design, not a tested
repair. No new production patch/build was made in this isolation. The
[editor source review](../../target/macos-m4/native-spark-only-isolation-20261028/diagnosis/editor-disposal-source-review.json)
also records cleanup gaps but does not establish survival across iframe teardown.
Full M4 and public release remain unaccepted.

## 2026-10-28 Renderer resource ownership patch awaiting native retest

The new [ee0f0bea package](../../target/macos-m4/spark-resource-ownership-fix-20261028/acceptance-summary.json)
implements the ownership correction in the tracked Spark 2.1.0 patch. A private
weak registry holds one owner per underlying WebGLRenderer, with explicit
consumer lifetimes. Fullscreen geometry is truly private, compute materials
are per consumer, and known fallback texture wrappers are renderer-local,
including the non-LOD lod-indices sampler. The last consumer releases owned
objects; nested draws defer retirement until the outer draw exits. Model
textures, caller-owned resources and the legacy no-renderer preparation path
retain their ownership. Shared texture Source data is not cleared.

Resize target cleanup is separate from final disposal. Saved generation
callbacks cannot revive disposed helpers; mutable uniform snapshots prevent
nested render interference, and active program records are bounded by current
mappings/consumers. Spark releases the display geometry/material created by
its constructor, and the desktop component disposes a renderer when Spark
initialization fails. The existing asynchronous sort-disposal guarantees are
preserved. The [independent source review](../../target/macos-m4/spark-resource-ownership-fix-20261028/independent-source-review.json)
records resolved findings and ESM/CJS parity without claiming native effects.

The [test receipt](../../target/macos-m4/spark-resource-ownership-fix-20261028/resource-ownership-final-receipt.json)
records 27 resource tests using real Spark classes, dyno compilation and Three
WebGLRenderer cleanup implementations. Coverage includes distinct renderers,
shared-renderer consumers, standalone helpers, repeated disposal, resizing,
old callbacks, nested rendering and a non-LOD ExtSplats mesh with degree-three
SH textures. WebGL calls, shader compilation/introspection, driver handles and
readback promises are stubbed. Explicit initTexture calls verify selected
texture cleanup, not real driver sampler optimization, shader pixels, native
memory amounts or M3 acceptance. LOD/paging/cube/PMREM/OldSpark are outside this
correction's tested scope.

The [gate record](../../target/macos-m4/spark-resource-ownership-fix-20261028/gates.json)
binds fresh 58 Spark checks (14 lifecycle + 27 ownership + 17 provenance),
292 frontend tests, typecheck, full lint, production build and two runtime
prechecks. Rust 738 passed / 15 ignored plus fmt/Clippy and schema 36 are
reviewed historical reuse, not fresh reruns. All 589 bound inputs, including
118 overlay files, were unchanged across checks and build. The complete
ad-hoc-signed app and `build.Lotfbt` DMG passed read-only mounting, bundle and
signature checks; the license collection lists 726 files with zero issues.

Application SHA-256 is `ee0f0beaae735811eaee41c068204e434d1208a4422afc1e7e2704fd9a65d1cd`;
DMG SHA-256 is `0ee24a97cfd2ffc0858b03c28a7d839ff803a191cf0bcd96cb789f03236aa617`.
The old `6a5c7be6` app, DMG and failing native findings remain preserved. Native
retesting was pending when this package and its immutable receipts completed;
the subsequent bounded result is recorded below. The new package has no
transferred generation/edit/save/image-export acceptance. M3 memory, M4 and
public release remain false. True sleep remains user-deferred.

## 2026-10-28 ee0f native Spark-only closeout with retention unresolved

The [root closeout](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/closeout.json),
SHA-256 `e7b194d66714b18d9eebb4b9f36c151aa6454434a63064b7af6821522c23b097`,
records a fresh launch of the `ee0f0bea` application, an initial Home baseline,
six Spark/Home pairs on the same Objectron test copy, and normal CUA ⌘Q.
The [operator record](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/root-native-observation.json)
and [independent visual review](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/independent-visual-review.json)
bind 13 original screenshots, AX texts and matching capture receipts. All six
Spark captures show 614,263 Gaussians and recognizable shoes/carpet; all seven
Home captures show the project center. No current dialog, dirty-state indicator,
loading/error mask or editor workspace is visible at the capture instants.
The no-editor sequence also relies on the operator record, not screenshots
alone. Home GPU metrics and hardware detection remain unavailable.

The [resource summary](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/spark-only-summary.json)
and [independent resource review](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/independent-resource-review.json)
cover 438 complete samples in one stream, with system pressure normal in all
438 observations. Host-wide swap used remained 1500.38 MiB; it is not an app
allocation. Every Spark/Home ready dwell met its minimum; final Home lasted
129.859 seconds and contains 65 complete samples. Samples are discrete, about
two seconds apart, and do not provide continuous memory coverage.

WebContent physical-footprint medians in MiB, using complete samples in each
full ready-to-next-action window:

| Phase | Spark | Home |
| --- | ---: | ---: |
| Initial baseline | — | 101.680752 |
| 1 | 305.548225 | 213.829475 |
| 2 | 275.720123 | 223.876373 |
| 3 | 355.220215 | 280.524902 |
| 4 | 353.454636 | 326.532738 |
| 5 | 375.485886 | 326.157784 |
| 6 | 399.009380 | 345.610954 |

Neither series is strictly monotonic; Home decreases from cycle 4 to cycle 5.
Final Home nevertheless remains above baseline after its extended dwell.
The [retention finding](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/memory-retention-finding.json)
therefore leaves **the repeated-preview memory criterion and M3 memory
acceptance false**. Normal global pressure, a completed UI sequence and the
module ownership correction do not establish resource stability.

The [comparison with the earlier 6a5 Spark-only run](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/spark-only-comparison.json)
confirms identical stored project-file records, but dwell durations and host
scheduling differ. Full-window and first-30-second medians are separately
labelled ordinary sample medians, not time-weighted values. This is a
descriptive comparison, not a controlled improvement/regression estimate or
proof of the patch's causal contribution. Discrete footprint/RSS samples
cannot distinguish live reachable objects, delayed garbage collection,
allocator/cache retention or native resources. WebContent/GPU are process
roles, not viewer-exclusive ownership; process values are not summed and do
not account for total GPU residency.

CUA returned `App quit` after normal ⌘Q. The [exit confirmation](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/exit-confirmation.json)
records ESRCH for all eight observed process identities. Application OS exit
code is unknown; collector exit 0 is separate. The [project comparison](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/project-integrity.json)
records 439 files / 1,047,169,524 bytes unchanged. This run did not enter the
editor, edit/save, train, force GC/context loss, induce pressure or test Dock,
offline Finder, real sleep or unavailable target environments. The packaging
receipt retains its original native-pending creation state; old failing runs
and historical generation/save/image-export results retain their own scope.

Next is bounded retention-path diagnosis of JavaScript reachability/disposal
and native resource categories before selecting another production patch.
The [diagnostic recommendation](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/diagnosis/next-retention-diagnostic.json)
proposes a lifetime/retaining-path census, then a decode-only versus full-render
comparison if needed; neither proposed diagnostic has been implemented or run.
Repeated rebuilds or relaxed criteria are not a substitute for that evidence.
No causal leak conclusion is established. M4 and public release remain false;
real sleep remains user-deferred.

## 2026-10-28 OrbitControls root repair and Release observation

The new `a2146f95` / `build.OX71fC` [package receipt](../../target/macos-m4/orbit-controls-root-fix-20261028/acceptance-summary.json)
binds a tracked patch to exactly Three 0.185.1. OrbitControls saves the root
used to register its keyboard listeners, removes both keydown and any pending
keyup listener from that root even after host detachment, clears the Control
state, and handles repeated/unconnected disposal and reconnection. No production
GaussianSplatPreview component change was needed in this repair.

The actual-library baseline was 2 passing / 16 failing cases; the patched
library passes all 18. The same real React component regression goes from four
failures to four passes, covering ordinary/StrictMode unmount, held Control,
pressure release/recovery and reentry. GPU/Spark/IPC are mocked in that component
test; these checks do not establish native memory behavior. Fresh gates are
296 frontend, 60 Spark and 39 Three tests, typecheck and full lint. Rust 738
passed / 15 ignored, fmt/Clippy and schema 36 are explicitly bounded historical
reuse. All 597 source records are identical across the recorded gate/build
snapshots. The 729-file / 611-notice license collection has zero issues, and the
complete ad-hoc app/DMG passed read-only mount, bundle and signature checks.

The [native closeout](../../target/macos-m4/native-orbit-root-cycles-20261028/native/closeout.json)
records an ordinary Release launch with no Inspector, diagnostic census or
forced GC. The predeclared six Spark/Home pairs and all 13 checkpoints completed.
The [independent visual review](../../target/macos-m4/native-orbit-root-cycles-20261028/native/independent-native-visual-review.json)
checks all original JPEG/AX payloads and capture hashes: six Spark views show
614,263 Gaussians with recognizable shoes/carpet and seven Home views show the
project center. No current modal error, loading mask or editor is visible at
those instants. Historical failed/missing-path entries in the Home list are
separate from the active preview. Peripheral blur remains; no quality improvement
is claimed. The operator ledger supplies the sequence between captures.

The [resource summary](../../target/macos-m4/native-orbit-root-cycles-20261028/native/resource-summary.json)
covers 460 complete samples and eight exact process instances. Every dwell
minimum was met. Final Home lasts 140.659 seconds to checkpoint 13 and contains
70 complete samples. **All 460 system-pressure and swap observations are
unknown**: the raw sysctl requests returned Operation not permitted. They are
not normal-pressure or zero-swap evidence. No observer restart or retrospective
replacement of unavailable measurements was performed.

The [independent resource audit](../../target/macos-m4/native-orbit-root-cycles-20261028/native/independent-resource-audit.json)
recomputes 15 windows, 240 instance/metric rows and 1,200 statistic values with
no mismatch, retaining separately labelled full-window and first-30-second
comparisons to ee0f. Structural protocol validation is not telemetry availability
or a memory pass. The [acceptance finding](../../target/macos-m4/native-orbit-root-cycles-20261028/native/memory-stability-finding.json)
preserves that distinction and the bounded next diagnostic.

WebContent PID 13724 is identified by its start time, executable UUID, path and
resource/jetsam coalitions. The following are unweighted medians in MiB from
complete samples inside each ready-to-snapshot window:

| Phase | Spark footprint | Home footprint | Home RSS |
| --- | ---: | ---: | ---: |
| Initial baseline | -- | 100.907 | 115.938 |
| 1 | 321.564 | 184.001 | 384.734 |
| 2 | 270.517 | 200.033 | 426.672 |
| 3 | 301.947 | 203.017 | 515.828 |
| 4 | 276.298 | 245.267 | 519.844 |
| 5 | 279.345 | 208.783 | 555.859 |
| 6 | 286.072 | 211.900 | 560.133 |

Home footprint is not monotonic and falls after cycle 4. RSS still increases
in steps across the six Home windows. Initial-to-final Home residual alone is
not proof of a leak or failure; the combined sequence and missing host-pressure
context do not establish the existing no-continuing-growth criterion. **M3
memory acceptance remains false**, as do M4 and public release. Footprint/RSS
cannot distinguish live roots, delayed collection, allocator/cache retention
or native resources; no process sum, viewer-exclusive allocation or total GPU
residency is inferred. This Release run did not measure object reachability.

The previous ee0f run's final Home footprint median was 345.611 MiB. The lower
211.900 MiB value here is descriptive, not a controlled patch effect estimate:
dwell times, scheduling and available host-pressure evidence differ. In
particular, this run's Home1 lasted 149.371 seconds because of the observation
pause. Full windows and equal first-30-second comparisons must stay separately
labelled. Historical failures and original generation/edit/export acceptance
remain bound to their own candidates.

The [independent exit/integrity audit](../../target/macos-m4/native-orbit-root-cycles-20261028/native/independent-exit-integrity-review.json)
passes 32 checks. After normal CUA Cmd+Q, all eight observed exact process
instances return ESRCH. Collector exit code is 0; application OS exit code is
unknown. One before and one after stable scan contain identical 439 file records
/ 1,047,169,524 bytes. No editor, edit/save, training, camera navigation, pressure
induction, context loss, Dock, offline Finder or sleep test occurred. The next
step is bounded resource-category/retaining-path diagnosis, not repeated builds
or a relaxed threshold. True sleep remains explicitly user-deferred.

## 2026-10-28 unchanged Release VM-category diagnostic

The [frozen diagnostic closeout](../../target/macos-m4/native-orbit-category-20261028/native/closeout.json)
uses the same a214 executable and authorized Objectron copy. No production source
change, rebuild or broad test was performed. Before launch, the protocol fixed
six Spark/Home pairs, 13 captures, minimum 30-second phase dwells and a minimum
120-second final Home. Category commands were fixed to `footprint -p PID -f bytes
--swapped` for the attributed WebContent/GPU instances and `vmmap -summary PID`
for WebContent, after snapshots 1, 3 and 13. The nonroot utilities completed all
nine commands with exit 0, no stderr or timeout, and matching PID, start time,
executable UUID/path and both coalitions before/after each command. Those checks
cannot eliminate a PID race within a non-atomic utility invocation.

The [resource summary](../../target/macos-m4/native-orbit-category-20261028/native/resource-summary.json)
contains 490 complete samples across eight exact instances. All pressure samples
are normal, with no pressure/swap query errors. System swap reports total
3072.00M, used 1460.38M and free 1611.62M throughout; these are system values at
the utility's displayed precision, not app-owned swap or zero-swap evidence.
Final Home's natural ready-to-snapshot window is 160.395 seconds / 80 samples.
Home0–Home6 footprint medians are 106.282, 185.408, 288.783, 222.502, 269.283,
229.017 and 231.814 MiB; corresponding RSS medians are 130.266, 374.375, 446.891,
480.438, 488.516, 522.469 and 528.109 MiB. Footprint is nonmonotonic while RSS
increases between the Home windows. This does not establish stable long-run use
or identify a leak.

The [category analysis](../../target/macos-m4/native-orbit-category-20261028/native/category-analysis.json)
keeps the three utility captures separate from those window medians. Commands
start 16.533, 14.736 and 17.438 seconds after their corresponding UI snapshots.
Each phase window excludes its subsequent utility calls, but the overall run
includes earlier instrumentation and is not a pristine timing comparison.
Exact printed bytes from `footprint` are:

| Process/category | Baseline Home | Home1 | Home6 |
| --- | ---: | ---: | ---: |
| WebContent footprint / total Dirty | 109,020,240 | 194,282,936 | 243,123,808 |
| WebContent Clean | 15,630,336 | 16,973,824 | 16,973,824 |
| WebContent Reclaimable | 193,708,032 | 407,191,552 | 532,070,400 |
| WebKit Malloc Dirty | 33,308,672 | 70,926,336 | 103,514,112 |
| Untagged Dirty | 2,195,456 | 9,519,104 | 25,247,744 |
| GPU-service footprint | 19,104,656 | 25,527,328 | 25,150,544 |

Home1→Home6 WebContent footprint grows by 48,840,872 bytes; WebKit Malloc accounts
for +32,587,776 and Untagged +15,728,640 in that utility's categories. WebAssembly
Dirty changes by -16,384 bytes and graphics Dirty by zero. The later growth is
therefore not explained solely by growth of the idle decoder's WASM category or
GPU-service footprint. VM tags do not identify JS roots, allocation stacks,
individual decoder buffers or viewer-exclusive ownership.

`footprint` Dirty includes the parenthesized Swapped subset; `vmmap` DIRTY excludes
SWAPPED. Captured process swap columns are zero, but the accounting distinction
still matters. vmmap K/M/G tokens are rounded; reserved virtual address space
is not allocated physical memory. Reclaimable is not a proven immediately
released amount and must not be added to footprint as app-owned usage. Counters
are not summed across processes. The analyzer's initial assumption that Regions
must sum to TOTAL was incorrect: initial script/reports are preserved, and the
corrected check validates the byte columns without changing raw evidence. The
[independent resource audit](../../target/macos-m4/native-orbit-category-20261028/native/independent-resource-audit.json)
passes all 112 checks, including the recorded windows and categories.

The [independent visual review](../../target/macos-m4/native-orbit-category-20261028/native/independent-native-visual-review.json)
passes 144 checks across all 13 original images/AX, payload identities and category
command identities. Six Spark views display 614,263 Gaussians with recognizable
shoes/carpet; seven Home views display the project center. The
[exit/integrity review](../../target/macos-m4/native-orbit-category-20261028/native/independent-exit-integrity-review.json)
passes 39 checks: normal CUA Cmd+Q, eight exact observed instances ESRCH and
identical 439 file records / 1,047,169,524 bytes. Collector exit is 0; application
OS exit code remains unknown. No editor, save, training, Inspector, forced GC,
context loss, pressure induction, Dock, offline Finder or sleep test occurred.

Offline application, decoder and renderer ownership reviews found no additional
normal-path root explaining this growth. Two failure-only defects were
deterministically reproduced against installed modules: synchronous worker
`postMessage` failure leaves an RPC entry, and Three WAIT_FAILED readback skips
PBO/sync deletion. These remain unfixed and were not shown to occur during the
successful native cycles. They warrant separate robustness fixes and regression
checks, without claiming a normal-cycle memory resolution.

Next, obtain bounded allocation or retainer evidence for WebKit Malloc/Untagged
to distinguish live owners from allocator/runtime capacity before choosing a
normal-path fix. Any instrumentation, forced collection or context intervention
must have a separately identified protocol; no extra run was started by this
closeout. M3 memory, complete M4 and public release remain unaccepted. The prior
460-sample unknown telemetry and all older candidate results retain their scope.
