<!--
Sync Impact Report
- Version change: unratified template -> 1.0.0
- Modified principles:
  - Placeholder Principle 1 -> I. Preserve the Existing Layered Architecture
  - Placeholder Principle 2 -> II. Backward Compatibility Is an Explicit Contract
  - Placeholder Principle 3 -> III. Test-Backed Changes (NON-NEGOTIABLE)
  - Placeholder Principle 4 -> IV. Safe Persistence and Database Migrations
  - Placeholder Principle 5 -> V. Structured and Actionable Error Handling
  - Added Principle 6 -> VI. Sensitive Information Never Enters the Repository
- Added sections:
  - Architecture and Data Constraints
  - Development Workflow and Quality Gates
- Removed sections: none
- Follow-up TODOs: none
-->

# MetOrigin Splat Constitution

## Core Principles

### I. Preserve the Existing Layered Architecture

Changes MUST preserve the current Tauri/React frontend, Tauri command boundary, Rust workspace,
engine-adapter, unified process-runner, and project-workspace architecture. React components MUST
use the frontend service/context layers instead of invoking ad hoc backend behavior. Business and
pipeline state MUST remain owned by the Rust core and persisted project model rather than duplicated
as an independent UI source of truth. FFmpeg, COLMAP, and Brush commands MUST be constructed through
their adapters and executed through `splat-process`; UI and orchestration code MUST NOT launch them
directly. New databases, state frameworks, services, cloud infrastructure, or cross-layer shortcuts
require an approved architecture proposal and a constitution amendment before implementation.
Rationale: stable boundaries keep external-engine volatility, Windows process behavior, recovery,
and user-interface concerns independently testable without redesigning the application.

### II. Backward Compatibility Is an Explicit Contract

Persisted projects, JSON schemas, presets, Tauri command/event payloads, pipeline state, engine-lock
metadata, and documented user behavior MUST remain readable and behaviorally compatible across
compatible releases. Additive changes MUST use defaults or optional fields that older data can
safely omit. A breaking change MUST be identified before implementation and include a versioned
migration or compatibility adapter, affected-consumer updates, release and rollback notes, and
tests for both the previous and new representations. Unsupported future versions MUST be rejected
without mutating user data and with an actionable error. Experimental interfaces may change during
Alpha, but the same change MUST update every repository consumer and relevant documentation; no
change may silently make an existing user project unreadable. Rationale: Alpha status permits
evolution, not silent data loss or unexplained behavioral drift.

### III. Test-Backed Changes (NON-NEGOTIABLE)

Every behavior change MUST include automated tests at the lowest effective layer and integration or
contract coverage where a boundary changes. Bug fixes MUST add a regression test that fails before
the fix whenever the failure can be reproduced deterministically. Rust changes MUST keep formatting,
Clippy with warnings denied, and relevant workspace tests green. Frontend changes MUST keep ESLint,
strict TypeScript checks, Vitest, and the production build green. Schema or preset changes MUST
validate both accepted and rejected fixtures. Changes involving persistence, migrations, recovery,
cancellation, external-process execution, Tauri commands/events, or engine adapters MUST cover
success, failure, and recovery or cancellation paths as applicable. Real-engine tests remain ignored
by default, but engine-compatibility changes MUST record the pinned engine version, environment,
input provenance, command, and result. If automation is impractical, the pull request MUST explain
why, provide reproducible manual evidence, and identify the residual risk; convenience alone is not
a valid exception. Rationale: this application coordinates expensive and failure-prone local work,
so compilation alone is not evidence of safe behavior.

### IV. Safe Persistence and Database Migrations

All authoritative project-state writes MUST retain the existing atomic-write, locking, and recovery
semantics. Every persistent-format or database schema change MUST have an explicit monotonically
increasing version and a sequential forward migration; implicit downgrades and destructive in-place
conversion are prohibited. Before mutation, a migration MUST validate the source version and
required invariants. It MUST use a transaction or write-and-validate replacement, preserve the
original until the new representation is durable, and leave a documented recovery path on failure.
Destructive table or field changes require a backup/export path or proof that the artifact is derived
and safely reproducible; user-owned source media and authoritative project metadata are never
treated as disposable. Migration tests MUST include representative prior-version fixtures, invalid
and future versions, interruption/failure behavior, post-migration validation, and reopening the
migrated data without further corruption. The matching JSON Schema, format documentation, and
schema-version constant MUST change together. Rationale: project and COLMAP data can represent hours
of local computation, making partial writes and untested transformations unacceptable.

### V. Structured and Actionable Error Handling

Fallible Rust core paths MUST return or deliberately map errors; production input and I/O paths MUST
NOT rely on `unwrap`, `expect`, panic, ignored `Result`, or a generic success fallback unless a
documented invariant makes failure impossible. Core errors MUST use the established `AppError`
model or an explicitly mapped equivalent with a stable code, category, safe user message, retained
technical cause, actionable suggestions where possible, and accurate retryability. Cancellation,
timeouts, validation failures, resource exhaustion, engine failures, and internal faults MUST remain
distinguishable. Tauri and frontend boundaries MUST present localized, user-safe summaries while
retaining redacted diagnostics for troubleshooting; raw engine output, stack details, credentials,
and sensitive paths MUST NOT be exposed in user-facing errors. Cleanup failures may be best-effort
only when the primary result is already determined, and such suppression MUST be intentional and
observable when it affects recovery. Rationale: reliable recovery depends on preserving diagnostic
meaning without leaking implementation or user data.

