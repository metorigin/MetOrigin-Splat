# Windows x64 internal full installer

This directory defines the reproducible, internal-only engine pack used by the
fully offline Windows installer. It is not an authorization to publish the
bundled third-party programs.

## Build

From the repository root on Windows 10/11 x64:

```powershell
pnpm package:windows:full
```

The command verifies the pinned Node, pnpm and Rust toolchain, acquires each
locked component, prepares and hashes the engine staging tree, executes all four
engine version checks, builds only the Tauri NSIS bundle, and renames it to:

```text
target/release/bundle/nsis/MetOrigin-Splat-Full-Setup-0.1.0-internal.exe
```

Its SHA-256 and review metadata are written next to the installer. The staging
tree is generated at `target/distribution/windows-x64/` and is intentionally
ignored by Git.

For an engine-only refresh or verification:

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

`Acquire-EngineArchives.ps1 -Offline` can be used after all four files named in
`engine-lock.json` have been placed in `.engines/downloads`. An exact installed
copy of the locked VC++ Runtime is also detected automatically.

## Distribution boundary

The GitHub workflow is manual (`workflow_dispatch`) and uploads an unsigned
artifact for 14 days. It does not create a GitHub Release. Before any public
distribution, resolve every gate documented in the generated
`THIRD_PARTY_NOTICES.md`, produce an SBOM, sign the installer, and complete the
clean-machine compatibility matrix.
