# Project format

Explicit checkpoint restoration records a schema-1 intent in `training/checkpoint-restore.json` before changing any checkpoint. The intent binds the selected file hash, iteration, original training fingerprint and archive ID. Later checkpoints move to `runtime/checkpoint-restores/<id>/`. The previous `training/result.json`, `training/validation.json`, `output/scene.ply` and `output/manifest.json` move into corresponding subdirectories of the same archive. Removing these active cache files is necessary: resetting stage status alone would let export reuse the old PLY after a successful warm start. The selected checkpoint and original media remain intact; old published results remain recoverable in the archive. Restoration revokes the completed-run proof while retaining the fingerprint, so compatible training resumes geometry with a fresh optimizer. Opening or starting a project finishes an interrupted intent under the project lock. Unsupported metadata versions, ambiguous same-iteration files, changed hashes, symbolic links and a selection at or after the recorded target fail without authorizing warm start. See the [schema](../schemas/checkpoint-restore.schema.json) and [accepted/rejected examples](../schemas/examples/checkpoint-restore/).

A MetOrigin Splat project is a **directory** containing `project.json`. New projects use the chosen project name as the folder name, without an added extension. Existing `.splat-project` folders remain supported at their current paths. The directory stores the project description, copied source material, intermediate results and final output together.

The format is currently Alpha. [project.schema.json](../schemas/project.schema.json), [domain types](../crates/splat-domain/src/project.rs) and [project persistence](../crates/splat-project/src/) define the implemented format. Do not infer persisted field names from frontend labels or from the separate preset-file format.

## Directory layout

```text
example/
├── .gitignore                # Keeps local project data out of surrounding Git repositories
├── project.json
├── source/                   # Copied source video or images
├── frames/
│   └── frames.json           # Prepared-frame manifest
├── processed/                # Images after preprocessing
├── colmap/
│   ├── database.db
│   ├── sparse/               # One or more reconstructed models
│   └── result.json           # Selected model and reconstruction result
├── training/
│   ├── config/
│   ├── dataset/              # Prepared training dataset
│   ├── checkpoints/          # Saved PLY recovery checkpoints
│   ├── live-preview/         # Temporary, session-scoped viewer snapshots
│   └── result.json
├── output/
│   ├── scene.ply             # Final exported Gaussian model
│   └── manifest.json         # Output and preview metadata
├── cache/
├── runtime/                  # Optional versioned run evidence and preserved prior artifacts
│   └── execution-profile.json
└── logs/
```

Files appear when the corresponding stage produces them. A newly created or interrupted project will not contain every file shown. Standard paths are centralized in [paths.rs](../crates/splat-project/src/paths.rs). Lock and temporary persistence files are managed by the application.

## `project.json`

Persisted project fields use **snake_case**:

| Field | Meaning |
| --- | --- |
| `schema_version` | Schema version, currently `1` |
| `id` | Project UUID |
| `name` | Display name |
| `created_at`, `updated_at` | Timestamps |
| `source` | `null` or a tagged `Video` / `ImageFolder` source |
| `settings` | Preset ID and project reconstruction settings |
| `status` | Lowercase lifecycle status |
| `current_stage` | Backend stage identifier or `null` |
| `pipeline_state` | Persisted per-stage execution and recovery state |

The [valid example](../schemas/examples/project.valid.json) is a minimal schema fixture. Settings omitted from a minimal/older record are handled by the typed defaults and migration logic; use the application to write full project records.

Source tags use the field `type`, with values `Video` or `ImageFolder`. Video records include `filename` and `copied_to_project`. Image-folder records include `folder_name`, `image_count` and `copied_to_project`.

Project statuses include `creating`, `starting`, `ready`, `running`, `pausing`, `paused`, `cancelling`, `cancelled`, `recovering`, `completed` and `failed`. Backend stage identifiers retain their enum spelling, such as `BrushTraining`. They are listed in [architecture](architecture.md).

The standalone JSON files under [presets](../presets/) have their own schema and camelCase parameter groups such as `frameExtraction`; those names should not be copied into `project.json` settings.

## Runtime execution profile

macOS runs freeze [execution-profile schema 1](../schemas/execution-profile.schema.json) in `runtime/execution-profile.json`, independently of `project.json` version 1. The snapshot records run UUID, OS/architecture, engine versions and executable hashes, explicit COLMAP CPU settings, actual Brush Metal compute evidence, effective training limits, and negotiated live/resume modes. A supported Mac probe requires real Gaussian rendering and backward computation with finite output and nonzero gradients. Windows 0.3 retains its existing driver check and preset behavior; it does not acquire inferred Metal or Vulkan evidence.

