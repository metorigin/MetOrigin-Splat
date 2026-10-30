# Jan UI source integration

Fixed upstream: https://github.com/janhq/jan at
`b8d58255baf6d9e870025d3f0c60a5b80a63143b` (2026-10-28).
Copyright 2025 Menlo Research, Apache-2.0. This product includes software
developed by Menlo Research (https://menlo.ai).

`upstream/` contains only the inspected visual source inputs and original
LICENSE, obtained through the GitHub connector at the fixed commit. They are
reference evidence, excluded from the application dependency graph. The source
index records both Git blob SHA-1 and exact SHA-256; retained bytes are checked
against the connector's blob identity. The copied-source manifest is
`apps/desktop/ui-sources.json`. Its build evidence distinguishes upstream bytes
from locally adapted bytes. The upstream root had no NOTICE file.

`theme.json` is the shared host/editor UI palette. `node integrations/jan/theme.mjs`
generates the checked-in host tokens offline; `--check` rejects stale generated
output. SuperSplat preparation consumes the same JSON. Default gray sidebar is
`#f1f1f1` / `#171717`; the green index.css fallback is intentionally replaced by
the actual InterfaceProvider runtime default. `--font-size-base` is always 16px.

Jan's neutral surfaces, 10px control radius and pill buttons are retained.
The user-directed desktop adaptation uses four edge-aligned regions: a 48px
window row with navigation on the left and page/project actions on the right,
a full-height sidebar, and the main content. Sidebar and header widths stay
aligned through resize/collapse. Container margins and floating corner cards
are removed; model progress details remain available from the window row. Local contrast
adaptations use `#be4c30` with white labels in light mode and `#f17455` with dark
labels in dark mode. Hover colors are explicit, and input/focus boundaries have
stronger contrast than the upstream translucent defaults. Reconstruction success,
warning, stale and error states remain local semantic extensions. Shared UI color
changes never recolor model output, selection axes or exported images.

The integration extracts presentation only. Existing AppContext, desktopApi,
Tauri/Rust, project schema, pipeline protocols and save/exit guards remain in
control. It does not import Jan routing, model stores, ServiceHub, telemetry,
accounts, provider business, logo or StudioFeixen font files.

Original Jan attribution, complete Apache-2.0 text and the detailed modifications
record are in `apps/desktop/src/components/ui/licenses/`; shadcn MIT remains in
`apps/desktop/src/components/ui/LICENSE`. Both platforms consume these via the
shared copied UI evidence collector.
