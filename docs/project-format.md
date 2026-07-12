# Project Format

## Overview

The project is the single source of truth in MetaOrigin Splat. All business state is stored in a project directory on disk. The UI reads from and writes to the project through the core layer; it never maintains independent business state.

## Project Directory Structure

```
example.splat-project/
├── project.json          # Core project metadata & stage state
├── source/               # Original input media
│   └── input.mp4
├── frames/               # Extracted video frames
├── processed/            # Preprocessed images
├── colmap/               # COLMAP output
│   ├── database.db
│   ├── sparse/
│   └── logs/
├── training/             # Training artifacts
│   ├── checkpoints/
│   ├── config/
│   └── logs/
├── output/               # Final deliverables
│   ├── scene.ply
│   └── manifest.json
├── cache/                # Temporary/cached data
└── logs/                 # Application and engine logs
```

## `project.json` Schema

### Fields

| Field           | Type     | Description                                    |
| --------------- | -------- | ---------------------------------------------- |
| schemaVersion   | number   | Schema version for migration support           |
| id              | UUID     | Unique project identifier (UUID v7)            |
| name            | string   | Human-readable project name                    |
| createdAt       | datetime | ISO 8601 creation timestamp                    |
| updatedAt       | datetime | ISO 8601 last update timestamp                 |
| source          | object   | Source media metadata                          |
| preset          | string   | Training preset ID (fast / balanced / quality)  |
| status          | string   | Project lifecycle status                       |
| currentStage    | string   | ID of the currently active stage               |
| stages          | object   | Map of stage ID → stage state                  |

### Example

```json
{
  "schemaVersion": 1,
  "id": "0194f6b3-9c35-7b21-92e8-bf0ef22d8a11",
  "name": "museum-room",
  "createdAt": "2026-07-12T12:00:00Z",
  "updatedAt": "2026-07-12T12:30:00Z",
  "source": {
    "type": "video",
    "originalPath": "source/input.mp4"
  },
  "preset": "balanced",
  "status": "running",
  "currentStage": "colmap_mapping",
  "stages": {
    "media_validation": {
      "status": "completed",
      "progress": 1.0
    },
    "frame_extraction": {
      "status": "completed",
      "progress": 1.0
    },
    "colmap_feature_extraction": {
      "status": "completed",
      "progress": 1.0
    },
    "colmap_matching": {
      "status": "completed",
      "progress": 1.0
    },
    "colmap_mapping": {
      "status": "running",
      "progress": 0.46
    }
  }
}
```

## Save Semantics

- Stage completion triggers an atomic project state write
- Use write-to-temp → flush → atomic-replace pattern
- Never overwrite `project.json` in place (risk of corruption)
- Always preserve the previous valid state until the new one is fully written

## Path Conventions

- All internal project paths are relative to the project root
- External source files may record: original absolute path, whether copied into project, and current accessibility
- Never rely solely on absolute paths

## Version Migration

- `schemaVersion` enables future format evolution
- A migration mechanism must be prepared from the start
- Future versions may add, remove, or restructure fields
- Migration runs on project open if schema version differs

## Project Manager (`splat-project`)

### Responsibilities

- Create project (initialize directory structure + project.json)
- Open existing project (validate, migrate if needed)
- Validate project integrity
- Save project (atomic write)
- Project version migration
- Path management
- Cache cleanup
- Disk usage statistics
