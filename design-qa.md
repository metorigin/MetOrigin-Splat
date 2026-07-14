# MetaOrigin Splat UI Phase 2–6 Design QA

## Comparison target

- Source visual truth: `.artifacts/ui-redesign/selected-option-3.png`
- Implementation screenshot: `.artifacts/ui-redesign/screenshots/phase2-6-workspace-1440x1024.png`
- Combined comparison: `.artifacts/ui-redesign/screenshots/comparison-reference-vs-phase2-6-1440x1024.png`
- Responsive evidence: `.artifacts/ui-redesign/screenshots/phase2-6-workspace-1024x768.png`
- Responsive drawer evidence: `.artifacts/ui-redesign/screenshots/phase2-6-preview-drawer-1024x768.png`
- Wizard evidence: `.artifacts/ui-redesign/screenshots/phase2-wizard-1440x1024.png` and `.artifacts/ui-redesign/screenshots/phase2-wizard-1024x768.png`
- State: dark desktop workspace, Fast project running COLMAP sparse mapping at 58%, real-artifact DTO values matching the technical spike.
- Capture: Microsoft Edge through Playwright Core, device scale factor 1, browser console and page errors checked.

## Full-view comparison evidence

The source and implementation were normalized to 1440×1024 and placed in one comparison image. Both use the same major composition: fixed project rail, compact run header, central expandable timeline, right preview/quality column, bottom activity workbench, and fixed engine/resource status bar. Region proportions, dark palette, high-density controls, accent states, and primary action placement are materially aligned.

Intentional product differences are accepted:

- Elapsed time and ETA remain “尚未测量” unless a reliable runtime value exists; the source mock's synthetic estimates were not copied.
- The implementation groups all 12 technical stages under four user phases and only expands the selected phase, so its visible row count depends on real state.
- The implementation exposes Checkpoint management and final Splat count in the quality region instead of the mock's speculative cache-comparison table.

## Focused region evidence

- Preview: the implementation renders a Three.js point cloud from preview DTO coordinates and colors, plus camera frusta derived from COLMAP quaternion poses. Grid and camera distribution are visually comparable to the source.
- Quality: `196 / 266`, `73.7%`, `28,365`, `0.715 px`, `500 step`, and `70,035` are aligned in a compact two-column metric grid.
- Activity: the event table, severity marks, filters, search, and detail pane preserve the source's dense bottom-workbench hierarchy.
- Responsive: at 1024×768 the project rail collapses to icons, timeline and activity remain visible, and preview/quality moves into a keyboard-accessible right drawer instead of becoming unreachable.
- Wizard: the three-step progress header, two source choices, persistent footer actions, and 1024 layout remain within the viewport without horizontal overflow.

## Required fidelity surfaces

- Fonts and typography: system UI font stack, compact 10–14 px working text, semibold headings, line-height, truncation, and hierarchy match the desktop-tool target. No clipped primary labels were observed.
- Spacing and layout rhythm: sidebar width, top/status bar heights, panel gutters, one-pixel borders, compact radii, and dense table rows are consistent with the source. The 1024 drawer preserves access without shrinking the preview below a useful size.
- Colors and tokens: near-black surfaces, blue active selection, pink/red primary/destructive actions, green success, muted blue-gray copy, and border contrast map consistently to semantic CSS tokens.
- Image and asset fidelity: there are no placeholder raster assets, emoji, custom SVG, or CSS-drawn icons. UI icons use Phosphor; preview imagery is WebGL-rendered from pipeline artifact data.
- Copy and content: labels use product-specific Chinese terminology and unknown runtime values say “尚未测量”; no speculative metrics are shown as facts.

## Comparison history

1. Initial 1024×768 capture exposed a P1: the preview and quality inspector was hidden by the responsive breakpoint with no alternate access.
2. Fixed by adding “预览与质量” and “Checkpoint” responsive actions, a modal right drawer, backdrop, close control, and responsive grid rows.
3. Post-fix evidence: `phase2-6-workspace-1024x768.png` and `phase2-6-preview-drawer-1024x768.png` show the controls and complete inspector content.
4. Initial preview used camera-position ticks only (P2 versus the source's camera frusta). The backend now returns forward/up pose vectors derived from COLMAP quaternion rotation, and the viewer renders wire frusta. Post-fix evidence is the latest 1440×1024 workspace screenshot.

## Findings

No actionable P0, P1, or P2 findings remain in the compared states.

## Primary interactions tested

- Select a recent project and load the unified workspace.
- Expand/select the active phase and render artifact-driven stage state.
- Open the three-step new-project wizard.
- Open and close the 1024 preview/quality drawer.
- Render real-preview DTO data in Three.js without console or page errors.
- Unit tests cover video-analysis display and run/pause/resume/cancellation button state routing.

## Follow-up polish

- P3: lazy-load Three.js to reduce the current production chunk warning.
- P3: add more screenshot states for warning/error tabs and settings sub-tabs as the visual regression suite grows.

final result: passed
