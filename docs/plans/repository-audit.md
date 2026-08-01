# Repository Public-Readiness Audit

**Updated:** 2026-08-01

This document replaces the initial bootstrap audit from 2026-07-12. The repository now contains a working Rust workspace, Tauri/React desktop application, automated tests, CI, schemas, presets, documentation, and dual MIT/Apache-2.0 source licenses.

## Public source scope

The intended first public milestone is an Alpha source release. It does not include a supported public binary, a public offline engine pack, or a compatibility promise beyond the validated Windows development environment.

## Repository state

- `main` is the intended long-lived and default branch.
- Public preparation is performed on a short-lived pull-request branch.
- Rust and Node lockfiles and the Rust toolchain are committed.
- CI covers Rust formatting, Clippy, tests, schemas, frontend checks, and a Windows Tauri debug build.
- Real-engine tests remain opt-in because they require local engines, licensed media, disk space, and compatible GPU hardware.

## Completed foundations

- Dual `MIT OR Apache-2.0` source licensing
- Rust workspace and Tauri desktop application
- FFmpeg, COLMAP, and Brush adapter boundaries
- Project persistence, pipeline recovery, checkpoint handling, preview, and export paths
- Frontend and Rust automated tests
- GitHub Actions CI and Dependabot configuration
- English and Simplified Chinese README files
- Architecture, development, engine, project-format, release, and troubleshooting documentation
- Contribution, security, changelog, pull-request, and issue guidance

## Known public-release boundaries

### Source publication

Before the repository becomes public:

- Review retained branches, tags, workflow history, logs, and artifacts.
- Run a dedicated secret scanner across all Git history.
- Remove machine-specific paths and private test references from tracked documentation.
- Confirm the selected `main` commit and required checks.
- Reapply branch rules after changing repository visibility.

### Binary distribution

The internal Windows engine pack is not approved for public distribution. Outstanding gates include FFmpeg GPL materials, the COLMAP binary dependency inventory, Brush model-weight provenance, application dependency notices, an SBOM, code signing, and clean-machine compatibility testing.

See `packaging/windows-x64/THIRD_PARTY_NOTICES.template.md` for the authoritative internal release gate.

## Remaining engineering work outside this documentation change

- Keep CI green on the public candidate commit.
- Expand the public real-engine fixture and hardware compatibility matrix.
- Automate dependency license policy and vulnerability checks.
- Harden Tauri capabilities and content security policy before a public binary release.
- Complete the third-party redistribution review before publishing an installer.

These items do not prevent review of the source code, but they must be represented accurately in public project claims.
