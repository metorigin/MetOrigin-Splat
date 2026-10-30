# SuperSplat integration

`upstream.json` pins the official PlayCanvas SuperSplat Editor 3.7.0 source (`b89029dd20911fd18905b61de2701094ac390a73`). `prepare.mjs` prepares a disposable checkout in `target/`, injects `metorigin-bridge.ts` after scene startup, and copies the release build into the desktop's public assets. Source modifications are confined to that generated checkout. The editor is MIT licensed; the shipped build also includes its actual bundled dependencies' notices and source maps.

Embedded presentation hides only the menu's `menu-home` and its separator; the host title, bottom-right version, About and shipped notices remain. Before upstream `registerPreferences`, `ui-theme/presentation.ts` migrates overlay defaults once: it sets `camera.showInfo` and `view.perfOverlay` to `false` inside `supersplat:preferences.values`, preserving all other preferences and top-level fields. The marker `metorigin:supersplat:overlay-defaults:v1=1` is written only after the preference write succeeds. Later manual choices remain remembered. Unsupported/corrupt or unavailable storage is left intact, failed writes remain retryable, and standalone mode keeps its upstream behavior. The pinned source inputs include both `src/main.ts` and `src/ui/menu.ts`.

The WebP codec uses a separately identified derivative of splat-transform 3.10.2.
`webp-overlay-3.10.2/manifest.json` binds ten companion files: the generated WebP JS and
WASM, and the ESM, CJS, worker and CLI distributions with their source maps.
Normal preparation only needs Node's built-in gzip support; it does not install
a compiler or Emscripten SDK. Every compressed and expanded payload is checked,
and the installed base package must have the exact recorded manifest and original
or already-applied file hashes. The overlay is reapplied after `npm ci`. Modified
bytes are labelled as derived, rather than attributed to the original npm package.

`build-evidence.json` records fixed upstream sources, toolchain, build commands,
the actual linked runtime sources and original notices. Its accompanying evidence
retains source modifications and validation results. The codec wrapper releases
temporary allocations on both success and failure; this does not change libwebp's
existing treatment of hidden RGB values in fully transparent pixels.

The preparation cache includes this derivation and the preparation helpers in its
signature. It checks every output asset, the package-sourced WebP WASM and the
paired derived module embedded in the source map. SuperSplat 3.7 takes WASM
from the installed splat-transform package; there is no separate static JS glue.
The earlier `webp-overlay/` directory retains the historical 3.4.2 evidence and
is not installed into the current editor. macOS packaging additionally compares
the public assets, Vite's copied assets and the selected license collection before
binding the resulting executable hash. This is a build-input chain, not extraction
of a symbol-level SBOM from the executable. Run `pnpm test:supersplat:packaging` for
the payload, mismatch, cache and filesystem checks.

The bridge uses a same-origin, parent-only request/reply channel. `load` accepts a transferred PLY buffer. `export` waits for queued edits and exports all visible Gaussians while preserving their actual SH bands (SH0–SH3). `saved` marks the scene clean only after Rust has persisted and validated the output. `save-failed` leaves the scene dirty. `dirty` supports conservative close confirmation. The host blocks interaction while exporting or saving. SuperSplat's `.ssproj` and other export features remain available from its own file menu.

The application entry points are `TitleRunBar.tsx`, `ModelEditorPage.tsx`, `useModelEditor.ts` and Tauri `commands/editor.rs`. Save replaces `output/scene.ply` after validation; the application does not generate or list historical editing versions. See `docs/development.md` for setup and native validation, and `docs/user-operation-flow.zh-CN.md` for the user flow.
