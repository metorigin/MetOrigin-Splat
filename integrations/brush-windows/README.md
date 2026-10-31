# Windows Brush 1 candidate

The Windows engine uses Brush commit
`1388f74c6fe0236f68ee4915564bf00e9d2e3747`, followed by the unchanged cumulative
`metorigin-macos.6.patch`, **then** `patches/metorigin-windows.1.patch`.
The Windows patch is a delta against the Mac-integrated tree; it cannot be
applied directly to stock Brush. Mac builds do not apply this delta.
[source-lock.json](source-lock.json) pins both patches, Cargo.lock, the combined
source diff, Rust 1.95.0, the Windows MSVC target and DXC archive/file hashes.

```powershell
scripts/windows/Build-BrushRuntime.ps1 -SourceRepository ../brush -Offline
scripts/windows/Build-BrushRuntime.ps1 -Verify
```

The builder makes a detached clone under `target/windows-brush/<cache-key>/source`;
the supplied repository and its branches are read-only inputs. The default
artifact is `target/windows-brush/runtime`, with `bin/brush-cli.exe`, shader
compiler DLLs, original DXC notices, machine/version/help output, target
dependency graph, lockfile, Brush license and `BUILD-INFO.json`. Cache reuse
checks every listed file, the inventory, compiler/source inputs and actual
machine identity. A partial staging directory is never a usable artifact. The
OS releases the build lock after interruption; existing outputs are never
silently overwritten. A damaged cache fails explicitly. Offline mode requires
both local locked Cargo dependencies and the checksum-pinned DXC archive in
`target/windows-brush/downloads/`.

## Machine and adapter contract

The identity is `1.0.0+metorigin-windows.1`, target
`x86_64-pc-windows-msvc`, CLI `metorigin_1`. It retains the Mac integration's
checkpoint, PLY warm start, CLI token provenance, loader limit, request/ACK live
bridge, and excluded optional-dependency policies. It additionally advertises
`backend_device_selection`.

The rebuilt Windows1 desktop caller uses DX12 by default when
`METORIGIN_BRUSH_BACKEND` is absent; ordinary installed-app startup needs no
environment configuration. `METORIGIN_BRUSH_BACKEND=dx12|vulkan` and
`METORIGIN_BRUSH_DEVICE_ID` are advanced optional overrides. The application
passes the selected API explicitly to the engine's real compute probe and pins
the returned canonical device for training. The direct CLI contract below still
uses explicit backend/device flags. The legacy Windows 0.3 and Mac paths keep
their existing behavior. Older application artifacts retain their historical
startup requirements until rebuilt; the engine binary itself is unchanged.

```powershell
brush-cli.exe --capabilities-json
brush-cli.exe --probe-json --graphics-backend dx12
brush-cli.exe --probe-json --graphics-backend vulkan
brush-cli.exe DATASET --graphics-backend dx12 --graphics-device ID_FROM_PROBE <training flags>
```

`--graphics-backend` accepts only `dx12` or `vulkan`. Initial probe may omit the
device selector and chooses a discrete adapter on that API. Training requires
the exact `device_id` emitted by a successful probe. A canonical ID is
`<backend>:<vendor-8hex>:<device-8hex>:<UTF8-name-bytes-hex>`. Reordering adapters
does not change this identity; identical adapters without a distinct identity
are rejected as ambiguous. NVIDIA indices are never used as WGPU indices.

Probe and training call the same selector. It resolves a WGPU adapter to the
per-device-type CubeCL index, pins the API, verifies the actual initialized
adapter again and gives the returned `ProcessDevice` to the trainer. Missing,
changed, unsupported or ambiguous devices fail; training never switches API.
The probe retains the actual eight-Gaussian 32×32 forward/backward calculation,
and reports the canonical `device_id` plus `device_type: DiscreteGpu`.

DX12 needs the packaged DXC compiler. Actual testing found that WGPU's FXC
fallback can initialize but fails the subgroup sort kernel during training.
The selector now rejects adapters without subgroup support before compute or
training. The pinned official DXC v1.8.2502 DLLs reside beside the executable;
the test/development shell does not need a system PATH modification.

## Native tests and evidence

```powershell
python -X utf8 scripts/windows/test_build_brush_runtime.py
python -X utf8 scripts/windows/check_brush_runtime.py `
  --brush target/windows-brush/runtime/bin/brush-cli.exe `
  --build-info target/windows-brush/runtime/BUILD-INFO.json `
  --backend dx12 --dataset NORMALIZED_FIXTURE --output FRESH_EVIDENCE
