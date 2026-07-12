# Release Process

## Version Plan

### v0.1.0-alpha

**Goal**: Internal and early testers can run the full pipeline.

**Includes**:
- Video import
- FFmpeg frame extraction
- COLMAP SfM
- Brush training
- Basic training page
- PLY output

**Not promised**:
- Broad GPU compatibility
- Stable recovery
- Auto-update
- Full viewer

### v0.2.0-beta

- Project recovery
- GPU detection
- Error diagnostics
- Full installer
- Basic result preview
- More tested GPU configurations

### v0.3.0

- Embedded viewer
- More export formats
- Project disk management
- Improved presets
- Basic i18n support

### v1.0.0

**Conditions**:
- Stable on mainstream Windows configurations
- Core pipeline success rate meets target
- Recovery is reliable
- Documentation is complete
- Install/uninstall is stable
- Engine licenses and distribution terms are clear

## Release Workflow

Triggered by Git tag:

```
v0.1.0
```

### Steps

1. **Version validation**: Confirm tag matches version in Cargo.toml and package.json
2. **Changelog generation**: Collect changes since last release
3. **Build installer**: `cargo tauri build` → `.exe`
4. **Build portable**: Zip the release build directory
5. **Checksums**: Generate SHA-256 for all distributable files
6. **GitHub Release**: Upload artifacts, attach third-party license bundle
7. **Mark version**: Pre-release for alpha/beta, full release for stable

### Release Artifacts

```text
Splat-Setup-x.y.z.exe    # Windows installer
Splat-Portable-x.y.z.zip  # Windows portable build
SHA256SUMS                # Checksum file
THIRD_PARTY_NOTICES       # Third-party license texts
Release Notes             # Changelog for this version
```

## Branch Strategy

```text
main         — Always buildable, release from here
feature/*    — New features
fix/*        — Bug fixes
docs/*       — Documentation
release/*    — Release preparation
```

Rules:
- No long-lived `develop` branch initially (reduces process overhead)
- Every change goes through a PR
- Use squash merge
- Commit messages follow Conventional Commits

### Commit Examples

```
feat(pipeline): add resumable stage execution
fix(colmap): handle paths containing non-ascii characters
docs: add Windows development guide
```

## Engine Distribution

- Application binary and engine packs are distributed separately
- First run: download engines or use bundled full pack
- Engine versions are pinned and checksum-verified
- License texts included per engine
