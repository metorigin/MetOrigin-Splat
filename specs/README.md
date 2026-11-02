# Historical feature specifications

Feature 001 has moved to the [documentation archive](../docs/archive/specs/001-frontend-ux-improvements/spec.md). Its design, task list, interface examples and acceptance results describe the implementation at that time.

The [archive index](../docs/archive/README.md) records the remaining T082/T084 acceptance work and the final `PENDING` result. Archiving does not complete those tasks or approve a release. Old sidebar layouts, dependency choices and IPC examples must not be copied as the current implementation contract.

For current behavior and engineering work, use:

- [Project status and acceptance boundaries](../docs/status.md)
- [Current design system](../docs/design-system.zh-CN.md)
- [User guide](../docs/user-guide.md) / [中文使用指南](../docs/user-operation-flow.zh-CN.md)
- [Architecture](../docs/architecture.md), [project format](../docs/project-format.md) and [development checks](../docs/development.md)

Current application styles start at `apps/desktop/src/styles/app.css`, which imports the shared tokens and workspace styles. The former `App.css`, `buzz.css` and `interaction-surfaces.css` are historical paths.

Spec Kit workflow templates and the project constitution remain under `.specify/`; the archived feature is not automatically selected as a new implementation task.
