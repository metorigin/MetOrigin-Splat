# Release Process

## Current release status

MetOrigin Splat is in Alpha. Public source publication and maintainer-only GitHub Release drafts are supported. There is no supported public binary release or public full offline installer yet. See [Windows Alpha preparation (中文)](windows-alpha-release.zh-CN.md).

Two release boundaries must remain separate:

1. **Source release:** the MetOrigin Splat source code under `MIT OR Apache-2.0`.
2. **Binary distribution:** the application plus any bundled FFmpeg, COLMAP, Brush, Microsoft runtime, WebView2, model weights, and transitive runtime dependencies under their respective terms.

Making the source repository public does not authorize distribution of the internal engine pack.

## Source publication checklist

Before changing the repository visibility or creating a source tag:

1. Select and review the exact public `main` commit.
2. Review every retained branch, tag, Actions run, log, and artifact for private information.
3. Run a secret scan across all Git history.
4. Confirm CI is green on `main`.
5. Confirm README, development, contribution, and security documentation is current.
6. Confirm the release notes describe the project as Alpha and do not promise public binaries.
7. Re-enable the required branch rules after a repository visibility change.

Source tags must use prerelease SemVer while the public API and project format remain unstable, for example:

```text
v0.1.0-alpha.1
```

## Internal Windows installer

The manual Windows workflow builds an unsigned artifact for internal compatibility testing. It must not be attached to a public GitHub Release.

The pinned engine inputs and current blockers are documented in:

- `packaging/windows-x64/engine-lock.json`
- `packaging/windows-x64/README.md`
- `packaging/windows-x64/THIRD_PARTY_NOTICES.template.md`

## Public binary release gates

### macOS internal candidate

The Apple Silicon route has a separate [engine lock and packaging process](../packaging/macos-arm64/README.md). The local build entry point is:

```sh
bash scripts/macos/build-macos-app.sh --internal-alpha
```

