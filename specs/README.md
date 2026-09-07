# Design contracts and acceptance records

This directory retains feature design, interface contracts and acceptance protocols. It is historical implementation context, not a second description of the current product interface.

## Frontend UX improvements

The [001 feature](001-frontend-ux-improvements/) includes:

- [Specification](001-frontend-ux-improvements/spec.md), [plan](001-frontend-ux-improvements/plan.md) and [task record](001-frontend-ux-improvements/tasks.md)
- [UI interaction contract](001-frontend-ux-improvements/contracts/ui-interaction-contract.md) and [Tauri IPC contract](001-frontend-ux-improvements/contracts/tauri-ipc-contract.md)
- [Acceptance protocol](001-frontend-ux-improvements/quickstart.md) and [recorded results](001-frontend-ux-improvements/validation-results.md)

Later interface changes removed the active-project banners, redundant settings entries, global status footer and featured first recent-project card. They also introduced the current sidebar, creation wizard and Gaussian renderer. References to those earlier surfaces describe the design at the time; they are not requests to restore removed UI.

Historical references to `apps/desktop/src/App.css` now map to the active styles in `apps/desktop/src/styles/`: `buzz.css`, `tokens.css` and `interaction-surfaces.css`. The unused original stylesheet has been removed.

For current behavior, use the [user guide](../docs/user-operation-flow.zh-CN.md), [architecture](../docs/architecture.md) and [development checks](../docs/development.md). Preserve the contracts and recorded evidence when revising behavior, and distinguish a historical result from a newly executed verification.
