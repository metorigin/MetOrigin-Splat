# Implementation Plan: 前端页面交互与用户体验优化

**Branch**: `001-frontend-ux-improvements`（Spec Kit 功能标识；当前 Git 分支为 `main`） | **Date**: 2026-08-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-frontend-ux-improvements/spec.md`

**Note**: 本计划完成 Phase 0 研究与 Phase 1 设计；可执行任务由后续 `$speckit-tasks` 生成。

## Summary

在不改变现有 Tauri/React + Rust workspace 架构、项目格式或 Pipeline 业务语义的前提下，
重组桌面端页面上下文与项目工作台交互：项目中心和创建向导使用各自的上下文标题，项目运行栏
只在项目工作台出现；全局壳层继续跟踪唯一活动 Pipeline，使后台任务跨页面可发现；异步资源以
“保留最后有效值 + 完整度/新鲜度元数据”明确区分空结果、部分结果、刷新中和陈旧状态；错误、活动、恢复和危险操作使用统一的
可执行反馈与影响确认；窄窗口通过覆盖式项目抽屉保留搜索和管理能力；共享焦点、键盘和状态朗读
基元补齐可访问交互。

实现复用现有手写页面导航、`AppContext` reducer、`desktopApi`、`pipeline://event`、
`get_pipeline_state`、活动分页、产物和 Checkpoint 命令。新增桌面契约仅用于向后兼容的快速最近
项目索引、项目路径只读探测/重定位、活动 Pipeline 摘要、操作影响预览令牌，以及可渐进采用的
结构化安全错误。
最近项目先显示，再以有界并发逐项探测路径；第二个项目的启动由前端预防和 Rust 权威门禁共同拒绝，
不会取消或排队；危险操作使用一次性预览令牌拒绝过期确认。所有新增接口均为独立命令，旧项目
和既有命令调用保持有效，无项目数据迁移。

## Technical Context

**Language/Version**: TypeScript 5.5（strict）与 React 18.3；Rust 1.97.0、Edition 2021

**Primary Dependencies**: Tauri 2、Vite 5.4、Phosphor Icons、Three.js；保持现有依赖集，默认不新增路由、状态管理、查询缓存或无障碍组件库

**Storage**: 现有本地 `project.json`、应用配置目录中的最近项目/设置 JSON、项目内 JSONL 活动日志与文件产物；本功能不改变持久格式、不新增数据库

**Testing**: Vitest 2.1、jsdom、Testing Library、ESLint、严格 TypeScript、生产构建；Rust 单元/集成/command 契约测试、Clippy、rustfmt；Windows Tauri debug build；真实 Windows Tauri 手工验收与受控可用性/计时记录

**Target Platform**: Windows 10/11 x64 桌面应用；主要尺寸 1440×1024，最小可用尺寸 1024×768，覆盖 100%/125%/150% 系统缩放

**Project Type**: 现有单仓库桌面应用，React 前端通过 Tauri command/event 使用 Rust 应用核心

**Performance Goals**: 用户操作 1 秒内出现进行中反馈；最近项目索引返回后立即可浏览/搜索，最多 4 个路径探测并发且逐项更新；95% 已观测业务状态在 2 秒内反映到相关界面；1,000 条活动记录的筛选和目标错误定位在 2 秒内完成；页面切换不丢失活动任务或最后有效数据

**Constraints**: 本地优先且离线可用；无遥测/云上传；保持项目与 IPC 向后兼容；不伪造 ETA 或未知数值；不把业务状态复制为独立前端事实源；错误与复制内容必须脱敏；所有主要流程可键盘操作并达到 WCAG 2.2 AA 相关要求

**Scale/Scope**: 3 类页面上下文、6 条用户旅程、4 个用户 Phase/12 个技术 Stage、6 类高影响操作、最多 50 条最近项目及逐项路径探测、全局最多 1 个活动 Pipeline、至少 1,000 条活动记录；修改集中于 `apps/desktop` 与有限 Tauri command 边界

## Constitution Check

*GATE: Phase 0 前已通过；Phase 1 设计后已复核通过；2026-08-14 重新规划复核仍为 PASS。*

