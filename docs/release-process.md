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