Missing runtime evidence is valid for legacy projects and is never invented while opening them. Future or corrupt runtime schemas remain untouched and block a new run; they do not make `project.json` unreadable. Snapshots use a unique same-directory temporary file, flush/sync and atomic replacement. Engine or effective-setting changes invalidate affected cached stages. Each stage also validates its own input/output fingerprints; an old `Completed` state alone cannot authorize reuse.

macOS resource limits leave shared Windows presets unchanged. Requested presets remain in project settings, while the preflight displays the effective steps, SH degree, training resolution, image-cache limit, maximum splats and loader threads. Memory budgets are policy limits, not OS-enforced allocations or measured peak usage. See [training provenance](validation/training-provenance.md) for checkpoint fingerprints, interrupted writes and prior-artifact preservation.

The opt-in Windows Brush 1 candidate also uses schema 1, extending existing field combinations without changing Mac or Windows 0.3 meanings. It requires the paired `1.0.0+metorigin-windows.1` build, explicit DX12/Vulkan compute evidence and stable device ID, dedicated-memory accounting and explicit limits, LOD=0, CUDA feature extraction/matching and CPU global positioning/BA. Its device ID participates in training fingerprints. An older application may reject this Windows1 combination; cross-platform opening requires an updated reader. New readers preserve the existing Mac/legacy fixtures. Unknown/future profiles remain rejected without rewriting their files, and `project.json` stays at version 1. PLY warm start resets optimizer state; changing engines is a new training attempt, not continuous optimizer recovery. See [candidate evidence and remaining gates](validation/windows-alignment.md).

## Persistence and portability

Critical project state is written atomically, and locks prevent simultaneous execution against a project. Opening an interrupted project validates recorded state against the actual artifacts before allowing recovery. Do not manually edit state or remove lock files while a task is running.

The application holds a kernel file lock on the persistent `.lock.guard` file for the whole operation. This empty coordination file remains after release and must not be deleted while any application instance is using the project. The separate `.lock` file contains the owner's PID, start time and stage; it is created exclusively and removed when that owner releases it. Stale-owner reclamation is serialized by the kernel lock and uses bounded retries. Symbolic links, hard-linked lock files on Unix, corrupt metadata and changed ownership fail closed instead of being overwritten.

A legacy application that only writes `.lock` remains protected while its PID is alive. Permission failures or an inconclusive process probe are treated as an active owner; only confirmed absence allows automatic reclamation. `force_unlock` obtains the same kernel lock and refuses both a current active operation and a live legacy owner. It is an explicit cleanup path for inactive metadata, not a way to stop training. A process crash releases the kernel lock automatically; owner metadata may remain for safe recovery on the next acquisition.


Source material is copied into the project; the original input should remain unchanged. A project can contain large intermediates. Move or back up the whole directory with the task stopped, then reopen it through the application. Copying only `project.json` or `output/scene.ply` does not preserve the complete resumable project.

Recent-project records and application settings are separate from the project directory. Removing a recent entry does not delete the project files; permanent deletion is a distinct confirmed operation.

## Checkpoints, previews and outputs

A saved PLY checkpoint supports geometry recovery with its iteration, but does not contain the full Brush optimizer state. A live snapshot is temporary viewer data and is not a recovery checkpoint. Completed training requires a valid final result, not merely an existing partial checkpoint.

The final model is exported to `output/scene.ply`. The Gaussian viewer reads full model attributes; the sparse COLMAP viewer reads a different stage artifact. See [live-preview details](gaussian-live-preview.zh-CN.md) for accepted PLY formats and size limits.

SuperSplat saves the visible edited model directly to `output/scene.ply`, replacing its previous contents. Saving validates and syncs a temporary `.scene-<UUID>.tmp.ply` in the same output directory before renaming it over the model. Failed validation or replacement leaves the current model intact. Each successful save updates the editing session revision so subsequent saves can replace the same file. No history versions are generated or listed. Existing legacy `output/edited/` files are left on disk and ignored. The project schema, training checkpoints and training quality reports are unchanged; the displayed Gaussian count is read from the current PLY. PLY stores Gaussian geometry and appearance; save an `.ssproj` through SuperSplat when camera animation or other editor settings are needed.

Project directories, media, generated PLY files and raw logs are local data and should not be committed. New projects include a local `.gitignore` that ignores their contents; the repository also retains its legacy `.splat-project` ignore rules. Schema fixtures and intentionally licensed small test inputs are maintained separately.
