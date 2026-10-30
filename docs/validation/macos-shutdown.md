# macOS task shutdown validation

## Native termination entry

Native validation found that handling Tauri `RunEvent::ExitRequested` alone was
insufficient: Muda 0.19.3 maps the predefined Quit item/Cmd-Q to AppKit
`terminate:`, while Tao 0.35.3 implements `applicationWillTerminate:` without an
`applicationShouldTerminate:` veto. The old path could exit the app and orphan
an engine before Tauri dispatched the application's safe-exit handler.

Startup now installs `applicationShouldTerminate:` on the existing delegate's
class. Native menu, Cmd-Q, and Dock termination requests return
`NSTerminateCancel` and dispatch the same async safe-exit flow. Only a completed
finalization and editor recheck authorize termination. The delegate instance
and its other callbacks are preserved; an unexpected existing termination
implementation fails startup rather than silently bypassing protection. The
FFI callback catches unwinds and defaults to cancelling termination.

Five lifecycle tests, including repeated native veto until authorization, pass.
The rebuilt development app and the `8656d4e0` release candidate subsequently
passed native Cmd-Q during training; the earlier failure remains recorded as a
failure. In the release candidate's 311-photo run, a 250 ms process sampler first
observed both application and Brush absent 0.50038 seconds after the request.
This is a sampled upper bound for that observation, not a general timing
guarantee. The project was durably paused, its lock released, and checkpoint
1,000 remained valid. Reopening and continuing warm-started at 1,000, completed
7,000, and produced a final PLY identical to the final checkpoint. See the
[build-specific native record](macos-native-ui.md). Dock Quit still lacks an
independent native observation.

## Ownership and exit contract

An accepted pipeline has a worker and an independent supervisor. The worker's
abort handle does not abort the supervisor. A worker panic or abort becomes a
failed project snapshot. The supervisor waits for this run's processes, output
readers, process logs, and background monitors before saving the final project
state and releasing its project lock.

The completion watch means the worker has joined. It is not proof of durable
completion. `ActivePipeline` remains installed until finalization succeeds;
pause/cancel and macOS quit retry that same finalization. Project-save or lock
release failures keep the owner, reject new pipelines, and keep the app open.
The final exit check also requires no pipeline, project creation, pending work,
or editor session. The editor recheck runs after background work drains.

`ProcessScope` owns only the handles launched within one run. Direct awaited
FFprobe, FFmpeg, COLMAP, Brush, and training-preparation runner calls inherit
that scope. Tokio task locals do not propagate through ordinary `tokio::spawn`;
the orchestrator progress forwarder and Brush checkpoint monitor explicitly
use `spawn_scoped`. It propagates ownership and retains stop receipts. The
desktop event forwarder drains queued events after the worker joins.

Cleanup keeps process lifecycle join receipts in shared storage and awaits them
by reference. Cancelling a quit waiter or reaching its 30-second deadline does
not detach cleanup or erase a pending save. Unix process-group guards remain in
place. Windows taskkill behavior is unchanged.

The stream reader limits each raw input chunk to 64 KiB before decoding, so a malformed
engine producing no newline cannot grow its read buffer indefinitely. Capture
limits still fail the probe rather than accepting truncated version output.
Synchronous probes keep a ten-second default execution deadline; only macOS
COLMAP's `-h` version/validation/discovery probes select a 45-second single
attempt. The custom deadline still uses the same 64 KiB capture cap, scope drain
and failed-cleanup registry. It adds no retry and does not alter Windows or the
application quit waiter's separate deadline. See the
[first-path timing evidence](macos-m3-resources.md) for this exception.

## Automated checks

### Reopening after an interrupted application

The normal open/start entry points acquire the atomic project lock before
checkpoint-restore recovery or project state writes. A stale `Starting`,
`Running`, `Pausing`, `Cancelling`, or `Recovering` project is normalized to
`Paused` with recovered stage state and recomputed progress. Checkpoints remain
in place. Pipeline admission transfers that same guard to the orchestrator
before writing `Starting`; supervision retains it through durable finalization.