### VI. Sensitive Information Never Enters the Repository

Commits, branches, tags, test fixtures, snapshots, logs, documentation, build artifacts, and pull
request attachments MUST NOT contain credentials, API tokens, private keys, signing certificates,
environment files, private or unlicensed media/datasets, user project directories, machine-specific
private paths, engine binaries, model weights, or unredacted diagnostic archives. Secrets required
by local or CI execution MUST come from environment variables or an approved secret store and MUST
never be printed. Public fixtures and third-party assets MUST record source, license, checksum when
appropriate, and redistribution permission. Diagnostic and export paths MUST redact credentials,
user identifiers, unnecessary full paths, and unrelated log content. Telemetry, cloud upload,
network transfer, or external sharing of user data MUST NOT be introduced without an approved design,
explicit user control, and updated privacy/security documentation. Suspected exposure MUST be
reported privately, the secret revoked or rotated, and repository history assessed; deleting only
the latest file is insufficient. Rationale: this is a public, local-first media application, so a
single accidental commit or diagnostic bundle can permanently expose sensitive material.

## Architecture and Data Constraints

- Windows 10/11 x64 remains the validated desktop release target. Cross-platform core improvements
  MAY be accepted, but MUST NOT weaken Windows path, encoding, cancellation, process-tree, or package
  behavior.
- Rust 1.97.0, Node.js 22, pnpm 11.12.0, Cargo and pnpm lockfiles, and the current workspace layout
  are reproducibility inputs. Toolchain or dependency changes MUST be isolated, reviewed for license
  and supply-chain impact, and verified with the full affected test matrix.
- User media remains local by default. The project workspace and `project.json` remain the source of
  truth for durable application state; caches, previews, and COLMAP/training outputs MUST be clearly
  classified as authoritative or reproducible before lifecycle or migration decisions are made.
- External-engine compatibility MUST be version-detected and isolated behind adapters. Command
  arguments MUST be passed structurally rather than shell-joined, executable discovery and package
  checksums MUST remain validated, and raw engine output MUST NOT become a frontend contract.
- Tauri capabilities MUST remain minimal. New filesystem, shell, dialog, network, or OS permissions
  require a documented use case, threat review, and tests of the restricted boundary.

## Development Workflow and Quality Gates

1. Before implementation, classify the affected architecture boundary, compatibility contract,
   persisted data, error surface, security/privacy exposure, and required test layers.
2. Keep each change focused. Architecture, dependency, persistent-format, or external-engine changes
   MUST include design rationale and compatibility/recovery notes in the pull request.
3. Follow existing style: `cargo fmt` and Clippy-clean Rust; strict TypeScript; ESLint and Prettier
   conventions; frontend tests beside covered components/pages; Rust tests beside the relevant crate
   with integration tests for cross-crate behavior.
4. Run all checks relevant to the change. The standard release-facing gate is:
   `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
   `cargo fmt --all -- --check`,
   `cargo clippy --workspace --all-targets --all-features -- -D warnings`, and
   `cargo test --workspace --all-targets`. Schema validation and a Windows Tauri build MUST pass when
   their inputs or platform behavior are affected.
5. Documentation, schemas, examples, changelog/release notes, security/privacy statements, and
   packaging notices MUST be updated in the same change whenever their described contract changes.
6. Reviewers MUST explicitly verify compliance with all six principles. Any temporary exception MUST
   state its owner, scope, reason, compensating checks, expiry condition, and follow-up issue; an
   exception MUST NOT permit data loss, secret disclosure, or bypass of migration recovery.

## Governance

This constitution is the highest project-level engineering policy. If another repository document
or customary practice conflicts with it, this constitution governs until amended. Amendments MUST
be proposed through a focused pull request that states the motivation, affected principles, expected
compatibility and migration impact, rollout or recovery plan, and verification evidence. Approval
requires maintainer review and successful applicable quality gates.

Constitution versions follow semantic versioning: MAJOR for removal or backward-incompatible
redefinition of a principle or governance rule, MINOR for a new principle/section or materially
expanded obligation, and PATCH for clarifications that do not change required behavior. Every
amendment MUST update the version, `Last Amended` date, and Sync Impact Report. The original
`Ratified` date MUST remain unchanged.

Every feature specification, implementation plan, task list, pull request, and release review MUST
include a constitution compliance check. Maintainers MUST review the constitution at least before
each public release and whenever architecture, persistent formats, engine distribution, telemetry,
or security posture changes. Unresolved violations block merge or release unless governed by a
documented temporary exception meeting the requirements above.

**Version**: 1.0.0 | **Ratified**: 2026-08-13 | **Last Amended**: 2026-08-13