```

The real CLI harness verifies probe identity/binding, 300-step training, complete
finite Gaussian PLY, warm start, budget rejection, export failure, live requests
and ACKs, expired/wrong-session demand, off mode, two-frame retention, forced
termination and recovery. `--iterations 3000` supplies a longer independent run;
`--probe-only` needs no dataset. Evidence always records the actual binary hash
and raw output, including a failed result. Existing evidence is never overwritten.
The dataset is copied before warm-start and cancellation tests.

`scripts/windows/Test-AlignmentDefaultRuntime.ps1` is a separate opt-in check of
the application's ordinary Windows1 preflight. It calls the actual production
Rust entry with both backend/device environment variables absent and expects a
successful DX12 eight-Gaussian forward/backward probe. It needs no dataset or UI,
does not train, and preserves a fresh test-binary/probe/launcher receipt. This
validates application selection rather than assuming a direct CLI invocation
with an explicitly supplied backend proves the application's default.

The Windows delta also includes native NTFS tests for replacing a checkpoint
while a shared reader holds the old file, rejecting an exclusive reader while
preserving the old complete model, partial writes, interrupted writes and
unpublished stale temporary files. The Unix directory-sync path is unchanged.

The explicit ignored snapshot test accepts `METORIGIN_BRUSH_TEST_BACKEND` as
`dx12`/`vulkan` and `METORIGIN_BRUSH_TEST_DATASET`. It proves that the same
iteration's SH2, units-per-meter=1000 live snapshot and official checkpoint are
byte-identical; it is separate from the ordinary no-GPU test suite.

2026-10-30 validation on the RTX 5080 Laptop GPU (driver 592.01):

| Check | Result |
| --- | --- |
| Rust CLI/process unit tests | 29 passed; two real-GPU tests intentionally ignored in ordinary suite |
| Engine formatting and Clippy including tests, warnings denied | Passed |
| Source preparation, interruption resume, cache corruption, DXC/offline and OS-lock tests | 9 passed |
| Final release build and offline cache verification | Passed; binary SHA-256 `4398eeabd0cc4becaf5d82fb81b76dfd377b791b7bd7251b0e2b7ca8fe7e4001` |
| DX12 300-step CLI contract | Passed; 43,497 finite SH0 Gaussians, four ACKed live frames |
| Vulkan 300-step CLI contract | Passed; 43,460 finite SH0 Gaussians, four ACKed live frames |
| DX12 3,000-step CLI contract | Passed; 125,774 finite SH0 Gaussians, four ACKed live frames |
| Same-iteration SH2/unit-scale snapshot test | Passed on both DX12 with DXC and Vulkan in the development native test binary |

The three final CLI runs used the same frozen release binary and packaged DXC,
960-pixel images, 300,000 splat bound, 512 MiB image cache, two loader threads,
LOD=0, and the fixed 40-photo James CC0 fixture normalized by COLMAP 4.1.
Wall times for their training commands were 7.142 s, 6.880 s and 40.326 s; these
warmed local observations are not cross-machine performance guarantees. Every
run also passed bound-device reprobe, wrong-device rejection, warm start,
over-budget refusal, export failure, stale-session/expired/stale-ACK/off request
checks, frame retention, forced-stop checkpoint preservation and subsequent
checkpoint warm-start recovery.

Ignored local evidence is under `target/windows-brush/final-dx12-300/`,
`final-vulkan-300/`, `final-dx12-3000/` (`evidence.json`, machine JSON, argv and
logs), plus `native-unit-tests.log`, `dx12-snapshot-dxc.log` and
`vulkan-snapshot.log`. An earlier preliminary run's ACK/off test harness race
is retained as failed evidence; the corrected final runs are separate. A real
app-wide GPU/RAM peak measurement, sleep/resume and native macOS acceptance are
not established by these CLI tests.

`scripts/windows/Test-BrushDirectoryAcl.ps1` also passed a native denied-directory
test with the final binary. It creates only a fresh
`target/windows-brush/acl-<UUID>` test tree, saves the original directory security
descriptor, denies only the current SID's file/directory creation rights on its
export child, and independently verifies that CreateNew fails. Actual Brush
export then exits 1 with access denied while the preceding 36,515-Gaussian PLY
remains valid and byte-identical. The `finally` block restores the original
DACL/owner/group, verifies restored write access, removes its sentinel and waits
for all owned subprocesses. Evidence is in
`target/windows-brush/acl-dc43e9b8-7763-47cf-afb1-fa00027bec78/evidence.json`.

The application runner now uses a separate unnamed Windows Job Object for each
engine. It starts the child suspended, establishes kill-on-close ownership
before resuming the sole verified primary thread, and refuses assignment
failure. Ordinary descendants cannot break away. Cancellation, timeout and a
leader exiting early terminate the owned job and verify its active process
count reaches zero before output completion. If Windows forcibly terminates the
application, closing its non-inherited job handles kills outstanding engines and
synchronous probe descendants. No PID-name sweep or system-wide job is used;
Unix process-group code retains its existing path.

The native Windows process suite passed 44 tests, including job cancellation
with an unrelated writer still alive, bounded timeout, a leader leaving pipe
owners behind, forced application owner termination for both asynchronous
engines and synchronous probes, and assignment failure with no executed child
instruction. Three ignored tests are helper subprocess entry points explicitly
invoked by those tests. Test cleanup retains exact fixture process handles and
verifies their creation timestamps; it never kills an unrelated reused PID.
Evidence: `target/windows-brush/windows-process-unit-final.log` and
`windows-job-tests.log`. These native process tests do not replace the desktop's
editor-save, persisted project-state or forced-reopen acceptance checks.

This is a candidate runtime. A source/build/hash check is separate from GPU,
native application, installation and Mac regression acceptance. Build metadata
does not mark the candidate distribution-approved: the complete Windows target
dependency notice audit and applicable DXC redistribution terms still need their
release review. Original Microsoft MIT, LLVM and Microsoft binary terms travel
with DXC. No user media, binaries, model weights or local logs are committed.
