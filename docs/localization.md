# Localization

The application supports `zh-CN` and `en`, with `system` as the default preference. The primary system/browser language determines the initial UI; Chinese locales resolve to Simplified Chinese and other locales fall back to English. The per-device preference is stored under `metorigin.ui.language`. Storage failure retains the preference for the current session.

## Add or update text

- Keep matching entries in `apps/desktop/src/i18n/locales/zh-CN.json` and `en.json`. The Chinese source text is the stable lookup key; English values are translations. Changing a source key requires updating its call sites and both catalogs.
- Call `t("source text", value0, value1)` for application-owned text. `{0}`, `{1}`, etc. are positional placeholders and may be reordered. Translate whole sentences where possible. Interpolation inserts plain text; React escapes it.
- Use `getLocale()` for dates and numbers. Avoid hard-coded locales.
- Do not evaluate translated constants only once at module import. Evaluate them during rendering, inside callbacks, or through a getter. Include the language in memo dependencies when caching translated output. Do not key or remount a project/editor by locale.
- Language changes rerender the workspace using `useLanguage()`. Independently mounted language controls and the editor also subscribe directly. Any new standalone surface must subscribe or receive updated text from its parent.
- Translate labels, hints, native file dialogs and accessibility text. Keep user names, filenames, paths, identifiers and raw engine logs unchanged.

## Existing backend messages

Rust IPC and saved activity records currently contain rendered user-facing messages. `localizeMessage()` translates those at the presentation boundary with catalog entries and whole-message templates. It preserves null/undefined fallbacks and never rewrites backend data or project files. Only explicitly identified diagnostic/stage parameters are recursively localized; project-name and path parameters are copied verbatim. Unknown messages retain their original text for diagnosis. Add catalog entries when introducing new backend messages; do not hide an unknown error with an unrelated generic translation.

For future protocol changes, prefer stable message identifiers plus parameters. The current adapter retains compatibility with older project records and requires no schema migration. The bounded in-memory message cache allows already-rendered UI notifications to follow language changes without guessing arbitrary English sentences.

SuperSplat receives its initial language through `lng`. Later changes use the existing origin-checked bridge's `language` command and upstream `i18n.setLanguage()`. Never reload the iframe to change language: that would discard unsaved edits.

## Validation and contributions

Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. Tests cover catalog completeness and placeholder parity, automatic detection, persistence, storage/system events, blocked storage, legacy diagnostics, state retention, and editor language changes without reloading the model.

Review the app in both languages at normal and compact widths, including the wizard, settings, running project, errors and confirmation dialogs. New locales also require adding a supported locale, detection/fallback rules, a selector option and tests. Translation corrections and terminology improvements are welcome; see [CONTRIBUTING.md](../CONTRIBUTING.md).
