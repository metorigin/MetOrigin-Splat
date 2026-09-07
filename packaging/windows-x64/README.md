# Windows x64 internal full installer

This directory defines the reproducible, internal-only engine pack used by the
fully offline Windows installer. It is not an authorization to publish the
bundled third-party programs.

## Build

From the repository root on Windows 10/11 x64:

```powershell
pnpm package:windows:full
```

The command verifies the pinned Node, pnpm and Rust toolchain, acquires the
locked components, and prepares and hashes the engine staging tree. It builds
and verifies the Brush live-preview companion, checks the stock engines,
then builds the Tauri NSIS bundle and publishes it as:

```text
artifacts/windows/installer/MetOrigin-Splat-Full-Setup-0.1.0-internal.exe
```

The installer checksum and review metadata are written next to the installer.
The isolated Cargo bundle directory is a build cache, not the delivery directory. The staging
tree is generated at `target/distribution/windows-x64/` and is intentionally
ignored by Git.

For an engine-only refresh or verification:

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

`Acquire-EngineArchives.ps1 -Offline` can be used after all four files named in
`engine-lock.json` have been placed in `.engines/downloads`. Offline companion
builds additionally need the pinned Brush source archive and cached Cargo dependencies;
see [engine integration](../../docs/engine-integration.md). An exact installed
copy of the locked VC++ Runtime is also detected automatically.

## Distribution boundary

The GitHub workflow is manual (`workflow_dispatch`) and uploads an unsigned
artifact for 14 days. It does not create a GitHub Release. Before any public
distribution, resolve every gate documented in the generated
`THIRD_PARTY_NOTICES.md`, produce an SBOM, sign the installer, and complete the
clean-machine compatibility matrix.
