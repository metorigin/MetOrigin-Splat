# Phase 0 Research: 前端页面交互与用户体验优化

**Date**: 2026-08-14
**Status**: Complete — five 2026-08-13 clarifications incorporated; no unresolved `NEEDS CLARIFICATION` items

## Research Scope

研究以当前仓库为事实来源，覆盖 `App.tsx`、Context/reducer、页面与 shell/workspace 组件、
`desktopApi`、Tauri commands/events、Rust `AppError`、活动分页、Checkpoint/产物命令、现有测试和
CI。外部交互规范只采用 W3C/WAI 官方资料：[Modal Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)、
[Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)、
[Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages) 和
[Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible)。

## Decision 1 — 保留现有前端架构，增加页面感知壳层

**Decision**: 保留手写 `Page` 联合类型、`AppProvider/useReducer`、页面组件和 `desktopApi`。由
`AppWorkspace` 根据 `home / new-project / project-detail` 派生页面上下文；项目运行栏只在项目
工作台出现，项目中心与向导使用专属标题和主操作。

**Rationale**: 当前问题来自项目级运行控制被当作全局导航，而不是缺少路由或状态框架。集中派生
上下文能消除无项目时的 0%/禁用控制，同时保持现有页面和测试边界。

**Alternatives considered**:

- 在 `TitleRunBar` 内继续堆叠空项目条件：组件职责仍混乱，后续容易重新泄漏项目状态。
- 引入路由或全局状态框架：改变架构并增加依赖，当前三页面单窗口不需要。
- 每个页面自行绘制标题：重复逻辑，后台任务和主要操作容易不一致。

## Decision 2 — 事件触发刷新，快照作为事实源

**Decision**: `pipeline://event` 只作为刷新/失效信号；`get_pipeline_state` 仍是状态事实源。监听器
提升到应用生命周期，快照按 `project_id` 缓存，并继续使用 sequence 防止旧响应覆盖新状态；保留
当前活动任务退出后持久终态 `sequence = 0` 的合法收敛规则。

**Rationale**: 只监听当前页面会在离开项目时丢失活动；仅依赖最近项目状态更新过慢。现有后端限制
同一时间只有一个活动 Pipeline，已有 event、snapshot 和按项目缓存足以提供全局摘要。

**Alternatives considered**:

- 仅轮询：发现慢、开销高，难以满足 2 秒状态目标。
- 仅事件：事件可能滞后或丢失，不能替代事实快照。
- 新增后台任务服务：重复现有 `AppState.active_pipeline`，没有必要。

## Decision 3 — 使用轻量异步资源状态并保留最后有效值

**Decision**: 所有查询使用统一 `AsyncResource<T>`：首次加载无数据时为 blocking loading/error；成功
结果另记录 `completeness = complete | partial`，其中 `complete + 空集合` 是明确空成功，`partial` 必须
同时显示已有数据、缺失范围和恢复动作。已有数据刷新时保留 data，失败转为 stale，并记录
`lastSuccessfulAt`、error 和 request key。Mutation 使用 action key 去重，成功后使明确的相关资源失效并刷新。
每个操作必须从结构化错误或 command catalog 获得准确 retryability；只有可安全重复的操作显示 Retry，
可能产生副作用的 mutation 在再次执行前必须重新验证目标身份和当前影响。

**Rationale**: 当前页面分别使用 nullable、loading 和 error，产物/Checkpoint 刷新失败甚至被静默
忽略。统一状态可以区分 unknown、empty、refreshing、stale 和 failed，不把未知误报为零或完成。

**Alternatives considered**:

- 每个组件继续使用散落 booleans：状态组合不可穷举，容易清空旧数据。
- 引入查询缓存库：新增架构依赖；当前数据源数量可由轻量 reducer/hook 处理。
- 刷新开始清空 data：产生闪烁，并违反保留最后有效信息的规格。

## Decision 4 — 后台任务摘要与窄窗项目抽屉

**Decision**: 壳层展示唯一活动任务摘要和一步返回入口。宽窗保留当前侧栏；小于等于 1120px 时
保留 64px rail，通过一次点击打开 modal 项目抽屉。宽/窄布局复用同一 `ProjectNavigator`，搜索覆盖
名称与路径并展示所有 recent index 项（当前上限 50）。