| 宪章原则 | 设计门禁 | Phase 0 | Phase 1 复核 |
| --- | --- | --- | --- |
| I. 保持现有分层架构 | 页面只经 context/service 使用 Tauri；业务事实仍来自 Rust/项目；不引入新架构层 | PASS | PASS：UI 契约只定义派生状态，IPC 增量仍位于既有 command 层 |
| II. 向后兼容 | 不改变既有 command/event 名称和字段语义；新增命令独立；旧项目无需迁移；发布说明记录兼容影响 | PASS | PASS：`ProjectInfo`/recent index 格式不变，路径探测、活动摘要和 guarded execute 均为独立命令，错误双格式解析；旧 mutation 保持签名与原有服务器验证，新 UI 仅走 guarded execute；`CHANGELOG.md` 和架构/开发文档记录增量契约与无需迁移 |
| III. 测试支撑 | 每个行为变化具备 reducer/hook/组件或 Rust 契约测试，CI 运行前端测试；平台行为变化必须通过 Windows Tauri build | PASS | PASS：新增 command 边界逐一覆盖请求/响应、成功、失败和恢复；quickstart 另覆盖异步探测、单任务冲突、重定位并发、过期预览零副作用、真实性能与 Windows 矩阵，并将 Windows Tauri debug build 作为发布阻断门禁 |
| IV. 安全持久化与迁移 | 不修改 `project.json`、Schema、数据库或用户素材；重定位使用加锁且可恢复的 recent-index 替换 | PASS | PASS：availability 仅为会话状态；所有 recent-index 读改写事务由应用级锁串行化，重定位验证相同项目 ID，并保留恢复副本直到新索引重读验证成功；冲突/检查失败/过期预览均零写入 |
| V. 结构化可执行错误 | 服务边界规范化结构化对象与旧字符串；用户摘要/影响/动作和技术信息分层 | PASS | PASS：契约明确 fallback code、重试动作、脱敏和不可把 unknown 当成功 |
| VI. 敏感信息保护 | UI、复制内容、测试夹具和诊断不包含凭据、私有媒体或不必要完整路径 | PASS | PASS：契约规定统一 redaction，quickstart 包含 canary secret 验证 |

其他架构约束同样满足：Windows 路径与缩放行为作为验收项；工具链和 lockfile 不变；外部引擎
适配器与 `splat-process` 不受影响；不新增 Tauri 权限、网络能力或可执行文件发现路径。

## Project Structure

### Documentation (this feature)

```text
specs/001-frontend-ux-improvements/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── tauri-ipc-contract.md
│   └── ui-interaction-contract.md
├── checklists/
│   └── requirements.md
└── tasks.md                         # 由 $speckit-tasks 生成，本阶段不创建
```

### Source Code (repository root)

```text
apps/desktop/
├── src/
│   ├── App.tsx                     # 全局生命周期、页面壳、活动任务与 overlays
│   ├── App.css                     # 响应式、focus、forced-colors、reduced-motion
│   ├── components/
│   │   ├── feedback/               # 新增：ErrorNotice、StatusAnnouncer、AsyncStatus、ActionReceipt
│   │   ├── primitives/             # 新增：ModalSurface、Tabs/RovingFocus 或对应共享基元
│   │   ├── settings/
│   │   │   └── SettingsDrawer.tsx
│   │   ├── shell/
│   │   │   ├── BackgroundTaskSummary.tsx  # 新增
│   │   │   ├── DeleteProjectDialog.tsx
│   │   │   ├── ProjectDrawer.tsx           # 新增
│   │   │   ├── ProjectNavigator.tsx        # 新增，共享宽/窄项目列表
│   │   │   ├── ProjectSidebar.tsx
│   │   │   ├── PipelineConflictNotice.tsx  # 新增，第二项目启动阻断与返回
│   │   │   ├── TitleRunBar.tsx
│   │   │   └── WorkspaceHeader.tsx         # 新增，按页面上下文派生
│   │   └── workspace/
│   │       ├── ActivityWorkbench.tsx
│   │       ├── CheckpointDrawer.tsx
│   │       └── PointCloudPreview.tsx
│   ├── context/
│   │   ├── AppContext.tsx
│   │   └── appContextValue.ts       # 按项目快照、新鲜度、活动任务与通知
│   ├── hooks/
│   │   ├── useAsyncResource.ts      # 新增，保留最后有效值
│   │   ├── useTauriCommand.ts       # 现有，改为复用统一 invoke/error 边界
│   │   ├── useModalFocus.ts         # 新增，topmost focus trap/restore
│   │   ├── useRovingFocus.ts        # 新增，menu/tabs/stage 键盘导航
│   │   └── useShortcutGuard.ts      # 新增，编辑/IME/overlay 守卫
│   ├── pages/
│   │   ├── HomePage.tsx
│   │   ├── NewProjectPage.tsx
│   │   ├── ProjectDetailPage.tsx
│   │   └── projectTimeline.ts
│   ├── services/
│   │   ├── desktop.ts               # 现有 invoke 封装与新增兼容命令
│   │   └── errors.ts                # 新增，双格式错误归一化与脱敏
│   └── types/
│       ├── async.ts                 # 新增，AsyncResource/receipt 状态
│       ├── errors.ts                # 新增，UiError/UiErrorAction
│       ├── interactions.ts          # 新增，ActionImpactPreview
│       ├── pipeline.ts
│       ├── project.ts
│       ├── system.ts
│       └── workspace.ts
└── src-tauri/src/
    ├── commands/
    │   ├── pipeline.rs              # 操作影响预览的领域派生
    │   ├── project.rs               # 快速索引、availability/relink/删除预览
    │   └── workspace.rs             # Checkpoint 影响预览与安全相对路径
    ├── lib.rs                       # 仅注册新增 command
    └── state.rs                     # 活动 Pipeline 与一次性预览令牌，仅运行时状态

CHANGELOG.md                         # Unreleased：用户可见变化、兼容性与无需迁移
docs/architecture.md                # 新增 command 边界与保持不变的架构约束
docs/development.md                 # Windows Tauri build 与验收命令
.github/workflows/ci.yml            # Windows baseline 加入 pnpm test
```