This explicit option permits internal validation while engine or application-license evidence still has blockers; malformed evidence and integrity failures remain fatal. Without it, both evidence gates must pass. Neither option grants public-release clearance. The builder verifies the final embedded engine inventory after signing. Explicit Developer ID signing derives a separately identified pack; an external signature step must not silently change already-bound binaries. See the [signing and notarization procedure](macos-packaging.zh-CN.md#developer-id-签名与-apple-公证).

New DMGs are written to `artifacts/packages/macos-arm64/`, and each build's reports and preflight logs to `artifacts/verification/macos-arm64/build.XXXXXX/`. The latter directory's parent holds `latest.json`, updated only after the selected build steps succeed. Paths are defined in [`packaging/shared/artifact-paths.json`](../packaging/shared/artifact-paths.json). SuperSplat source and npm caches use `.cache/metorigin/sources/supersplat/upstream/` and `.cache/metorigin/downloads/npm/supersplat/`, configured in [`cache-paths.json`](../packaging/shared/cache-paths.json). The cache-layout change updates the preparation signature, so archive and recollect macOS application-license evidence before the first package using the new preparation.

Current application-license evidence uses `artifacts/licenses/macos-arm64/current/`, with backups under `archive/`; moving an unchanged verified collection alone does not require recollection. The builder generates its Tauri resource configuration from the shared paths. The frozen Mac engine pack and its engine-license evidence use `.engines/macos-arm64/distribution/`; Windows packages use `artifacts/packages/windows-x64/` and formal reports use `artifacts/verification/windows-x64/`; historical records below retain their original path fields. The local [license migration map](../artifacts/licenses/macos-arm64/migration-map.json) records relocated directories without rewriting their evidence. See the [macOS packaging guide (中文)](macos-packaging.zh-CN.md).

Mac engine and native-build paths are defined in [`engine-paths.json`](../packaging/shared/engine-paths.json). The development `.5` engine set remains separate from the full-package Alpha `.6` pack; the latter retains its original 2,999-file manifest `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`. Imported CMake/Cargo/FFmpeg outputs are historical inputs, while rebuild recipes default to fresh native-cache locations. Rebuilding or generating another pack requires independent verification and does not inherit this frozen pack's identity or acceptance. The packer's historical `--pack-version` default is still `0.1.0-alpha.1`; it is not a declaration that a newly generated pack is the current Alpha `.6`.

All Mac target compatibility links are retired; preparation reads `.engines/macos-arm64/` directly and does not recreate old target paths. Explicit settings that still name a retired path should select the matching canonical directory. Engine versions and release integrity gates are unchanged. Development COLMAP dependencies are installed by Conda at the canonical development prefix from the exact 171-package lock, then COLMAP 4.1.0 is rebuilt in the fresh native cache with the original CGAL/LSD/MVS/downloads development profile. The original dependency environment and install remain under `.engines/macos-arm64/archive/colmap/`; historical Alpha audit defaults use `colmapAlphaDependencyEvidence`, not the new development environment.

The local [engine migration map](../.engines/macos-arm64/migration-map.json) and original stage-4 receipts retain their historical contents. Record prefix retirement and the new development identity in a separate successor record; do not rewrite old project hashes or claim a new native, relocation or public-release acceptance result before verification. The frozen Alpha `.6` pack retains its existing identity.

Candidate identity, signed-container notarization, application-license findings and remaining acceptance are maintained only in [project status](status.md). The latest local success pointer and the older native acceptance builds are separate evidence. The detailed 2026-10-27 packaging sequence is retained in the [archive](archive/validation/macos-packaging-2026-10-27.md).

The configured minimum is macOS 15.0. Minimum-OS, 16 GB, clean-machine and cross-platform native checks remain separate from signing/notarization and same-host relocation. A notarized DMG does not grant application-license or public-release clearance.

### Shared public-release requirements

A public installer or portable archive remains blocked until all of the following are complete:

- FFmpeg corresponding-source and GPL notice obligations
- A complete COLMAP binary dependency inventory and required license texts
- Verified provenance and redistribution terms for Brush model weights
- Application dependency notices for shipped Rust and Node packages
- A generated SBOM for each artifact
- Authenticode signing and protected signing credentials for stable releases; explicitly labelled unsigned Alpha candidates are allowed, with their signature status and Windows reputation limitations documented
- SHA-256 checksums and retained build metadata
- Clean-machine installation, upgrade, uninstall, and runtime testing
- A documented Windows/GPU/driver compatibility matrix
- A security review of Tauri capabilities and content security policy

This list is an engineering release gate, not legal advice. Obtain an appropriate license review before public binary distribution.

`pnpm package:windows:full` includes collected dependency license texts, a CycloneDX
review inventory, native payload hashes and `release-readiness.json`. The inventory
declares incomplete composition while prebuilt binary dependencies and weight
provenance remain unresolved. Its creation is not redistribution clearance.

From a clean committed build, `scripts/windows/Publish-WindowsDraft.ps1 -Tag
v0.1.0-alpha.1` prepares and uploads a **draft prerelease**. Drafts are accessible
only to maintainers with write access; the script never publishes a public release.
It verifies installer hashes, source revision and unsigned status before upload.

## Future public artifact set

When the binary gates are complete, a release may contain:

```text
MetOrigin-Splat-Setup-x.y.z.exe
MetOrigin-Splat-Portable-x.y.z.zip
SHA256SUMS.txt
THIRD_PARTY_NOTICES.md
SBOM.spdx.json
Release Notes
```

Do not publish placeholder installers or artifacts whose engine inventory differs from their notices.

## Branch and review policy

- `main` is the only long-lived branch and must remain buildable.
- Changes are proposed through short-lived branches and pull requests.
- Squash merging and Conventional Commits are preferred.
- Delete merged head branches.
- Do not keep private material in a branch of a public repository; use a separate private repository when needed.

## Version consistency

Before a future binary release, ensure the version agrees across:

- root `package.json`
- `apps/desktop/package.json`
- workspace and application `Cargo.toml`
- Tauri configuration
- engine-pack metadata, where applicable
- the Git tag and release notes