**Rationale**: 现有 compact CSS 直接隐藏项目列表并禁用展开按钮，核心能力消失。覆盖抽屉不会压缩
工作区，且能复用现有项目操作。

**Alternatives considered**:

- 窄窗展开固定侧栏：继续挤压预览和时间线。
- 只保留图标和 tooltip：无法搜索、切换和管理项目。
- 创建独立移动端布局：超出 Windows 桌面范围。

## Decision 5 — 错误采用兼容归一化而非一次性 IPC 重写

**Decision**: 在 service 边界将结构化 `AppError` 对象、JSON 字符串和旧字符串统一为 `UiError`。
结构化内容优先；旧字符串由 command/action fallback catalog 提供稳定代码、标题、影响和安全动作。
`desktopApi` 与遗留 `useTauriCommand` 必须调用同一个规范化 invoke helper；页面、组件及其他 hook 不得
直接调用 Tauri `invoke`。Retry 仅在 payload/catalog 明确可安全重试时生成；非幂等 mutation 不得复用旧目标
或旧影响直接重放。后续触及的 Rust 路径可渐进返回可序列化安全错误，但前端始终支持旧格式，并以仓库
审计测试防止新旁路。

**Rationale**: Rust 已有 code/category/user message/suggestions/retryability，但多数 Tauri command 已
降为字符串。一次改变所有 command 错误类型影响面大；双格式解析能先改善 UX，同时保持既有调用。

**Alternatives considered**:

- 继续 `String(error)`：丢失错误结构，无法给出一致恢复动作。
- 一次性把所有 commands 改为新错误类型：兼容与回归范围过大。
- 在组件内逐个映射：文案、脱敏和动作会漂移。

## Decision 6 — 影响预览由 Rust 领域边界派生并由一次性令牌保护

**Decision**: 增加只读 `preview_workspace_action` command，根据现有阶段顺序、Pipeline 状态、
Checkpoint 列表与项目身份返回 allowed、blocking reason、preserved、invalidated、regenerated、
irreversible 和一次性 `previewToken`。令牌仅保存在应用运行时，绑定 action、target、影响指纹和短期
有效期；新 UX 将令牌提交给独立 `execute_workspace_action`，由 Rust 在任何写入前原子消费令牌并
重新计算影响指纹，再分派现有领域操作；过期、重放或状态变化均拒绝且要求重新预览。既有 mutation
command 名称、签名与原有服务器身份/合法性验证保持不变，只作为兼容入口；新建或修改的 UI 代码
不得直接调用它们。command 契约测试同时证明 guarded 路径不能旁路、旧入口没有语义回退。

**Rationale**: 下游失效和唯一 Checkpoint 规则属于业务事实。由前端复制可能与真正执行规则分叉；
只读预览不会修改数据。后端最终比较消除“预览后状态变化”的竞态，独立 guarded execute 则在不改
旧 command 签名的前提下确保新 UX 不能绕过令牌；兼容入口的残余风险通过原有 Rust 权威验证、
明确的调用范围和回归测试控制，而不是误称其具有预览令牌语义。
影响指纹只包含会改变影响范围的状态，不包含连续 progress 或普通 sequence，避免确认页无意义过期。

**Alternatives considered**:

- 前端静态计算全部影响：短期简单，但无法保证与 Rust 执行语义同步。
- 在每个 mutation 响应中才返回影响：用户确认前看不到结果。
- 为每种动作创建独立预览命令：接口碎片化且重复项目验证。
- 只在前端确认前重新读取：读与写之间仍存在竞态，不能保证零副作用拒绝。

## Decision 7 — 最近项目索引与路径可用性分离

