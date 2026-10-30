# Fixed WebP derivative for splat-transform 3.10.2

This profile supports SuperSplat 3.7.0's pinned dependency. It does not replace or
reinterpret the historical `../webp-overlay/` 3.4.2 payloads and acceptance.

The publication copy normalizes only machine-specific repository, home and
temporary directory path prefixes to the literal placeholders `${REPO_ROOT}`,
`${HOME}` and `${TMPDIR}`. References and enclosing metadata hashes are rebound,
including the normalized inherited 3.4.2
record. All payload/source/license bytes, source and archive identities, tool
versions, command options, timestamps, exit codes, members and acceptance results
are unchanged; this is not a new build or test run. `build-evidence.json` records
the normalization and original file hashes. The original 3.10.2 build evidence
SHA-256 is `cc62594c79c592967ba7ba59da3ca1a5381e8c198b544938cbb004276bed5f19`.
Unnormalized local evidence is retained only in the ignored validation archive.

- Upstream package: `@playcanvas/splat-transform@3.10.2`.
- Source: [e0dab1fa0b7f7546d2b4b197f6294570e53ba3b8](https://github.com/playcanvas/splat-transform/tree/e0dab1fa0b7f7546d2b4b197f6294570e53ba3b8), verified through annotated tag `v3.10.2`.
- Official npm archive is bound to the exact SHA512 recorded by SuperSplat's
  3.7.0 lock; `profile.mjs` separately pins source, npm, wrapper, TypeScript,
  patch, runtime-source and notice identities.
- Package JSON SHA256:
  `c65ef9c4e9e84512638391a9b7ca2a2c064dc8a291f80073039174b01e87e1aa`.

The official 3.10.2 C wrapper is unchanged and freshly linked against the
previously verified libwebp 1.6.0/SharpYUV 0.4.2 static libraries with Emscripten
4.0.21, dlmalloc, no SIMD and no threads. The new binary includes
`webp_encode_lossless_rgba_level`; the old 3.4.2 binary lacks this ABI. The new
link map was independently collected. Its 94 archive members match the reused
runtime-source mapping exactly. `evidence/reuse/build-evidence-3.4.2.json` records
the inherited library/SDK provenance; none of its historical codec or
distribution tests are counted as this profile's new acceptance.

The new official TypeScript codec retains the `effort` argument, validation and
default/level distinction. The source patch moves caller allocations and codec
outputs into `finally` cleanup, including partial allocation, C rejection and
JavaScript exceptions after a successful C result. Explicit effort retains
transparent RGB; the omitted effort retains upstream's default behavior.

All five Rollup targets were built from the fixed 3.10.2 source and its lock.
The archive revision is explicitly embedded as `e0dab1f` rather than allowing
Git to accidentally identify the enclosing MetOrigin repository. Only ten
selected companions are applied: paired `lib/webp.mjs`/`webp.wasm`, four JS
entrypoints and their four source maps. Other installed package bytes remain
from the official 3.10.2 npm package. Source-map acceptance binds each rebuilt
entry to the actual new glue and cleanup-patched codec source.

## Interfaces

`overlay.mjs` exports `loadWebpOverlay(directory)`,
`applyWebpOverlay(packageDirectory, overlay)` and
`verifyWebpOverlayInstalled(packageDirectory, overlay)` with the existing
integration interfaces. It accepts only the new fixed package base. The old
loader continues to accept only 3.4.2.

`../webp-evidence.mjs` dispatches schema 2 with profile
`splat-transform-3.10.2-webp-1.6.0-emscripten-4.0.21-v1` to
`verify-evidence.mjs`; schema 1 retains its prior fixed checks. The new
`webpBuildEvidenceFiles` closure contains 87 physical, hash-bound retained files;
the verifier returns 48 distributable notices and 94 linked archive members.
The complete selected file inventory is independently pinned, so an enclosing
manifest hash cannot authorize dropping a notice or source file.

## Recorded validation

Fresh isolated stage: `target/supersplat-3.7-webp/`.

- 33 normal/fault cases and 99 subsequent recovery cases cover default encode,
  effort encode and decode; all measured caller and codec output allocations
  are released, with no refused invalid/double frees.
- 30 comparisons between official and cleanup-patched 3.10.2 TypeScript use the
  new binary; 12 further comparisons use the official npm glue/WASM and verify
  identical decoded RGBA and cross-decoding for default and effort 0/1/3/6/9.
- Actual ESM, CJS with the actual PlayCanvas ESM external, and real worker
  transport pass codec roundtrips. All four generated source maps are bound.
- The new upstream WebP, SOG and HTML suites pass 16/16 tests.
- The old loader/evidence gates and new profile tests pass together: 26/26.

The official 3.10.2 CJS bundle has the same direct Node `require` PlayCanvas
interop limitation as the derivative. The CJS test supplies the actual ESM
exports as that external and does not claim the unrelated limitation is fixed.
Allocation fault tests measure caller-visible ownership with safe injected
JavaScript faults; they do not claim true OOM, every internal libwebp allocation,
browser/native app acceptance, or release readiness. Those remain separate.

The frozen evidence includes build drivers, commands and logs, C and TypeScript
source originals/patches, link/symbol maps, original notices and the source
mapping. Archives and static libraries are hash-recorded rather than duplicated
inside the integration. The upstream codec pair's original prebuilt provenance
is not used to establish this derivative's C/WASM provenance.
