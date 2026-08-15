# Quickstart Validation: 前端页面交互与用户体验优化

本指南用于验证实现满足 [spec.md](./spec.md)、[data-model.md](./data-model.md) 以及
[UI](./contracts/ui-interaction-contract.md)/[IPC](./contracts/tauri-ipc-contract.md) 契约。

## 1. Prerequisites

- Windows 10/11 x64。
- Rust 1.97.0（`x86_64-pc-windows-msvc`）。
- Node.js 22 与 pnpm 11.12.0。
- Windows SDK、Visual Studio C++ Build Tools 和 Tauri 2 Windows prerequisites。
- 已按 lockfile 安装依赖：

```powershell
pnpm install --frozen-lockfile
```

前端单元/组件验证不需要 FFmpeg、COLMAP、Brush 或私有媒体。真实 Pipeline 场景使用本地合法测试
素材与已校验引擎，不得把媒体、日志、路径或诊断包提交到仓库。

## 2. Automated Quality Gate

在仓库根目录运行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:ux:automated
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
pnpm --dir apps/desktop tauri build --debug --no-bundle
```

Expected:

- 所有命令退出码为 0；lint/Clippy 无 warning。
- CI Windows baseline 包含并通过 `pnpm test`。
- `pnpm test:ux:automated` 使用生产前端、Microsoft Edge CDP 管道与纯合成 Tauri IPC 数据，输出脱敏
  JSON/截图到已忽略的 `.test-results/ux-automation/`；17 项浏览器级预检与三组 20 次计时必须通过。
- Windows Tauri debug build 成功生成应用构建产物；该命令失败时不得进入实机验收或发布。
- 没有修改 project/schema fixtures 的迁移要求。

浏览器级预检用于尽早发现页面上下文、响应式布局、键盘焦点、辅助媒体查询和明显时序回归；它不能替代
第 4–7 节要求的真实 Tauri/WebView2、Windows 睡眠/缩放、外部进程、旧项目 checksum、真实参与者或独立签署。

### 2.1 Optional native Fast pipeline automation

在一个终端中以已校验引擎包启动 debug Tauri 应用，并为 WebView2 开启仅限本机的 CDP 端口。另一个终端
设置以下环境变量后运行原生 Fast 验证：

```powershell
$env:METORIGIN_TEST_VIDEO='<licensed-test-video>'
$env:METORIGIN_TEST_PROJECT_ROOT='<isolated-output-root>'
$env:METORIGIN_NATIVE_REPORT_DIR='<ignored-report-directory>'
$env:METORIGIN_EXPECTED_SOURCE_SHA256='<approved-sha256>'
$env:METORIGIN_TAURI_DEBUG_PORT='9231'
pnpm test:tauri:native-fast
```

脚本通过真实 `tauri.localhost` WebView2 和 Tauri IPC 执行媒体分析、preflight、项目创建、Fast Pipeline、
暂停/恢复、在真实 Brush Checkpoint 后取消/恢复、最终 artifact/PLY 校验和源文件前后 SHA-256 比较。
输出只写入已忽略的报告目录；输入素材和隔离项目目录必须不同。脚本不替代系统睡眠/恢复、Windows
缩放/高对比、代表性旧项目和人工可用性验证。

Fast 项目完成并至少存在两个合法 Checkpoint 后，可以运行受控引擎故障恢复验证：

```powershell
$env:METORIGIN_TEST_PROJECT_PATH='<isolated-completed-project>'
$env:METORIGIN_TEST_VIDEO='<licensed-test-video>'
$env:METORIGIN_NATIVE_REPORT_DIR='<ignored-report-directory>'
$env:METORIGIN_EXPECTED_SOURCE_SHA256='<approved-sha256>'
$env:METORIGIN_TAURI_DEBUG_PORT='9231'
pnpm test:tauri:native-failure-recovery
```

该脚本先断言没有既存 Brush 进程，再恢复最早的合法 Checkpoint，仅终止本次测试新出现的唯一
`brush_app`。它要求项目进入本地化 `E-4003` 失败、释放全局 active slot、保留 Checkpoint，随后显式
Retry 到 Completed 并复核 artifact、PLY 与源视频哈希。脚本必须以具备终止其测试子进程权限的会话运行；
出现多个候选 Brush 进程时会拒绝注入故障。

## 3. Focused Automated Scenarios

### 3.1 Page context and background task

1. 为 home、new-project、project-detail 渲染 App shell。
2. 断言 home/向导没有项目 0%、ETA 或不可用运行控制。
3. 注入一个运行 snapshot，导航回 home。
4. 断言后台摘要仍存在，点击一次回到正确项目。
5. 注入另一项目的旧 sequence，断言不串项目、不覆盖新状态。
6. 注入项目 A 活动状态并停留在 B；断言 B 的 Start 可聚焦且关联冲突说明，click/Enter 不调用
   `startPipeline(B)`，焦点仍在 Start；“返回 A”一次操作导航并聚焦 A 工作台标题。
7. 模拟前端未知冲突但后端拒绝，断言刷新活动摘要后归一为同一说明；A 结束后 B Start 原位恢复可用。

### 3.2 Recent project availability and relink

1. mock 快速 recent index 返回 20–50 条记录，并让全部 availability Promise 保持 pending；断言列表、
   名称/路径搜索和菜单已经可用。
2. 乱序完成 `available/missing/unreadable/check_failed`，断言逐项原位更新、不重排、不抢焦点，
   同时进行的检查不超过 4 个。
3. 让 available 响应依次携带 ready/running/failed/completed 的 `refreshed_project`，断言生命周期和
   stage 文案原位更新；旧 `updated_at` 不倒退状态，同项目更新的活动 Pipeline snapshot 不被慢探测覆盖。
4. 让路径存在但项目数据损坏、不可读取或 ID 不匹配，断言显示“项目数据不可用”、记录保留及
   诊断/重新定位入口，且绝不显示为“路径丢失”或“暂时无法检查”。
5. 断言权限、断盘或临时 I/O 显示“暂时无法检查”“记录已保留”和单项 Retry，且绝不显示为
   “路径丢失/项目已删除”。连续触发 Retry 只调用一次。
6. 列表刷新、移除或重定位后返回旧 checked path/generation，断言迟到结果被丢弃。
7. 重定位到另一 Project ID，断言 `UI-PROJECT-RELINK-MISMATCH`、原记录/path 不变且普通
   `openProject` 尚未调用；用户显式选择“作为独立项目打开”后才打开候选，原记录仍保留。

### 3.3 Async freshness

1. 首次 load：无 data 时显示 loading。
2. 空成功：返回完整空集合，断言领域空状态和下一步出现，loading/error 消失。
3. 部分成功：同时返回已有数据和缺失范围，断言已有数据可用且 partial 标识可见；仅在对应问题
   `retryable=true` 时显示 Retry，且不声称完整。
4. success 后 refresh：旧 data 保持，区域标 refreshing。
5. refresh failure：旧 data 保持并标 stale/最后更新时间。
6. 完全失败：无 data 时显示 blocking error；仅当操作可安全重复时显示 Retry，否则显示诊断/设置等
   非重放恢复动作，不伪装为空状态。
7. retry success：对 `retryable=true` 的操作重试后移除 stale/error 并更新时间；对不可安全重试的错误
   断言无 Retry。
8. 替换查询参数后返回旧请求：结果被丢弃。
9. 对本功能异步操作清单逐项触发等待/成功/失败并核对准确 retryability；仅安全操作提供 Retry，
   可能产生副作用的 mutation 必须先重新验证当前目标/影响。对主要 mutation 连续 click、Enter 和快捷键，
   断言同一 action key 同时只发出一个请求。

### 3.4 Errors and redaction

分别输入结构化错误、JSON 字符串、中文字符串和非中文异常，断言均生成 code/title/message/impact/
suggestion/action。使用如下 canary 值：

```text
token=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE
C:\Users\PrivateUser\Projects\secret-scene.splat-project
```

默认错误、复制文本、活动详情和诊断测试输出不得包含 canary、`PrivateUser` 或完整路径。
仓库审计还必须证明本功能页面、组件和 hook 中不存在绕过 `desktopApi`/共享 helper 的裸 Tauri `invoke`，
并验证现有 `useTauriCommand` 对所有错误格式返回同一 `UiError` 形态。

### 3.5 High-impact actions

对 pause、cancel、rerun stage、restore/delete checkpoint、delete project：

1. 先请求 impact preview。
2. 断言目标、保留/失效/重建内容与 warning 正确。
3. 默认焦点位于取消；重复 Enter/click 只提交一次。
4. 预览 v1 后改变 Pipeline/Checkpoint/项目影响事实，再提交 v1 token；断言返回 stale + v2、
   所有文件/状态零变化、dialog 保持打开、旧 Confirm 禁用且焦点移到更新提示。
5. 重复 Enter 或重放 v1 token 不执行；只有用户针对 v2 再次显式确认才执行一次。
6. 令牌超时、已消费、action/target 不匹配均拒绝；v2 `allowed=false` 时不显示 Confirm。
7. 最新预览刷新失败时旧说明仅供参考，Confirm 不可用且提供 Retry/Cancel。
8. 成功后显示持久回执并刷新对应事实源。

### 3.6 Keyboard and focus

- Dialog/Drawer：Tab/Shift+Tab 循环、Escape、busy、不泄漏背景、关闭回 trigger。
- Menu：ArrowUp/Down、Home/End、Enter/Space、Escape、Tab。
- Tabs：Left/Right、Home/End、关联 panel 与单一 tab stop。
- Stage：Up/Down、Home/End、Enter/Space 与当前状态语义。
- 快捷键：input/textarea/select/contenteditable、IME、defaultPrevented、顶层 overlay 时不导航。

### 3.7 Activity scale

使用 1,000 条不含敏感信息的合成事件：

- cursor 分页无重复/遗漏；
- stage/severity/search 条件变化重置分页；
- 在 2 秒内定位目标警告/错误；
- 刷新失败保留现有记录并标 stale；
- live region 不逐条播报轮询事件。

计时使用固定 release build、同一台验收设备和单调时钟，从筛选条件提交到目标行可见且可聚焦；预热
一次后执行至少 20 组固定查询，记录每次耗时并断言第 95 百分位不超过 2 秒。测试输出只记录合成 ID。

### 3.8 Rust contract boundaries

- 快速 recent-index 命令不访问任何项目目录；单项探测覆盖 matching available、明确 NotFound、
  invalid project、PermissionDenied/断盘/临时 I/O 分类，且所有检查都不写索引或项目。
- relink 覆盖 ID 匹配的可恢复索引替换、ID mismatch/旧路径竞态零写入，以及候选项目不会被自动打开。
- recent-index writer 覆盖临时文件解析失败、替换失败、写后重读失败和启动时遗留 recovery 文件；
  每个失败点都能恢复旧索引，不能留下空索引或半写 JSON。
- 并发启动 create/record/open/remove/delete/relink recent-index 事务，断言共享锁内基于最新索引重做条件校验，
  最终无静默丢更新；注入事务失败后确认锁已释放且下一次写入/启动恢复成功。慢速 availability 探测
  不得持有该写入锁。
- A 活动时 B 的 start/resume 在 engine/GPU preflight 与任何 `project.json` 写入前拒绝；A 不收到
  cancel，B 不变为 Recovering，且不存在队列。
- preview token 覆盖 10 分钟超时、action/target 不匹配、影响指纹变化、单次消费和重放；所有拒绝
  均断言文件与业务状态零变化，新 token 明确确认后才执行一次。
- 直接调用 command handler 验证 `get_active_pipeline_summary` 的 active/null/error payload；对六种 action
  逐一执行 preview→execute contract round trip，并覆盖 malformed request、allowed=false、completed/
  stale/expired/replay 判别联合。兼容测试继续调用旧 mutation 签名，另断言新 UI service/component
  没有直接调用旧入口。

## 4. Real Tauri End-to-End Scenarios

启动桌面应用：

```powershell
pnpm tauri dev
```

### Scenario A — 项目中心与创建

1. 启动应用，确认项目中心无无意义运行栏。
2. 进入三步向导，检查当前步骤、继续条件与唯一主操作。
3. 选择有效素材，切换目标目录后确认旧 preflight 失效并重新检查。
4. 在项目名称输入框使用 Ctrl+N/Ctrl+O/组合输入，确认不会离开向导。
5. 开始复制，确认进度、重复提交防护和安全取消结果。

### Scenario B — 跨页面活动任务

1. 打开有效项目并开始 Pipeline。
2. 返回项目中心；确认后台摘要在 2 秒内更新且可一步返回。
3. 运行中切换到另一个项目；确认状态不串线。
4. 尝试启动第二项目；确认请求在前端已知冲突时不发送，竞态发送时 Rust 在引擎/GPU 检查及项目
   状态写入前拒绝。活动项目继续运行，目标项目不变为 Running/Recovering，不出现队列。
5. 使用“创建并开始”创建另一个项目；确认创建完成但启动被跳过，回执显示活动项目与单步返回。
6. 暂时制造刷新失败；确认旧状态保留并标陈旧，恢复后自动收敛。
7. 关闭并重开应用、执行一次系统休眠/恢复，并在测试引擎中止一个外部进程；确认活动状态最终从
   权威持久状态恢复或进入带直接恢复动作的失败状态，不显示虚假 Running/成功，也不创建第二任务。

### Scenario C — 失败与恢复

1. 使用可控方式产生一个可恢复阶段失败。
2. 确认错误包含发生内容、影响、代码、建议和日志/重试动作。
3. 选择重跑，检查 impact preview 与真实失效范围一致。
4. 确认后只执行一次，完成后状态、活动、产物和回执一致。

### Scenario D — Checkpoint 与删除

1. 打开包含多个合法 Checkpoint 的测试项目。
2. 恢复旧 Checkpoint：确认提示后续 Checkpoint/产物影响与优化器限制。
3. 删除 Checkpoint：唯一或当前恢复点必须阻断；其他恢复点需确认。
4. 删除项目：目标、范围、不可撤销性明确；取消为默认焦点；成功后记录和目录状态一致。
5. 预览后从可控测试入口改变 Checkpoint 集合或项目活动状态，再提交旧令牌：确认返回 stale、
   未删除/恢复/失效任何数据、dialog 原位刷新并必须二次确认；已消费令牌重放仍被拒绝。

### Scenario E — 项目路径丢失与重定位

1. 准备一个有效、一个确定缺失、一个确定内容无效，以及一个位于断开卷/受限目录的最近项目记录。
2. 启动应用，确认索引列表先显示且可立即搜索；路径状态随后逐项更新为
   available/missing/unreadable/check_failed，慢项目不阻断其他记录。
3. 对 unreadable 确认“项目数据不可用”、记录保留和诊断/重新定位入口；确认它与 missing/check_failed
   的文案、色义和可用动作不同。
4. 对 check_failed 确认“暂时无法检查”、记录保留和 Retry；重新连接磁盘/恢复权限后单项重试收敛。
5. 对 missing 选择错误项目目录，确认 ID mismatch，比较操作前后 recent index 内容不变；模拟索引
   安装/重读失败时确认旧索引从 recovery 副本恢复。
6. 显式选择“作为独立项目打开”，确认候选作为新记录打开而原 missing 记录仍存在。
7. 选择同一项目的新目录，确认 recent index 原子更新并可正常打开，旧 availability 响应不会覆盖新路径。

## 5. Window, Scaling, and Accessibility Matrix

在真实 Tauri/WebView 中逐项执行，不以 jsdom 或浏览器 viewport 代替：

| Window | Windows scale | Required checks |
| --- | --- | --- |
| 1440×1024 | 100% | 完整三栏、活动、设置、Checkpoint、危险确认 |
| 1024×768 | 100% | rail 一次打开完整项目抽屉；运行/错误/预览入口可达 |
| 1024×768 | 125% | 无核心文字/按钮裁切；overlay 可滚动；焦点可见 |
| 1024×768 | 150% | 核心流程可完成，无横向内容丢失 |

额外开启：

- Windows 高对比/forced colors：状态、选择、危险操作和焦点不只靠颜色。
- Reduce motion：非必要动画停止，文字仍表达 loading/running。
- 仅键盘：新建、打开/切换、活动筛选、错误恢复、取消危险操作全部可完成。
- 长中文名称、长路径、1,000 条活动：内部滚动和完整值访问不遮挡 sticky 主操作。

## 6. Compatibility and Safety Checks

1. 打开至少一个功能实现前创建的代表性项目。
2. 完成 open/start/pause/cancel/resume/preview/export 原有操作。
3. 比较测试前后 `project.json` schema version 与用户素材 checksum；两者不得因 UX 功能变化。
4. 确认既有 command/event 调用仍可用，老格式字符串错误仍能展示。
5. 确认 `ProjectInfo`、recent-index JSON、`project.json` 与既有 mutation 调用仍兼容；availability 和
   preview token 不写入任何持久格式。
6. 检查 Git status：不得出现媒体、项目目录、日志、诊断包、环境文件或 canary secret。
7. 检查 `CHANGELOG.md` 的 Unreleased 段以及 `docs/architecture.md`、`docs/development.md`：必须记录
   用户可见变化、新增兼容 commands、旧命令保持可用、无需项目/schema 迁移和 Windows Tauri build 门禁。

## 7. Acceptance Evidence

在 Pull Request 记录：

- 自动化命令与结果摘要。
- 1440×1024 和 1024×768（100%/125%/150%）截图，但先移除私人路径和项目名。
- 键盘路径结果与焦点恢复证据。
- 代表性旧项目兼容结果。
- 若运行真实引擎：引擎版本、GPU/driver、输入来源/许可、命令与结果；不得附私有输入。
- 受控可用性测试对 SC-001、SC-002、SC-004、SC-005、SC-012 的汇总，不记录个人敏感数据。

### 7.1 Controlled usability protocol

1. 招募至少 10 名此前未使用本应用、但具备桌面创作工具基础经验的目标用户；分配匿名参与者编号。
2. 使用 [spec.md](./spec.md) `Acceptance Measurement Protocol` 定义的固定环境、任务脚本、计时起止点、
   错误清单和 5 分量表；测试期间不给操作提示。
3. 对 SC-001/002/004/005 记录每个匿名参与者或恢复尝试的 pass/fail 与耗时，对 SC-012 仅记录两个
   固定问题的分值；比例阈值人数向上取整并报告中位数，不记录姓名、声音、私人路径或媒体。

### 7.2 Timing protocol

1. SC-003 列出六条旅程的全部主异步操作，使用单调时钟从激活到可见 busy 状态逐项计时，每项必须
   在 1 秒内且重复激活只产生一个任务。
2. SC-009 使用至少 20 次受控阶段/终态/活动/Checkpoint/产物变化，从权威变化发生到可见更新或 stale
   标记计时，至少 95% 不超过 2 秒。
3. SC-010 使用固定 1,000 条合成记录和至少 20 组筛选，预热一次后记录第 95 百分位；release build、
   Windows 版本、CPU/内存、显示缩放和运行次数写入脱敏验证记录。
4. 任何未达阈值的场景记录可复现步骤与残余风险，不能只写“人工观察通过”。