**Decision**: `ProjectInfo` 与最近项目索引格式保持不变，既有 `list_recent_projects` 语义保持兼容；
新增 `list_recent_project_index` 只读取索引并先返回。前端随后以最多 4 个并发调用只读
`check_recent_project_availability(projectId, projectPath)`，每项原位
从 `unknown -> checking -> available | missing | unreadable | check_failed` 更新。文件系统探测使用
`spawn_blocking`，只在可访问父层明确返回 NotFound 时标记 `missing`；路径存在但项目数据确定无效、
不可读取或身份不匹配时返回 `unreadable`，保留记录并提供诊断/重新定位；权限、断盘和临时 I/O 返回
`check_failed`，保留记录并允许单项重试。这三种结果不得互相折叠。响应携带 checked path/generation，重定位或列表刷新后的
迟到结果不得覆盖当前路径。`available` 响应必须携带从已验证 `project.json` 派生的最新 `ProjectInfo`；
前端仅在 identity/path/generation 仍匹配且 `updated_at` 不倒退时合并生命周期字段。若同项目存在更新的
活动 Pipeline snapshot，则运行态和当前阶段以该 snapshot 为准；状态合并不得触发列表重排或焦点丢失。

新增 `relink_recent_project`：用户选择新目录后，Rust 同时验证 recent index 仍匹配旧 ID/path，且
候选 `project.json` ID 与原记录相同，再原子更新最近项目索引。ID 不同返回稳定冲突，原记录零修改；
只有用户显式选择“作为独立项目打开”后才调用现有 `open_project`。项目文件和素材不被修改。

现有 index writer 在 Windows 上先移除目标再 rename 临时文件，崩溃时存在目标缺失窗口；重定位实施
必须收敛该写入边界：为 `AppState` 增加独立 recent-index 写入锁，所有 create/record/open/remove/delete/relink 的
读取—校验—修改—安装—内存同步在同一锁域内串行化；临时文件写入并反序列化验证后，将旧索引
保留为 recovery/backup，再安装新索引，重读验证成功后清理备份；任一步失败回滚并释放锁，启动读取
时也能恢复遗留备份。不能把“使用了临时文件”误当成完整原子性证明。

**Rationale**: 当前 `list_recent_projects` 同步触碰每个 `project.json`，断开磁盘会拖慢完整列表；新增
快速只读命令避免改变既有 Tauri command 行为。
单项只读命令让搜索和菜单先可用，也不会扩大 WebView 文件权限。availability 是易过期的会话事实，
不应写入索引。原子 relink 把身份和并发验证留在 Rust 边界，避免把记录误指向另一个项目。
专用锁防止并发命令基于同一旧快照相互覆盖，可恢复替换则满足宪章对持久化原件保留、写后验证和
失败恢复的要求。只锁写事务，不让慢速 availability 探测持锁。

**Alternatives considered**:

- 在 `ProjectInfo`/recent index 持久化 availability：很快过期并改变现有 wire/index 格式。
- 单一批量探测完成后才返回：慢盘会阻塞其他记录和首屏。
- 前端直接访问文件系统或复用 `open_project`：扩大权限或产生 recent-index 副作用。
- 直接把选择的新路径写入索引：可能把记录指向另一个项目。
- 修改项目 Schema 保存原路径：无必要并引入迁移。
- 只依赖现有 `AppStateInner` 短时状态锁：磁盘读改写发生在锁外仍会丢更新，持锁执行慢 I/O 又会阻塞
  无关状态，因此采用独立 recent-index 写入锁。

## Decision 8 — 内部共享交互基元，不新增 UI 依赖

**Decision**: 建立小型 modal focus stack、roving focus 和 shortcut guard。Dialog/Drawer 打开时捕获
一次真实触发器，Tab/Shift+Tab 留在顶层 overlay，背景 inert，Escape 只关闭可安全取消的顶层，
关闭后恢复触发器。Menu/Tabs/Stage 按契约支持方向键、Home/End、Enter/Space。全局快捷键避让
编辑控件、`contenteditable`、ARIA editor、IME、`defaultPrevented` 与顶层 overlay。

**Rationale**: 现有三个以上组件重复实现不完整的 window listener 和焦点恢复；共享基元减少漂移，
无需引入新的 DOM/视觉框架。该设计遵循 WAI-ARIA APG 的焦点与键盘模型。

**Alternatives considered**:

- 引入第三方无障碍组件库：迁移面和依赖成本较大，本功能默认不采用。
- 每个组件继续手写：容易出现多层 Escape、焦点丢失和不一致 tabs。
- 立即迁移原生 `<dialog>`：现有 WebView/jsdom 行为需额外验证，不作为默认路径。

