# Contributing to MetOrigin Splat

Thank you for helping improve MetOrigin Splat. The project is in Alpha, so focused bug fixes, tests, documentation corrections, and small well-scoped improvements are especially valuable.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use an issue to discuss large changes, new engine integrations, project-format changes, or behavior that affects recovery and compatibility.
- Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Do not commit user media, private datasets, engine binaries, model weights, credentials, signing certificates, or generated build output.

## Development setup

Follow [docs/development.md](docs/development.md) for the supported toolchain, repository structure, engine boundary, and validation commands.

The short version on Windows is:

```powershell
git clone https://github.com/metorigin/MetOrigin-Splat.git
Set-Location MetOrigin-Splat
pnpm install --frozen-lockfile
pnpm tauri dev
```

## Branches and commits

- Create a short-lived branch from the latest `main`.
- Keep each pull request focused on one coherent change.
- Prefer Conventional Commit subjects such as `fix:`, `feat:`, `docs:`, `test:`, or `build:`.
- Do not mix generated files, unrelated formatting, or dependency updates into a feature change.
- Never place private material in a branch; all branches of a public repository are public.

## Validation

Run the checks relevant to your change:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build

cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

If a real-engine test is relevant, describe the engine version, GPU, driver, input provenance, command, and result in the pull request. Do not attach test media unless its license explicitly permits redistribution.

## Pull requests

A useful pull request includes:

- A concise explanation of the problem and the chosen solution
- User or developer impact
- Tests or other validation evidence
- Compatibility and migration notes when data formats or engine behavior change
- Screenshots for visible UI changes
- License and provenance details for new dependencies, fixtures, icons, or model assets

Draft pull requests are welcome for early feedback. A pull request should be marked ready only after its intended checks pass and its documentation is current.

## Coding expectations

- Preserve the adapter boundary around FFmpeg, COLMAP, and Brush.
- Launch external programs through `splat-process` rather than directly from UI code.
- Preserve cancellation, project locking, atomic persistence, recovery, and diagnostic redaction behavior.
- Keep Tauri permissions to the minimum required capability set.
- Do not add telemetry, cloud upload, or network behavior without an explicit design discussion and matching privacy documentation.
- Contributors remain responsible for reviewing AI-assisted output and ensuring it does not contain confidential, copied, or incompatibly licensed material.

## Contribution license

Unless explicitly agreed otherwise, by submitting a contribution you license it under the same `MIT OR Apache-2.0` terms as the project and confirm that you have the right to do so. Third-party material must retain its own required notices and must be identified in the pull request.