测试继续与被测模块相邻：前端使用 `*.test.ts(x)`；Rust command 测试留在对应模块的
`#[cfg(test)]` 中。若任务拆分发现某个共享基元只服务单一组件，可合并回该组件，避免无价值抽象。

**Structure Decision**: 保留现有 `apps/desktop/src` 页面、context、service、types 与
`src-tauri/commands` 边界。新增目录仅用于复用已经在多个现有 Dialog/Drawer/Menu/状态区域重复的
交互行为；不创建新 package、crate、路由系统、状态框架或后端服务。

## Implementation Strategy

### Increment 1 — 状态基础与页面上下文

1. 建立带完整度元数据的 `AsyncResource`、`UiError`、`ActionReceipt` 纯类型与 reducer/hook 测试，明确
   首次空成功、部分成功、刷新失败和完全失败的互斥状态。
2. 将 Pipeline 事件监听提升到应用生命周期，快照仍按项目 ID/sequence 合并；页面切换不再清空
   其他项目的最新快照。
3. 引入页面感知的 `WorkspaceHeader`，项目中心/向导不渲染项目运行控制；增加后台任务摘要及
   单一活动 Pipeline selector。
4. 将 Rust 活动任务门禁前移到引擎/GPU 检查及任何目标项目状态写入之前；前端所有启动入口在
   已知其他项目活动时显示冲突说明和单步返回，不调用 start/resume/rerun，也不取消或排队。
5. 移除基于 overall progress 的线性 ETA；只有未来存在经验证的历史估算契约时才显示范围。

### Increment 2 — 可恢复反馈与活动联动

1. `desktopApi` 与现有 `useTauriCommand` 共用唯一的 invoke/error 规范化边界，兼容结构化对象、JSON
   字符串和旧中文字符串；组件和页面不得直接调用 Tauri `invoke`，仓库审计测试锁定该边界。
2. Project artifacts/checkpoints/activity 使用完整度与保留旧值的新鲜度状态；首次空成功显示领域空状态，
   部分成功显示已有数据与缺失范围，并仅在对应问题可安全重试时显示 Retry；事件触发相关资源失效，轮询
   只作兜底。
3. 活动工作台使用现有 cursor/stage/severity/search 契约分页，选中 Stage 与日志上下文联动。
4. 新增持久回执和克制的状态朗读；轮询指标和逐条日志不进入 live region。

### Increment 2 Validation Gates

1. 建立本功能触及的查询和 mutation 清单；每项都必须指向自动化测试，覆盖等待、成功、失败以及准确的
   retryability。只有可安全重复的操作提供重试；可能产生副作用的操作在重试前必须重新验证当前目标与影响。
   所有主要 mutation 还必须覆盖 action-key single flight 和重复快捷键/点击不产生第二请求。
2. 自动化测试分别覆盖首次加载、空成功、部分成功、刷新失败保留旧值和完全失败；任何 feature UI、页面或
   hook 中的裸 `invoke` 都使审计失败。

### Increment 3 — 影响确认与项目路径恢复

1. Rust command 根据现有 Pipeline 顺序、Checkpoint 列表和项目目录验证派生影响预览，并签发绑定
   action/target/影响指纹的一次性短期令牌；确认提交时重新计算指纹，过期或重放均零写入并要求刷新后重新确认。