Opening this application's own active project is a read-only view. Another
active application or a held kernel guard rejects admission without changing
the project. Legacy orphan Brush, COLMAP, FFmpeg, or FFprobe processes whose
command arguments or working directory point into the project also reject
recovery, including the legacy `brush_live` companion. Unreadable engine
ownership fields fail conservatively. Identification uses these engine names;
arbitrarily renamed external engines are outside that legacy scan. This process
snapshot supplements the lock; it is not a general process-tree cleanup proof
and never terminates an observed process.

Eight focused recovery tests passed, including real child observation and
normal-open recovery after an exited legacy owner. The desktop pipeline suite
passed 17 tests, including read-only live reopening and admission-lock ownership
after worker abort; all 134 pipeline tests passed. Later native stale-project
recovery, explicit checkpoint restoration, and post-quit warm-start observations
are recorded separately with their exact application hashes in the
[native UI record](macos-native-ui.md); they are not inferred from unit results.

Regression coverage includes:

- Worker panic and abort persist `Failed`, clear the active run, and release the
  lock only after cleanup.
- Real child cleanup after abort, cancellation of a cleanup waiter followed by
  successful retry, log output available after cleanup, and an unrelated child
  remaining alive.
- A process launched from a scoped background task is cleaned up after its
  primary worker panics.
- Repeated control/exit attempts cannot bypass a failed final project save.
  Restoring project access allows the same finalization to complete.
- Paused/cancelled state is durable, and failure to remove the project lock
  retains ownership until removal can be retried.
- Successful completion re-saves the final snapshot when the restored project
  file contains an older state.
- Newline-free output remains bounded, and a real overproducing process is
  cancelled without waiting for a newline.

Run with the repository's configured Rust environment:

```sh
cargo test --locked --offline -p splat-process -p splat-pipeline -p splat-desktop --lib
cargo clippy --locked --offline -p splat-process -p splat-pipeline -p splat-desktop --all-targets -- -D warnings
```

Local evidence is under `target/macos-m3/shutdown-evidence/`. Host GPU/resource
and native idle-sleep assertion tests remain explicit opt-in tests. No test in
this shutdown suite forces the host to sleep.

The recorded combined run passed 85 desktop, 114 pipeline, and 52 process tests
(251 total; two explicit desktop host tests ignored). The process count includes
the bounded synchronous probe regressions. Clippy passed with warnings denied.
This run was on macOS; Windows native behavior was not exercised.

After atomic admission, interrupted-project recovery, and cleanup-error receipt
integration were frozen, the final application workspace gates passed: 666 tests
passed, 0 failed, and 12 explicit host/real-engine tests were ignored across 16
test harnesses. `cargo fmt --all -- --check` and workspace all-targets,
all-features Clippy with warnings denied also passed. Logs, per-harness counts,
and hashes of the 123 tested Rust/Cargo source files are recorded under
`target/macos-m3/final-gates/`; none of those source files changed during the
gates. These automated results do not substitute for rebuilt native UI tests.
The later source gates, including COLMAP progress and CPU interval-sampling
fixes, passed 697 tests with 14 environment-specific tests ignored; frontend
gates passed 189 tests. Their frozen evidence is under
`target/macos-m4/final-gates-20261027/`. These newer totals do not rewrite the
historical run above or claim that every ignored native test has been executed.

## Limits

These guarantees cover normal quit, cancellation, Rust task abort, and unwind
panics while the application runtime is alive. Forced application termination,
SIGKILL, power loss, and an aborting process-wide panic cannot run async cleanup
or guarantee a new checkpoint. Existing validated checkpoints remain the
recovery boundary. The optional idle-sleep assertion does not prevent manual
sleep, lid-close sleep, low-battery shutdown, or force quit.

## 2026-10-27: native SIGKILL, orphan admission and recovery

This scoped run used the packaged `4e763b5864705fd0c91fa5a63a547cb4119552e4a6c9a6113f017ba40a17ef3d`
application on the same Apple M1 Pro / 32 GiB / macOS 27.0.1 development host.
The dedicated Objectron119 project was
`01a17d49-2341-7603-a9d0-a24a6655fb8b`. Its first complete run was frozen in
419 files before native checkpoint restoration to iteration 1,000. That
restoration preserved the original checkpoints above 1,000 and four published
training/output files in a separate eight-file archive. The subsequent run
`01a17d59-0289-72c3-a30d-f589203bc8d5` really started from 1,000 with optimizer
reset, as shown by its exact Brush argv and progress events.

