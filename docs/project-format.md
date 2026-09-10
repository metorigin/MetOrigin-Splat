# Project format

A MetOrigin Splat project is a **directory** whose name ends in `.splat-project`, not a single archive. It stores the project description, copied source material, intermediate results and final output together.

The format is currently Alpha. [project.schema.json](../schemas/project.schema.json), [domain types](../crates/splat-domain/src/project.rs) and [project persistence](../crates/splat-project/src/) define the implemented format. Do not infer persisted field names from frontend labels or from the separate preset-file format.

## Directory layout

```text
example.splat-project/
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

## Persistence and portability

Critical project state is written atomically, and locks prevent simultaneous execution against a project. Opening an interrupted project validates recorded state against the actual artifacts before allowing recovery. Do not manually edit state or remove lock files while a task is running.

Source material is copied into the project; the original input should remain unchanged. A project can contain large intermediates. Move or back up the whole directory with the task stopped, then reopen it through the application. Copying only `project.json` or `output/scene.ply` does not preserve the complete resumable project.

Recent-project records and application settings are separate from the project directory. Removing a recent entry does not delete the project files; permanent deletion is a distinct confirmed operation.

## Checkpoints, previews and outputs

A saved PLY checkpoint supports geometry recovery with its iteration, but does not contain the full Brush optimizer state. A live snapshot is temporary viewer data and is not a recovery checkpoint. Completed training requires a valid final result, not merely an existing partial checkpoint.

The final model is exported to `output/scene.ply`. The Gaussian viewer reads full model attributes; the sparse COLMAP viewer reads a different stage artifact. See [live-preview details](gaussian-live-preview.zh-CN.md) for accepted PLY formats and size limits.

SuperSplat saves the visible edited model directly to `output/scene.ply`, replacing its previous contents. Saving validates and syncs a temporary `.scene-<UUID>.tmp.ply` in the same output directory before renaming it over the model. Failed validation or replacement leaves the current model intact. Each successful save updates the editing session revision so subsequent saves can replace the same file. No history versions are generated or listed. Existing legacy `output/edited/` files are left on disk and ignored. The project schema, training checkpoints and training quality reports are unchanged; the displayed Gaussian count is read from the current PLY. PLY stores Gaussian geometry and appearance; save an `.ssproj` through SuperSplat when camera animation or other editor settings are needed.

Project directories, media, generated PLY files and raw logs are local data and should not be committed. The repository ignores `.splat-project` directories; schema fixtures and intentionally licensed small test inputs are maintained separately.
