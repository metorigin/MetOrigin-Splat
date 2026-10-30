# macOS Brush CLI and adapter comparison

On 2026-10-27, the archived native adapter output and an independent Brush CLI run passed structural checks and a limited three-view visual review on Apple M1 Pro, 32 GiB unified memory and macOS 27.0.1. The paired views retain the same subject pose, scale, silhouette, supports and turntable; small local texture and shading differences remain. No calibrated quality tolerance was established, so this result does not assert equivalent reconstruction quality or absence of all regressions.

The input is the **James40-derived engineering video**: 20 seconds, 40 source frames at 2 fps, created from the James40 CC0 photographs. This comparison reuses its already prepared training dataset. It does not rerun frame extraction or SfM and does not cover the separate 119-frame real-shot video. The copied dataset contains exactly **50 files, 40 images and 8,178,564 bytes**, all checked against the [dataset lock](../../target/macos-m4/cli-adapter-comparison-20261027/dataset-lock.json). It contains no `init.ply`, other PLY or `args.txt`.

| Identity | Native adapter baseline | Independent CLI |
| --- | --- | --- |
| Application provenance | Original fresh run in `bb13a6ee…` | `cfba918e…` supplied the packaged Brush executable only |
| Training | Fresh 3,000 iterations, SH0 | Fresh 3,000 iterations, SH0; exit 0 |
| Final Gaussians | 81,368 | 81,656 |
| PLY bytes | 4,557,109 | 4,573,237 |
| PLY SHA-256 | `9f61ea25b93abdb6f681de84c8a249cd5f6f9783863684f3d65ce5241e8939e8` | `e76e12e7b19583bec6112cdd75826153b59527fd102312bbe3c45b77783c5bbd` |

The native application SHA-256 is `bb13a6ee182b825216b05e7f98fe121f33a3fc319e34e2b3ef25d7e275300ded`; its project/run IDs are `01a17cc0-8c53-7f21-a1bd-0037943b04b7` and `01a17cc0-98f4-7ee0-a958-21ca198810c8`. The [original native receipt](../../target/macos-m4/final-native-video-readonlyfix-20261027/final-result.json) and preserved final PLY are the baseline. Later restored or warm-start outputs are excluded.

The CLI executable was taken from application SHA-256 `cfba918efdb73a09e48a905dde03b465e14e82f73041850aa49a9a7ac60863af`. Both runs used Brush `1.0.0+metorigin-macos.6`, binary SHA-256 `f8fb8784d394e224f9057243bbb6e1f33039ea34063ec8fa91c339853c144e1c`, with Metal on Apple M1 Pro. This establishes identical engine bytes; it does **not** turn the archived baseline into a fresh cfba application run. The [rebind receipt](../../target/macos-m4/cli-adapter-comparison-20261027/rebind-current-package.json) preserves the previous preparation and binds the replacement executable path.

The [CLI invocation](../../target/macos-m4/cli-adapter-comparison-20261027/direct-run-02/invocation.json) records 3,000 iterations, SH0, maximum image resolution 1,280, a 1 GiB scene-batch cache, a 1,500,000-Gaussian ceiling, six loader threads, LOD0, units-per-meter 1 and seed 42. Exports occur every 500 iterations and evaluation is requested every 300 iterations. Those two intervals were derived from adapter source; the historical native argv was not captured. Runtime logs establish 40 training views, zero evaluation views, no initial PLY and seed 42. Tokio and Rayon thread counts are both six. CLI live preview was disabled; the native baseline served 32 live frames. Their recorded durations are therefore not a matched performance or live-preview-overhead benchmark.

The [structural comparison](../../target/macos-m4/cli-adapter-comparison-20261027/comparison-result.json) validates the complete float32 Gaussian payload, expected SH0 schema and exact byte length, finite values, positive finite exponentiated scales and normalized quaternions. Both PLYs have the same property schema and coordinate metadata. They are not byte-identical. No point-index correspondence, alignment, recentering or model normalization is applied.

| Distribution diagnostic | CLI relative to native adapter |
| --- | ---: |
| Gaussian count | +288 / +0.354% |
| Opacity-weighted centroid displacement / adapter p01–p99 diagonal | 0.298% |
| p01–p99 coordinate diagonal | −0.227% |
| Median sorted principal scales | −0.699% / +0.190% / +0.505% |
| Opacity-weighted covariance relative Frobenius difference | 5.834% |

