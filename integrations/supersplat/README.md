# SuperSplat integration

`upstream.json` pins the PlayCanvas SuperSplat Editor source. `prepare.mjs` prepares a disposable checkout in `target/`, injects `metorigin-bridge.ts` after scene startup, and copies the release build into the desktop's public assets. Source modifications are confined to that generated checkout. The editor is MIT licensed; the shipped build also includes its actual bundled dependencies' notices and source maps.

The bridge uses a same-origin, parent-only request/reply channel. `load` accepts a transferred PLY buffer. `export` waits for queued edits and exports all visible Gaussians with up to three SH bands. `saved` marks the scene clean only after Rust has persisted and validated the output. `save-failed` leaves the scene dirty. `dirty` supports conservative close confirmation. The host blocks interaction while exporting or saving. SuperSplat's `.ssproj` and other export features remain available from its own file menu.

The application entry points are `TitleRunBar.tsx`, `ModelEditorPage.tsx`, `useModelEditor.ts` and Tauri `commands/editor.rs`. Save replaces `output/scene.ply` after validation; the application does not generate or list historical editing versions. See `docs/development.md` for setup and native validation, and `docs/user-operation-flow.zh-CN.md` for the user flow.