## Decision 9 — 单一、克制的状态朗读与可信进度

**Decision**: 壳层提供去重的 polite status announcer；只有阻断错误使用 assertive alert。只播报操作
开始/结果、Stage 变化、数据变 stale/恢复和危险操作回执；进度按阶段或有意义阈值节流，不播报每次
轮询、资源指标或日志。无可信历史依据时移除线性 ETA，展示当前阶段、实际单位或“正在估算”。

**Rationale**: 当前轮询频率高，多个 live region 会造成重复朗读；overall progress 不是匀速时间，
线性外推会制造虚假精度。

**Alternatives considered**:

- 整个工作区 `aria-live`：噪声过大。
- 每次百分比变化都播报：长任务会持续打断用户。
- 保留现有 ETA：与非线性 COLMAP/Brush 行为不符。

## Decision 10 — 单活动 Pipeline 使用前端预防与 Rust 权威门禁

**Decision**: 保留 `AppState.active_pipeline: Option<ActivePipeline>` 单例，不新增队列。Rust 将活动冲突
检查移动到 `start_pipeline` 的引擎/GPU 检查和任何目标项目写入之前；`resume_pipeline` 也必须先检查，
不能在被拒绝前把项目 B 写成 `Recovering`。前端从全局活动摘要预防所有 start/resume/rerun 入口；
若活动项目 A 与目标 B 不同，保持 B 页面和焦点，显示 A 的安全名称、状态/阶段与单步返回，不调用
启动命令。后端竞态拒绝后刷新同一摘要并呈现相同说明。创建并开始 B 时可以完成创建，但不得启动、
取消 A 或排队 B。

**Rationale**: 后端已有单例拒绝，但当前检查发生在昂贵 preflight 之后，且 `resume_pipeline` 会先写
`Recovering`，产生被拒绝项目的持久状态污染。双层保护提供即时解释，并让 Rust 保持最终权威。

**Alternatives considered**:

- 只依赖后端字符串错误：反馈晚，无法提供 A 的可靠摘要与返回入口。
- 只禁用按钮：其他启动入口和竞态仍可绕过，且不可聚焦 disabled 控件难以解释原因。
- 自动取消、自动排队或多 Pipeline：违背已确认行为和当前架构。

## Decision 11 — 自动化加真实 Windows 验收的双层验证

**Decision**: 使用现有 Vitest/jsdom/Testing Library 覆盖纯状态、错误、分页、键盘与组件行为；Rust
测试覆盖非阻塞逐项路径探测、NotFound/确定不可读/临时 I/O 的互斥分类、重定位零写入冲突、单活动早期门禁、
预览令牌过期/重放、分页边界和脱敏；CI Windows baseline 增加 `pnpm test`。
真实 Tauri 负责事件/轮询收敛、文件操作、Windows 1024×768 与 100%/125%/150% 缩放、高对比和
减少动画验证。

**Rationale**: jsdom 不能证明真实布局、系统缩放、WebView Tab 顺序或 Tauri 文件/事件行为。自动化
负责快速回归，实机矩阵验证平台特有风险。

**Alternatives considered**:

- 只做单元测试：无法证明桌面集成和布局目标。
- 只做手工测试：不可重复，无法作为合并门禁。
- 在本阶段引入完整端到端框架：依赖与维护成本超出当前范围；可在后续独立评估。

## Resolved Unknowns

- 不需要新状态、路由、查询或 UI 框架。
- 不需要项目 Schema、数据库或素材迁移。
- 现有活动分页和产物/Checkpoint 查询足够，不需要聚合接口。
- 后台仅允许一个活动 Pipeline；摘要不设计多任务队列。
- 第二项目启动被拒绝，不自动取消活动任务或排队；创建并开始可完成创建但跳过启动。
- availability 是非持久会话状态；临时检查失败不等于路径丢失。
- 重定位 ID 不匹配时原记录保持不变，候选项目仅在用户明确选择后独立打开。
- 影响预览过期、重放或状态变化时零写入并要求重新确认。
- ETA 在没有可信历史契约时不显示数值。
- 所有技术上下文与契约选择已确定，无剩余澄清项。
