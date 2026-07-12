# Repository Audit

**Date**: 2026-07-12
**Author**: Initial audit

## Current State

The repository `metorigin/splat` is at its initial state with a single commit.

### Files Present

```
README.md                       # 1 line, placeholder only
MetOrigin-Splat.md              # Master development plan (~3000 lines)
```

### Git State

- **Default branch**: `main`
- **Commits**: 1 (`a3ad73e` — "first commit")
- **Status**: No code, no configuration, no CI

### What's Missing vs. Plan

The project plan (MetOrigin-Splat.md) defines a comprehensive structure. None of it has been implemented yet:

| Category | Planned | Present |
| -------- | ------- | ------- |
| README   | Full project overview | Placeholder only |
| README.zh-CN | Chinese version | Missing |
| Rust workspace | Multi-crate workspace | Missing |
| Tauri app | `apps/desktop/` | Missing |
| Frontend | React + TypeScript + Vite | Missing |
| Domain crate | `splat-domain` | Missing |
| Project crate | `splat-project` | Missing |
| Process crate | `splat-process` | Missing |
| Pipeline crate | `splat-pipeline` | Missing |
| Hardware crate | `splat-hardware` | Missing |
| Engine adapters | FFmpeg / COLMAP / Brush | Missing |
| JSON schemas | project / event / preset | Missing |
| Presets | fast / balanced / quality | Missing |
| CI | GitHub Actions | Missing |
| Tests | unit / integration / e2e | Missing |
| Documentation | architecture / dev / project-format / etc | Missing (being created) |
| License | TBD | Missing |
| Community files | CONTRIBUTING / CODE_OF_CONDUCT / SECURITY | Missing |
| GitHub config | Issue/PR templates | Missing |
| Scripts | build / packaging | Missing |

## Recommendations

### Immediate (Phase 0-1)

1. Complete documentation split (in progress)
2. Initialize Rust workspace with empty crates
3. Initialize Tauri + React + TypeScript frontend
4. Create `splat-domain` with core types
5. Establish CI pipeline
6. Choose and add license
7. Add community health files (CONTRIBUTING, CODE_OF_CONDUCT, SECURITY)
8. Create `.github` issue/PR templates

### Short-term (Phase 2-4)

9. Implement `splat-project` — project CRUD, serialization, migration
10. Implement `splat-process` — process runner with cancellation
11. Implement `splat-engine-ffmpeg` — video metadata + frame extraction
12. Begin COLMAP integration

### Risks

- All external engine licenses need verification before distribution
- Rust + Tauri + Windows development environment needs validation
- Brush CLI stability unknown — version must be pinned and documented early