2. 暂停、取消、重跑、Checkpoint 恢复/删除和项目删除的新 UX 统一经过预览—确认—独立 guarded
   execute—回执—刷新；旧 mutation command 不改签名并保留原有服务器身份/合法性验证，只有兼容性
   调用可继续使用，新建或修改的 UI 代码不得直接调用它们。Rust command 契约测试同时锁定两条路径。
3. 保持 `list_recent_projects` 兼容，新增快速索引 command 先返回原索引；前端以最多 4 个并发调用单项只读 availability command，
   按 project ID + checked path + generation 丢弃迟到结果。可访问父层明确确认路径不存在时为 `missing`；
   路径存在但项目数据确定无效、不可读取或身份不匹配时为 `unreadable`，保留记录并提供诊断/重新定位；
   临时 I/O、权限或断盘显示 `check_failed`，保留记录并允许单项重试。三者不得互相折叠。
   `available` 响应必须携带最新 `ProjectInfo`；前端仅在
   ID/path/generation 仍匹配且时间不倒退时合并 ready/running/failed/completed 等生命周期状态，活动
   Pipeline snapshot 继续拥有更高的运行态优先级，列表不得因此重排或丢失焦点。
4. 重定位必须选择同一项目 ID 的有效目录且原索引仍匹配旧路径；ID 不同或验证失败时零写入并保留
   原记录。所有 recent-index 的读取—校验—修改—安装—内存同步由 `AppState` 持有的专用应用级写入锁
   串行化，避免 create/record/open/remove/delete/relink 并发丢更新；匹配成功时先写入并验证临时索引，在替换期间
   保留旧索引恢复副本，新索引重读验证后才清理恢复副本，失败必须回滚。用户只有显式选择后才能把
   候选目录作为独立项目打开。

### Increment 3 Validation Gates

1. Rust command 契约测试覆盖 `get_active_pipeline_summary` 的 active/null/错误响应，以及
   `preview_workspace_action -> execute_workspace_action` 的请求反序列化、全部六种动作分派、completed/
   stale/expired/replay 判别联合和零写入拒绝。
2. 最近项目契约测试覆盖 `available/missing/unreadable/check_failed` 的互斥分类，并覆盖并发
   create/record/open/remove/delete/relink 下的锁串行化、旧 path compare-and-swap、无丢更新、
   失败释放锁和启动恢复，以及 availability 的 `refreshed_project` 合并及活动快照优先级；
   旧 mutation 签名与验证行为继续通过兼容测试。
3. SC-001/002/004/005/012 按 spec 的受控可用性协议记录样本数、固定脚本、逐项结果和中位数；
   SC-003/009/010 记录计时起止点、至少 20 次样本与通过阈值，不以主观观察替代数据。

### Increment 4 — 键盘、窄窗与视觉状态

1. 统一 modal focus stack、背景 inert、Escape、busy 和焦点恢复。
2. 为 Menu/Tabs/Stage 选择补充准确的 roving focus 与 ARIA 关系；全局快捷键避让编辑、IME 和
   顶层 overlay。
3. 宽窗侧栏和窄窗抽屉复用 `ProjectNavigator`；1024×768 下通过一次操作访问完整列表。
4. 调整可重排布局、内部滚动、focus-visible、forced-colors 和 reduced-motion；不以缩小核心文字
   或隐藏操作换取适配。

### Release Validation Gates

1. 在其他前端与 Rust 门禁通过后，必须在 Windows 运行
   `pnpm --dir apps/desktop tauri build --debug --no-bundle` 并要求退出码为 0；失败阻断发布。
2. 在 `CHANGELOG.md` 的 Unreleased 段记录用户可见变化、新增的兼容 Tauri commands、旧命令兼容性与
   “无需项目/schema 迁移”，并同步 `docs/architecture.md` 与 `docs/development.md` 的命令边界和验证说明。

## Phase 1 Design Decisions

- UI 派生状态、转换规则与状态机见 [data-model.md](./data-model.md)。
- 页面、异步、错误、overlay、键盘和状态朗读契约见
  [ui-interaction-contract.md](./contracts/ui-interaction-contract.md)。
- 保持不变与新增的桌面 command/event 契约见
  [tauri-ipc-contract.md](./contracts/tauri-ipc-contract.md)。
- 端到端自动化及 Windows 实机验收步骤见 [quickstart.md](./quickstart.md)。

## Complexity Tracking

无宪章违规或需要例外的复杂度。本计划明确拒绝新状态框架、路由框架、UI 基元依赖、数据库、
项目 Schema 迁移和网络能力；新增共享基元只合并已存在于三个以上组件中的重复交互规则。