The controlled capture at 12:32:44 UTC bound application PID 79115 and Brush
PID/PGID 83364 by executable hash/path, complete argv, UID, microsecond process
birth time and the original parent chain. Both the retained 500 and 1,000
checkpoints passed complete PLY inspection and were frozen. The application-only
SIGKILL was sent at 12:33:29; by then the last persisted checkpoint progress was
1,500 and the last logged live frame was iteration 1,749. This does not claim
that the crash occurred exactly at iteration 1,000. A separately persisted
signal receipt and launcher exit `-9` confirm delivery. The helper's following
process observation failed while the application was exiting; that tooling
failure remains recorded and does not mean the signal was never sent.

Brush survived and was reparented to PID 1. A later read-only observation still
matched its original birth, path, argv and private PGID. Native relaunch as PID
83617 refused to open the project while that exact orphan remained active,
displaying its PID and explaining that checkpoints were preserved. The project
JSON values remained unchanged between the pre-kill observation and the
post-orphan snapshot. The later cleanup attempt at 12:35:22 found both original
identities absent and the group empty, so it sent **no TERM or KILL**. This run
therefore validates orphan admission protection and recovery after exit; it
does not demonstrate successful forced process-group cleanup.

Reopening after the orphan exited persisted `Paused`, cleared both current-stage
fields and marked the interrupted training stage failed with a recovery message.
Six checkpoint identities were recorded before continuing. A target-named
3,000 file existed, but the training fingerprint had no completion receipt.
Production selection deliberately takes the highest complete checkpoint
strictly below the target, so the final run
`01a17d5c-d081-7061-8e66-8ea6e899485c` selected **2,500 and trained to 3,000**.
The selected 2,500 PLY still matches its pre-continue hash; independent parsing,
the `init.ply` load log, live iteration 2,508, and the result all confirm geometry
warm start with optimizer reset. The Brush process took 67,039 ms. The orphan's
3,000 file was subsequently replaced; only its earlier size/hash survives, so
its complete payload is not independently certified here.

The final checkpoint and `scene.ply` contain **614,263 Gaussians**, SH0,
34,399,227 bytes, SHA-256
`c9e297ae96d27bcef2aae910d451b56d5fdb9dae0e06bdf8ba72188510bcd97d`.
All 8,599,682 floating properties are finite; result, completion, validation and
output manifest agree. Training and the three downstream stages have new
started/completed events, while all 391 source/upstream files and the eight
original archived files remain byte-identical. All twelve stages are completed,
the project lock is released, recovery journals and temporary `init.ply` are
absent, and `.lock.guard` remains present. The 419-file fresh
snapshot is also unchanged.

Independent visual review confirms the orphan refusal, paused state, a real
2,917-step live view, and final rendering of 614,263 Gaussians without a live-step
label. The final viewer updated at local 20:37:51; the checkpoint sidebar still
correctly labels its latest checkpoint as 3,000 steps. At 12:39:31 UTC the
recovered application exited normally after native Command-Q, with exit code 0
and `remaining_known=[]`.

The [run summary](../../target/macos-m4/native-abnormal-recovery-20261027/abnormal-audit/run-summary-final.json)
binds the exact app, three runs, process receipts and final outputs. The
[independent audit](../../target/macos-m4/native-abnormal-recovery-20261027/abnormal-audit/audit-result-attempt02.json)
passed 10,764 checks and rehashed 1,326 bound evidence files; final metadata and
the selected/final PLYs were copied into its `frozen-attempt02/` directory.
Earlier tooling failures are retained: an oversized process-argument buffer,
a relaunch control missing its allow-profile before app launch, and the first
audit's overbroad search for `step` anywhere in the accessibility tree. The
corrected checks do not alter the original evidence.

This observation is limited to a forced application exit followed by native
admission and geometry recovery on this host. It provides no new guarantee for
power loss, an optimizer-state resume, automatic cleanup after SIGKILL, XPC or
system-wide network isolation, clean-host installation, macOS 15, an actual
16 GiB machine, or Windows. No application source was changed for this test.
