# MetOrigin Splat Third-Party Notices

This notice belongs to the internal Windows x64 engine pack `{{PACK_VERSION}}`.
The MetOrigin Splat application remains licensed under `MIT OR Apache-2.0`.
The programs below are shipped as separate, unmodified executable components
and retain their own licenses.

## SuperSplat Editor

The application also bundles the SuperSplat Editor (MIT), pinned independently
in `integrations/supersplat/upstream.json`. Its local build includes the upstream
`LICENSE`, `THIRD_PARTY_NOTICES.txt` for bundled JavaScript runtime dependencies,
and source maps under `supersplat/` in the application's web assets. The bridge
source and reproducible build script are in `integrations/supersplat/`.

## FFmpeg / FFprobe {{FFMPEG_VERSION}}

- Upstream binary archive (not corresponding source): {{FFMPEG_SOURCE_URL}}
- Locked binary archive SHA-256: `{{FFMPEG_SOURCE_SHA256}}`
- Included license: `ffmpeg/LICENSE`

The pinned Gyan FFmpeg build reports `--enable-gpl --enable-version3` and is
therefore a GPLv3 build. This internal validation package includes its binary
license text. **Public distribution is blocked** until the corresponding source,
static dependency sources, build configuration/materials, and final GPL notice
set have been prepared and reviewed. For a GitHub download, the planned source
delivery method is GPLv3 section 6(d): equivalent access to complete corresponding
source alongside the binary. A written offer is a different delivery mechanism,
not an additional blanket requirement for section 6(d).

## COLMAP {{COLMAP_VERSION}} (CUDA)

- Upstream binary archive: {{COLMAP_SOURCE_URL}}
- Locked binary archive SHA-256: `{{COLMAP_SOURCE_SHA256}}`
- Included upstream license: `colmap/COPYING.txt`

COLMAP itself uses the BSD license in the included text. The official Windows
archive also contains CUDA, Qt, Boost, ONNX Runtime, OpenSSL, SuiteSparse and
other separately licensed runtime dependencies. **Public distribution is
blocked** until the complete binary dependency inventory and all required
notices/license texts have been audited and included.

## Brush {{BRUSH_VERSION}}

- Upstream binary archive: {{BRUSH_SOURCE_URL}}
- Locked binary archive SHA-256: `{{BRUSH_SOURCE_SHA256}}`
- Included license: `brush/LICENSE`

Brush is distributed under the license included with its release archive. The
binary embeds LPIPS/VGG model weights. **Public distribution is blocked** until
the provenance and redistribution terms of those weights have been documented
and approved.

### MetOrigin Brush live preview companion

- Based on Brush v0.3.0: https://github.com/ArthurBrussee/brush/tree/v0.3.0
- Source archive SHA-256: `510698AF9E6FDACE4B3D0BBE8695E5549F2F969AD0260A32B4B49694BCC51C0A`
- Modified executable: `brush/brush_live.exe` (`0.3.0+metorigin-live.1`)
- License: `brush/BRUSH-LIVE-LICENSE` (Apache-2.0)
- Changes: headless entry point and on-demand training preview snapshots. The
  extension sources are in `integrations/brush-live`, with the reproducible build
  procedure in `scripts/windows/Build-BrushLive.ps1` in the MetOrigin source tree.

### Spark 2.1.0

The application uses Spark for Gaussian rendering in its WebView.
Source: https://github.com/sparkjsdev/spark/tree/v2.1.0 . License: MIT,
included in the installed JavaScript dependency and `licenses/spark/LICENSE`.

## Microsoft Visual C++ Redistributable {{VCREDIST_VERSION}}

- Installer source: {{VCREDIST_SOURCE_URL}}
- Locked installer SHA-256: `{{VCREDIST_SOURCE_SHA256}}`

The redistributable is executed as a separate Microsoft prerequisite during
installation and is not represented as a MetOrigin engine.

## Microsoft Edge WebView2 Runtime

The Tauri NSIS bundle embeds Microsoft's x64 Evergreen WebView2 offline
installer and runs it silently when the required runtime is not already
available. WebView2 is a separate Microsoft component governed by Microsoft's
terms; it is not represented as a MetOrigin engine. The exact offline installer
payload is obtained by the pinned Tauri bundler during creation of this internal
installer and is covered by the final installer SHA-256.

## Internal-only release gate

This pack is for internal validation and must not be uploaded to a public
release. A public build additionally requires the FFmpeg corresponding-source
package, a complete COLMAP dependency/license audit, Brush weight provenance,
an adequately complete SBOM, and multi-machine compatibility validation.
An explicitly labelled unsigned Alpha is permitted by the project's release
policy; Windows can still warn or block it depending on reputation and policy.
Stable releases require Authenticode signing. Neither signing nor creating a
GitHub draft resolves third-party redistribution requirements.

Dependency license texts and review inventories generated for this build are in
`DEPENDENCY-NOTICES.md`, `dependencies/`, `SBOM.cdx.json`, and
`release-readiness.json`. The SBOM is explicitly incomplete while upstream binary
dependencies and model provenance remain unresolved.
