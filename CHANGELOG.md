# Changelog

All notable changes to MetOrigin Splat will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and future public releases will follow [Semantic Versioning](https://semver.org/) where practical during Alpha development.

## [Unreleased]

### Added

- Public contribution and security guidance.
- Pull request and issue templates.
- Added page-aware workspace headers, a cross-page active-task summary, a searchable compact project drawer, freshness-aware async feedback, and complete keyboard/focus handling for dialogs, menus, tabs, and stages.
- Added backward-compatible Tauri commands for fast recent-project index reads, per-project availability checks, identity-safe relinking, active-pipeline summaries, and preview-token-guarded high-impact actions.

### Changed

- Reframed the repository as an Alpha source preview.
- Corrected clone, development, repository-structure, and validation documentation.
- Separated source publication from the blocked public binary-distribution process.
- Updated the repository audit to reflect the implemented project.
- Recent projects now render before bounded background path checks; unavailable, missing, unreadable, and temporarily uncheckable locations remain distinct and recoverable.
- High-impact pause, cancel, rerun, checkpoint, and project-delete flows now show impact before execution and reject stale or replayed confirmation tokens without side effects.
- Persisted pipeline-stage failures now keep stable error codes while presenting localized, user-safe messages instead of raw engine-facing English details.
- Existing Tauri command signatures and project formats remain supported; this release requires no `project.json` or JSON Schema migration.

### Security

- Removed machine-specific temporary paths from tracked design QA documentation.
- Redacted credentials and private paths at error, activity-detail, receipt, and diagnostic-facing boundaries; raw engine output and unrelated source logs are not rendered as normal frontend details.
- Added the Windows `tauri build --debug --no-bundle` gate to release validation.

[Unreleased]: https://github.com/metorigin/MetOrigin-Splat/compare/main...HEAD