These diagnostics describe independent, unordered training results. No numerical acceptance threshold was chosen after observing them.

The [fixed camera specification](../../target/macos-m4/cli-adapter-comparison-20261027/visual-review/camera-spec.json) uses prepared COLMAP poses for `000000.jpg`, `000020.jpg` and `000039.jpg`, with the application camera convention: position `−Rᵀt`, forward `R[2]`, up `−R[1]` and vertical field of view from `fy`. Each model uses the same camera without a model-specific fit or transform. The actual viewport is **965 × 640**, pixel ratio 1, matching the normalized camera dimensions; the preliminary 960 × 640 proposal described the source frame size and is superseded here.

Rendering uses local Three.js 0.185.1 and Spark 2.1.0, sRGB output, background `#11161c`, no antialiasing, `sortRadial:false`, `enableLod:false`, `accumExtSplats:true`, `maxStdDev:3`, `preBlurAmount:0.3`, `blurAmount:0`, and extended splats with LOD disabled. Before a capture becomes available, the viewer checks loaded Gaussian counts, active splats, completed sorting, a healthy WebGL context, nonuniform foreground pixels and six stable readbacks. PNG bytes and capture JSON are hash-bound in the [viewer binding](../../target/macos-m4/cli-adapter-comparison-20261027/visual-review/binding.json) and [review receipt](../../target/macos-m4/cli-adapter-comparison-20261027/review-summary.json).

| Prepared camera | RGB MAE (0–255) | RGB RMSE (0–255) | Pairwise PSNR (dB) | Captures |
| --- | ---: | ---: | ---: | --- |
| `000000.jpg` | 3.194644 | 4.682213 | 34.721781 | [Adapter](../../target/macos-m4/cli-adapter-comparison-20261027/captures/adapter-view-0.png), [CLI](../../target/macos-m4/cli-adapter-comparison-20261027/captures/cli-view-0.png) |
| `000020.jpg` | 3.114552 | 4.469794 | 35.125053 | [Adapter](../../target/macos-m4/cli-adapter-comparison-20261027/captures/adapter-view-1.png), [CLI](../../target/macos-m4/cli-adapter-comparison-20261027/captures/cli-view-1.png) |
| `000039.jpg` | 3.090698 | 4.569449 | 34.933527 | [Adapter](../../target/macos-m4/cli-adapter-comparison-20261027/captures/adapter-view-2.png), [CLI](../../target/macos-m4/cli-adapter-comparison-20261027/captures/cli-view-2.png) |

These metrics compare RGB bytes of the two rendered outputs, excluding alpha. They do not compare either output with a reference photograph. The views come from training poses, and no held-out evaluation images were present. Consequently, this PSNR is **not reconstruction-quality or held-out PSNR**. Two independent assistant reviews inspected all six original-resolution PNGs: no gross axis inversion, displacement, missing subject or scale mismatch was visible; fine texture and local shading differed.

The [independent audit](../../target/macos-m4/cli-adapter-comparison-20261027/independent-review/audit-result.json) passed 308 recorded checks, rehashed the dataset and provenance chain, verified all six PNG/capture bindings, and recomputed every reported PNG MAE, RMSE, maximum RGB difference and PSNR with Pillow/NumPy. Each recomputed metric exactly matched the saved value. Existing evidence remained unchanged; the audit launched no engine, browser or renderer.

| Receipt | SHA-256 |
| --- | --- |
| Root three-view review | `611572aa634eac0aa9360a469c5c401b57f5b1ac9c32178e7a261cf62eb961b5` |
| Structural comparison | `7cd07057fac148beeeed35fcda1577451e5a7d288d558d8c4d14b0cda773e5e4` |
| Completed CLI summary | `3c6cb92b3fddf69662b19d673c4102008f255ef358cd31b5544e8ef8b825e4fb` |
| Independent audit | `d058b2969f40403e1d1ac60a338f1a7f59c659b99c641720483c69e9673d9630` |

All linked run evidence is local and ignored under `target/`; it is not bundled as application content. Scope remains one James40-derived SH0 dataset on this host. SH1/SH2 agreement, the 119-frame real-shot dataset, minimum macOS, 16 GiB machines, clean hosts and Windows require their own evidence. The result also does not establish a performance comparison, calibrated quality equivalence or general output determinism.
