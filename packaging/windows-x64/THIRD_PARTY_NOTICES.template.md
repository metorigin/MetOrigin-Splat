# MetOrigin Splat Third-Party Notices

This notice belongs to the internal Windows x64 engine pack `{{PACK_VERSION}}`.
The MetOrigin Splat application remains licensed under `MIT OR Apache-2.0`.
The programs below are shipped as separate, unmodified executable components
and retain their own licenses.

## FFmpeg / FFprobe {{FFMPEG_VERSION}}

- Source package: {{FFMPEG_SOURCE_URL}}
- Locked source SHA-256: `{{FFMPEG_SOURCE_SHA256}}`
- Included license: `ffmpeg/LICENSE`

The pinned Gyan FFmpeg build reports `--enable-gpl --enable-version3` and is
therefore a GPLv3 build. This internal validation package includes its binary
license text. **Public distribution is blocked** until the corresponding source,
build configuration/materials, written offer obligations, and final GPL notice
set have been prepared and reviewed.

## COLMAP {{COLMAP_VERSION}} (CUDA)

- Source package: {{COLMAP_SOURCE_URL}}
- Locked source SHA-256: `{{COLMAP_SOURCE_SHA256}}`
- Included upstream license: `colmap/COPYING.txt`

COLMAP itself uses the BSD license in the included text. The official Windows
archive also contains CUDA, Qt, Boost, ONNX Runtime, OpenSSL, SuiteSparse and
other separately licensed runtime dependencies. **Public distribution is
blocked** until the complete binary dependency inventory and all required
notices/license texts have been audited and included.

## Brush {{BRUSH_VERSION}}

- Source package: {{BRUSH_SOURCE_URL}}
- Locked source SHA-256: `{{BRUSH_SOURCE_SHA256}}`
- Included license: `brush/LICENSE`

Brush is distributed under the license included with its release archive. The
binary embeds LPIPS/VGG model weights. **Public distribution is blocked** until
the provenance and redistribution terms of those weights have been documented
and approved.

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
an SBOM, Authenticode signing, and multi-machine compatibility validation.
