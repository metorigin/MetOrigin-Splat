# Brush macOS integration patches

These cumulative patches target the Apache-2.0 licensed Brush source at
[`1388f74c6fe0236f68ee4915564bf00e9d2e3747`](https://github.com/MinKaiZhi/brush/tree/1388f74c6fe0236f68ee4915564bf00e9d2e3747).
The upstream license and notices remain in the engine checkout and must accompany
any distributed engine. No upstream binaries, datasets, or model weights are
copied into this directory.

`patches/0001-report-initialized-adapter.patch` identifies the CLI as
`1.0.0+metorigin-macos.1`. Its SHA-256 is
`00f507d8d14290232f2ddc02d5cffed88f127044a0bb3bd9e19ea9055929aadb`.

The stock CLI initializes WGPU before installing its logger. Consequently, the
real `AdapterInfo` log is lost, while its later device description only says
`backend: Auto`. The patch returns `AdapterInfo` from the actual initialized
`WgpuSetup.adapter.get_info()` and logs it once the CLI logger is ready. It retains
the original `burn_init_setup` and `run_cli_ui` entry points for other consumers.
The additional initialization function can support the later structured probe;
this patch does not implement or advertise a full capabilities protocol.

Apply it only through the fixed build recipe:

```sh
scripts/macos/build-brush.sh --diagnostics-patch \
  target/macos-m0/brush target/macos-m0/brush-build-patched
```

The recipe requires the pinned base commit and a detached checkout, validates the
patch hash, and permits only pristine source or precisely this existing patch.
It refuses other edits, staged files, and untracked files. It records the patch
identity with the resulting binary hash in `evidence/build-info.json`.

`test_prepare_brush_source.py` exercises applying/reapplying the patch and refusing
branch, checksum, revision, staged, untracked, and conflicting-edit cases without
changing their original contents. The patch also adds a CLI version test that
runs before GPU initialization. Real training must additionally report the
initialized Metal adapter and produce complete Gaussian PLY files.

## Machine and training contracts

`metorigin-macos.2.patch` adds the machine interface; its SHA-256 is
`0bd728c9f1048372791eb28923a7af5dd10d3ad1dd9b5cbf62ae5de57182cfc7`.
`metorigin-macos.3.patch` also fixes CLI precedence and checkpoint publication,
and implements a real dataset loader thread limit. Its SHA-256 is
`f2e0853ba495e492fa5ebb890ed8d2a7886ce54752740daacbc67aff3c228cc8`, pinned in
`prepare-brush-source.py` and `build-brush.sh`. Each patch applies directly to the
same pinned base commit; do not stack the patches. Preserve earlier artifacts in
binary-SHA-specific directories when evaluating a later revision.

Build the training-only revision 3 contract in a separate detached checkout:

```sh
scripts/macos/build-brush.sh --training-contract-patch \
  target/macos-m2/brush target/macos-m2/brush-build
```

Both machine flags are exclusive and require no dataset. They emit one JSON line
to stdout. `--capabilities-json` returns before runtime/device initialization;
`--probe-json` initializes the actual WGPU adapter and requires Metal, renders
eight visible Gaussians into a 32×32 image, executes the Gaussian backward
kernels, and reads back the finite pixels, positive loss and nonzero finite
opacity gradients. Adapter discovery alone cannot produce a successful probe.
The GUI binary also handles these flags before viewer initialization.

Revision 3 capabilities:

```json
{
  "schema_version": 1,
  "engine": "brush",
  "engine_version": "1.0.0+metorigin-macos.3",
  "source_commit": "1388f74c6fe0236f68ee4915564bf00e9d2e3747",
  "build_id": "metorigin-macos.3",
  "cli_profile": "metorigin_1",
  "target": "aarch64-apple-darwin",
  "supported_features": [
    "capabilities_json", "compute_probe", "ply_checkpoint", "ply_warm_start",
    "loader_thread_limit", "atomic_checkpoint", "explicit_cli_overrides"
  ],
  "live_protocol": "disabled",
  "resume_mode": "ply_warm_start_optimizer_reset"
}
```

A successful probe adds `probe_kind: "compute_smoke"`, `status: "supported"`,
`backend: "metal"`, actual `device_name` / `device_type`, and `compute` containing
`gaussian_count`, `width`, `height`, `forward_finite`, `gradient_finite`, `loss`
and `gradient_l1`. It retains the schema, engine, version, commit and build ID.
Failure has `status: "failed"`, null backend/device_name, and a stable error:

```json
{
  "code": "BRUSH_GPU_PROBE_FAILED",
  "message": "The training GPU could not complete the Gaussian compute check.",
  "retryable": false
}
```

Failure exits nonzero. Raw runtime details are excluded from the JSON contract;
stderr can contain local diagnostics. External `build-info.json` binds the patch
SHA and binary SHA to the source/build identity; the binary does not claim a
self-referential patch hash.

`--num-loader-threads N` accepts positive integers and directly controls the
number of SceneLoader actor threads (including a loader recreated at a LOD
boundary). Omission retains upstream available-parallelism behavior; WASM uses
one actor. It is not a bound on every runtime or GPU-driver thread. The app must
require `loader_thread_limit` before using this CLI profile.

CLI parsing preserves original OS argument tokens and records Clap's
`CommandLine` provenance. Only explicitly supplied settings override args.txt,
including values equal to defaults such as `--start-iter 0` and `--lod-levels 0`.
args.txt supports single/double quotes and backslash escapes without shell
expansion. Saving settings quotes tokens reversibly, including paths with
spaces, Chinese characters and literal quotes. No join/split-whitespace round
trip is used to merge configuration.

The official Brush PLY serializer and units conversion remain in use. Before
publication the writer verifies the full binary Gaussian schema, SH field set,
payload length and every scalar's finiteness. It writes a same-directory hidden
`.part` file, syncs the file, renames it atomically to the checkpoint path, and
syncs the directory on Unix. Write/validation failures preserve the preceding
checkpoint and now terminate training with nonzero status. A forced kill can
leave a `.part` file, which is never a checkpoint. A directory-sync failure after
rename reports failure even though a complete new checkpoint may already exist.

Warm start reloads Gaussian parameters from PLY and resets optimizer state.
Loaded learned Gaussians exceeding `--max-splats` are rejected; the checkpoint
is not silently subsampled to fit a lower memory profile.

## Slot live bridge (revision 4)

`metorigin-macos.4.patch` is cumulative, with SHA-256
`95e56aaa6b253fa21174d8ef002e95eba4a79f684d3b75a3b565f10141ccf631`.
Build it with `build-brush.sh --live-preview-patch` in another isolated checkout.
Its version/build ID ends in `metorigin-macos.4`; it adds `live_preview` to
`supported_features` and sets `live_protocol` to `ply_request_ack_v1`. The primary
`brush-cli` binary serves both training and live preview. Revision 3 remains
available with live disabled; the Windows 0.3 companion remains unchanged.

The bridge retains the existing protocol-1 fields and environment variables:

- `METORIGIN_BRUSH_LIVE_DIR` names a fresh UUID session directory; its parent has
  the application's `session.json` with matching protocol/session and active,
  available status. `METORIGIN_BRUSH_LIVE_SESSION` contains that UUID.
- `request.json` contains `session_id`, `after_revision`, `mode` (`live`, `low`,
  or `off`) and `expires_at_ms`. `after_revision` acknowledges the last fully
  consumed frame. It must exactly equal the producer's current revision.
- The producer atomically publishes a complete `frame-N.ply` before `latest.json`.
  Latest metadata contains `protocol`, `session_id`, `revision`, `iteration`,
  `splat_count`, `relative_path`, and `created_at_ms`.

`RunningProcess.splat_view` remains compatible with the GUI. A second watch Slot
holds one `TrainingSnapshot { iteration, splats, units_per_meter, up_axis }`.
The training actor captures the shallow model clone and its completed iteration
in the same publication (`iter + 1` after the optimizer/refinement step).
Consumers never combine an older progress event with a newer model. Initial
models use `start_iter`; no intermediate LOD-decimation model is mislabeled as a
completed training step.

A separate actor checks requests at 100 ms intervals. Missing, malformed,
expired, disabled, wrong-session or unacknowledged requests do not start GPU
readback. After readback it checks demand again before publishing, so closing
preview during serialization discards that result. Live uses the same official
PLY serializer, units conversion exactly once, up axis, full SH attributes and
Mip floor as checkpoints. Publication uses revision 3's full-payload validation
and atomic writer.

There is one in-flight readback and one latest shallow candidate, with no model
queue. One frame may wait for ACK; an expired request simply stops production.
`live` requires five new iterations and `low` requires 100; normal completion can
publish a requested final iteration earlier than that interval. Without a new
ACK, the final live frame can precede the final checkpoint and the app should use
its checkpoint fallback. The producer retains only the newest two disk frames
for viewer swaps. Normal shutdown checks final demand once; cancellation drops
the actor and prevents further publication. A forced process kill can leave
unpublished `.part` files, which consumers must ignore. A live export error
stops only the bridge and logs a warning; checkpoint failures still fail training.

Revision 4 passed 22 CLI/process regression tests, Clippy including tests with
warnings denied, rustfmt and the 22 build/preparation checks. The real Metal
equivalence test trains the normalized fixture with SH2 and
`units_per_meter=1000`, then verifies a paired iteration-10 live frame equals the
iteration-10 checkpoint byte for byte. Pure regression tests exercise empty
Slots, absent/expired/off demand, changed sessions, repeated/stale ACKs, one
frame per ACK, shutdown demand and closing preview during serialization.

The final binary's independent CLI test completed baseline/live 1000-step runs and
consumed 81 complete frames. The final published frame was revision 82 at
iteration 1000 and matched `checkpoint_1000.ply` byte for byte. Its SHA-256 is
`86608984f61ad10073c426f29a72a254413e7f6cba399b31ddec339ef36212fd`. It verified negative requests, exact ACK handling,
two-file retention and no producer after exit. Warm-cache process maximum RSS
was 260,423,680 bytes without live and 273,563,648 with live; peak footprint was
295,601,184 and 313,820,192 bytes respectively. These are observations from one
M1 Pro/macOS 27 run, exclude WebView/viewer meshes, and must not replace the cold
startup budget or be interpreted as a performance comparison.

Reproduce the actual consumer handshake and memory observation with:

```sh
python3 scripts/macos/check-brush-live.py \
  --brush /absolute/frozen-artifact/brush-cli \
  --build-info /absolute/frozen-artifact/build-info.json \
  --dataset /absolute/normalized-fixture \
  --output /absolute/new-live-evidence
```

The script validates every PLY before acknowledging it. It rejects binaries
without the capability declaration. The application must additionally enforce
its own profile/probe/feature agreement and validate PLY bytes received over IPC.

## Verification

`check-brush-contract.py` copies an existing normalized local fixture into a new
output directory and exercises the actual binary:

```sh
python3 scripts/macos/check-brush-contract.py \
  --brush /absolute/frozen-artifact/brush-cli \
  --build-info /absolute/frozen-artifact/build-info.json \
  --dataset /absolute/normalized-fixture \
  --output /absolute/new-contract-evidence
```

It checks the real compute probe, explicit-default precedence, quoted args.txt,
Chinese/space paths, two loader actors, complete PLY output, warm start, rejection
of lower Gaussian budgets, export failure, termination and recovery from a
complete checkpoint. Run only on an Apple Silicon host with actual GPU access.
The test fixture and generated artifacts stay local.

On the current M1 Pro/macOS 27 host, revision 2 passed 15 library tests, the
explicit Metal test, a 300-step train and 300→310 PLY warm start. Revision 3 passed 34 Rust library tests, Clippy with warnings denied, rustfmt,
22 build/preparation tests and the native contract checks; its final binary SHA-256
is `d73830ee5ad1b04d13ec3e2c5fca92be52a7589171b4432ef24d47ea5c6e7acf`. The default restricted sandbox also confirmed
capabilities succeeds without a GPU while the real probe emits failure JSON
and exits 1. These checks do not establish macOS 15 compatibility, exact optimizer
continuation, visual quality, LPIPS redistribution rights, or package signing.

## Distribution profile: revision 5 without embedded LPIPS

`metorigin-macos.5.patch` retains revision 4's training/live contracts and makes
LPIPS weights an explicit, default-off compile feature. The pinned patch SHA-256
is `1034676b02f2c42624368bb7183a315dc787037d8605cdbb7fde16c6e0b13249`.
The [weight provenance audit](LPIPS-AUDIT.md) explains why the known BPK is excluded.
This resolves this weight's default binary inclusion, not all packaging/signing
or third-party dependency review requirements.

`--lpips-policy-patch` reproduces revision 5. The current distribution default
is revision 6 below. Historical `--stock` and revisions 1–4 remain available for
research reproduction. Use a separate detached checkout and output directory:

```sh
scripts/macos/build-brush.sh --lpips-policy-patch \
  target/macos-m4/brush target/macos-m4/brush-build-final
```

The recipe builds default WGPU only, captures the actual CLI target dependency
graph and verifies that neither `lpips` nor the known packed payload enters the
binary. It records `lpips_weights_embedded: false` and
`distribution_policy: "lpips_weights_excluded"` in build metadata. Capabilities
also include `lpips.embedded_weights: false` and `lpips.loss_available: false`.
Existing `metorigin_1` CLI and `ply_request_ack_v1` identifiers remain unchanged.

Positive LPIPS weight requests fail clearly; merged `args.txt` values receive the
same validation. Explicit CLI `--lpips-loss-weight 0` overrides a positive file
value. Negative or nonfinite weights are rejected. No weights are downloaded at
runtime. The optional `embedded-lpips` feature is excluded from the release recipe
and cannot be used for distribution without a separate completed provenance
review. Version 3 and 4 stable artifacts are preserved in their original directories.

Revision 5 validation (2026-10-27) is frozen at binary SHA-256
`0b0578720e6e131cb64f2436012f014cab64d01b20fc1c59d7ad082fd295df86`
(84,149,496 bytes), under `target/macos-m4/brush-artifacts/<SHA>/`. Its build-info
and `distribution-policy.json` travel beside the executable. The default source
lock remains unchanged.

- 29 build/preparation/distribution Python tests; Rust CLI 10 + process 13 +
  LPIPS configuration 2 tests passed. The two Metal tests remain ignored in the
  ordinary test suite; the actual snapshot test was run explicitly below.
- Clippy including tests (`-D warnings`), rustfmt and exact patch checks passed.
  The explicit controlled feature also passed `cargo check`; no weight-enabled
  executable was substituted for the default distribution artifact.
- `contract-check-final/evidence.json`: 9 actual Metal checks passed, including
  both LPIPS rejection paths and successful explicit-zero override, warm start,
  thread limits, atomic export, failure and interruption recovery.
- `live-check-final/evidence.json`: baseline/live each completed 1000 steps;
  100 frames were validated before ACK, invalid demand/ACK/off modes held their
  revisions, and no producer remained after exit. The last frame was step 996;
  the valid step-1000 checkpoint supplies the documented completion fallback.
- `live-check-final/same-iteration-pairs.json`: live frames at steps 400/600/800
  match their corresponding checkpoint hashes. The separate real Metal
  SH2/units-per-meter=1000 snapshot test also proved byte-identical step-10
  snapshot/checkpoint output (`brush-evidence/snapshot-metal-equivalence.log`).
- Restricted sandbox probe returned one structured failure JSON and exit 1;
  capabilities remained available without GPU initialization.

These checks do not establish clean macOS 15 deployment, application-wide memory
limits, signing/notarization, or distribution rights for unrelated dependencies.


## Distribution profile: revision 6 optional dependency exclusion

Revision 6 preserves the revision 5 LPIPS policy and revision 4 training/live
contracts. The default native build excludes Rerun and its `hex-slice` dependency
because the published source archive did not supply the required MIT notice.
The `RerunConfig` type and visualization API remain compatible; native recording
requires the explicit `native-rerun` research feature propagated from CLI to
process to `brush-rerun`. Both an explicit CLI request and `--rerun-enabled` in a
merged `args.txt` fail clearly in the default build. No silent visualization
fallback is accepted for a requested feature.

The missing-notice `indicatif-log-bridge` dependency is removed from the manifest
and lockfile. A new, independently written `ProgressLogger` delegates `enabled`,
`log`, and `flush` through the public `log` API, suspending indicatif drawing while
records are written by the existing stdout `env_logger`. No external bridge
source was copied. Lockfile changes only remove that dependency and package;
no dependency versions are upgraded. The new lock SHA-256 is
`cfd832e2208962070263cb4f17a3ad4ebba6b18d9bec3a80a5a9f4dfcfac4d7b`.

`build-brush.sh` now defaults to revision 6; `--distribution-patch` selects it
explicitly. It verifies the actual target graph excludes `hex-slice`,
`indicatif-log-bridge`, and `rerun`, in addition to the existing LPIPS graph and
binary payload checks. The `brush-rerun` API crate itself remains in the graph.
Capabilities declare `rerun.available: false`; metadata records
`native_rerun_enabled: false` and `distribution_policy: optional_dependencies_excluded`.
The supported machine interfaces remain `metorigin_1` and `ply_request_ack_v1`.

```sh
scripts/macos/build-brush.sh --distribution-patch \
  target/macos-m4/brush-v6 target/macos-m4/brush-v6-build
```

The explicit `native-rerun` feature is for controlled research compilation only;
it reintroduces a dependency chain needing a completed notice audit before
redistribution. `embedded-lpips` remains independently default-off. The release
recipe never enables either feature, all features, or native MSL. Prior .3/.4/.5
sources, artifacts, and frozen packages remain available without modification.

Revision 6 is frozen at binary SHA-256
`45cf5e4a1226646d355183605f08c1469fa33fb465f1301bc30e0475185f37cb`
(75,008,296 bytes). The cumulative patch SHA-256 is
`1e342de3d80fc9ae3ac38873814b17b9bc6d8ce067159ad3eae02ef3148353d2`.
Its actual default target graph SHA-256 is
`f625b25b2c982c8776b445d69a9e581224df02ab37a8cf5b02b4713cb9aa5317`,
recorded in build metadata and carried beside the immutable binary under
`target/macos-m4/brush-artifacts/<SHA>/`.

- 30 Python recipe/preparation/distribution tests, 27 Rust unit tests, and
  Clippy with warnings denied passed. An explicit `native-rerun` feature compile
  passed separately without producing or replacing the distribution executable.
- Actual Metal contract: 11 checks, including both Rerun rejection paths,
  LPIPS validation, atomic checkpoints, warm start, export failure, and cancel.
- Baseline/live runs each completed 1000 steps. The live consumer validated and
  ACKed 89 frames; all eight protocol checks passed. Frames at iterations
  200/400/800/1000 exactly matched their same-iteration checkpoint hashes.
- The explicit Metal SH2, units-per-meter 1000 snapshot equivalence regression
  passed. This run's final live frame reached iteration 1000; the application
  still needs its validated final-checkpoint fallback for runs without a final
  requested/acknowledged live frame.

Evidence: `target/macos-m4/brush-v6-evidence/validation-progress.json`,
`brush-v6-contract/evidence.json`, and `brush-v6-live/evidence.json`.
