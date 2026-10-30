# Jan UI adaptations in MetOrigin Splat

This product includes software developed by Menlo Research (https://menlo.ai).
Copyright 2025 Menlo Research. Jan is licensed under Apache-2.0. The original
Jan LICENSE is preserved in `jan-LICENSE`; the complete license is in
`Apache-2.0.txt`. Existing shadcn/ui code retains its MIT declaration in `../LICENSE`.

The fixed source is https://github.com/janhq/jan at
`b8d58255baf6d9e870025d3f0c60a5b80a63143b`. Its root directory had no NOTICE file
when inspected at that commit. This file records MetOrigin modifications and is
not represented as an upstream NOTICE.

Modifications made 2026-10-29:

- Adapt Jan's default gray sidebar and warm orange accent into the existing
  light/dark/system theme owner, using `html[data-theme]`. Derive the host and
  embedded editor palette from `integrations/jan/theme.json`. Darken the light
  primary fill for readable white labels, strengthen input boundaries and focus
  contrast, and retain semantic reconstruction warning, success and error colors.
- Merge Button, Input, Dialog, Menu, Tooltip, Switch, Separator, Sheet and
  Progress presentation with the existing shadcn source. Keep current Radix
  imports, default button type, accessibility semantics, localized labels,
  modal portal scope, busy protection and bounded/unknown progress behavior.
- Extract the sidebar surface, inset, navigation row and 224–320px resizing
  constraints. Replace cookies, Jan state and global shortcuts with a controlled
  local shell, pointer capture and keyboard width adjustment. Preserve real
  project status, recovery actions and safe navigation.
- Adapt HeaderPage into a single 48px desktop window/page row. Per the user's
  desktop reference, align native window navigation above the full-height sidebar
  and page/project actions above the content; remove Jan's floating outer gaps,
  gradients and rounded inset. Keep the 60px heading inside the settings modal.
  Extract Card / CardItem / SettingsMenu presentation for local settings. Keep existing
  application settings, project data and service boundaries. Remove Jan account,
  provider, model, router, Zustand, telemetry and service dependencies.
- Keep locally licensed Inter and JetBrains Mono fonts and MetOrigin branding.
  No Jan font binaries or logo are copied. Viewport and model/export colors are
  independent of the UI palette.

Modifications made 2026-10-30:

- Restore Jan's full-thumb checked travel for the 34×18px default switch, while
  retaining the smaller travel required by the 24×14px variant. Both sizes keep
  equal 1px edge clearance with the existing transparent border; prevent thumb
  shrinkage without changing Radix checked, disabled or keyboard behavior.

The source manifest `apps/desktop/ui-sources.json` records exact upstream hashes,
local paths and file-specific adaptations. Platform packaging collectors compute
fresh hashes of the adapted source rather than claiming it is unchanged Jan code.
