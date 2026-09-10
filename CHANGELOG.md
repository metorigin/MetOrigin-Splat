# Changelog

All notable changes to MetOrigin Splat will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and future public releases will follow [Semantic Versioning](https://semver.org/) where practical during Alpha development.

## [Unreleased]

## [0.1.0-alpha.3] - 2026-09-10

### Added

- English and Simplified Chinese UI, persisted language selection and automatic system-language detection with English fallback.
- Localized user-facing diagnostics, native dialogs and live SuperSplat language switching without discarding editor state.
- English user guide and translation contribution documentation.

## Earlier Alpha development

### Added

- Public contribution and security guidance.
- Pull request and issue templates.
- A unified project workspace with a searchable sidebar, a three-step creation wizard, theme settings and keyboard/focus handling for interactive surfaces.
- Full Gaussian rendering and a demand-driven Brush companion for viewing model updates during training.
- Image browsing for whole-folder import, with image analysis and sample thumbnails.
- Added backward-compatible Tauri commands for fast recent-project index reads, per-project availability checks, identity-safe relinking, active-pipeline summaries, and preview-token-guarded high-impact actions.

### Changed

- Reframed the repository as an Alpha source preview.
- Corrected clone, development, repository-structure, and validation documentation.
- Separated source publication from the blocked public binary-distribution process.
- Rewrote the English and Chinese READMEs, consolidated current guides and retained historical engine evidence under `docs/validation/`.
- Removed superseded planning/QA notes and unused frontend styles and illustrations; ignored isolated Cargo build directories.
- Simplified recent projects to uniform clickable rows, consolidated settings in the sidebar and removed redundant activity banners and footer details.
- Disk availability on the project center now defaults to the application executable volume and distinguishes unavailable measurements from zero.
- Preset changes automatically rerun preflight; creation exit uses an application dialog, and empty previews no longer show a stale-artifact warning.
- Recent projects now render before bounded background path checks; unavailable, missing, unreadable, and temporarily uncheckable locations remain distinct and recoverable.
- High-impact pause, cancel, rerun, checkpoint, and project-delete flows now show impact before execution and reject stale or replayed confirmation tokens without side effects.
- Persisted pipeline-stage failures now keep stable error codes while presenting localized, user-safe messages instead of raw engine-facing English details.
- Existing Tauri command signatures and project formats remain supported; this release requires no `project.json` or JSON Schema migration.

### Security

- Redacted credentials and private paths at error, activity-detail, receipt, and diagnostic-facing boundaries; raw engine output and unrelated source logs are not rendered as normal frontend details.
- Added the Windows `tauri build --debug --no-bundle` gate to release validation.

[Unreleased]: https://github.com/metorigin/MetOrigin-Splat/compare/v0.1.0-alpha.3...HEAD
[0.1.0-alpha.3]: https://github.com/metorigin/MetOrigin-Splat/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
