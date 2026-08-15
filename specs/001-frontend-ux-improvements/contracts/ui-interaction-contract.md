# UI Interaction Contract

本契约约束前端页面、共享组件和状态管理。业务事实继续来自现有项目与 Tauri IPC；UI 不得凭空创建
Pipeline、产物、质量或恢复状态。

## 1. Page Context

| Context | Header content | Allowed primary controls | Prohibited content |
| --- | --- | --- | --- |
| Project Center | 应用/环境摘要，新建、打开、继续项目 | 新建、打开、打开活动项目 | 无项目 0%、ETA、项目运行按钮 |
| Project Creation | 步骤、当前目标、退出/返回、主提交 | 上一步、下一步、仅创建、创建并开始 | 未选择项目的运行栏 |
| Project Workspace | 项目、Phase/Stage、状态、可信进度 | start/pause/resume/cancel 和项目动作 | 其他项目的快照/错误 |

若后台有活动任务，所有 context 额外展示单一 `BackgroundTaskSummary`；点击一次进入对应项目。

若用户位于项目 B 且项目 A 正在运行，B 的页面仍可浏览，但所有会启动执行的操作显示持久的
`PipelineConflictNotice`：包含 A 的安全名称、状态/阶段、新鲜度和“返回 A”。Start 控件必须可聚焦，
使用 `aria-disabled=true` 和 `aria-describedby` 解释阻断原因；激活时不调用启动命令、不自动导航、
不取消 A、不创建队列。后端竞态拒绝必须归一到同一 notice。

## 2. Async Resource Contract

- 首次加载无 data：展示 skeleton/progress 与明确区域名称。
- 首次请求成功但结果为空：展示领域专用空状态和下一步，不得继续显示 loading 或泛化失败。
- 部分成功：保留并呈现已获得的数据，明确标记缺失范围；只有可安全重复时才提供重试，不得声称完整成功。
- 首次加载失败：展示 blocking error，并按准确 retryability 提供安全重试或适用的设置/诊断动作。
- 后续刷新：保留 data，区域标 `aria-busy=true`，不得闪回空状态。
- 后续刷新失败：保留 data，显示“最后更新于 …”和 stale 状态；不得显示为 0、正常或完成。
- 查询参数改变：生成新 request key；旧请求结果必须丢弃。
- Mutation：同一 action key 同时最多一个请求；按钮/快捷键重复触发不创建第二请求。
- Mutation 成功：显示 `ActionReceipt`，再刷新其 `affectedResources`。
- Mutation 失败：保留当前事实数据，显示可执行错误，不乐观声称成功；可能产生副作用的操作在重试前
  必须重新验证目标身份和当前影响，不得直接重放旧 mutation。
- 本功能触及的查询和 mutation 必须进入异步操作清单，并由测试逐项证明等待、成功、失败、准确
  retryability 以及仅在安全时可用的重试；主要 mutation 还要证明 action-key single flight。
- `desktopApi` 与 `useTauriCommand` 必须复用同一规范化 invoke/error 边界；页面、组件和其他 hook 不得
  直接调用 Tauri `invoke`，以确保每个错误都满足第 4 节。

## 3. Recent Project Availability Contract

- `list_recent_project_index` 成功后立即按索引顺序渲染列表；路径检查不得阻断搜索、菜单、打开或其他项目。
- 每个项目按 `projectId + checkedPath + generation` 原位更新；迟到响应不得覆盖已重定位/移除/刷新记录，
  也不得重排列表、关闭行菜单或抢走当前焦点。
- 检查采用有界并发（最多 4 个）。`checking` 使用可读文案和局部 `aria-busy`，不为每行建立 live region。
- `missing` 表示路径已确定不存在，文案不得声称“项目已删除”；可提供“重新定位”和“从最近项目移除”。
- `unreadable` 表示路径存在但项目数据确定无效、不可读取或身份不匹配；显示“项目数据不可用”及
  诊断/重新定位，不泄露原始异常或完整路径，不得映射为 `missing` 或 `check_failed`。
- `check_failed` 表示权限、断盘或临时 I/O 导致本轮无法判断；显示“暂时无法检查”“记录已保留”和
  可聚焦的单项“重试检查”，不得使用危险色义暗示项目丢失，也不得自动移除记录。
- Retry 同一记录同时最多一个请求。若结果更新使 Retry 消失，焦点回到该项目主按钮；不得落到 body。
- 状态朗读按批次合并，例如“18 个可用，1 个路径丢失，1 个暂时无法检查”；20–50 个逐项结果不得
  产生等量播报。用户主动 Retry 的单项结果可播报一次。
- 搜索始终基于已有名称和路径线索；未检查项不得从当前搜索结果消失。
- `available` 结果合并其最新 `ProjectInfo`，原位更新 ready/running/failed/completed 和 stage 文案；只有
  ID/path/generation 仍匹配且 `updated_at` 不倒退时才能合并，更新的活动 Pipeline snapshot 优先，且不得
  因状态变化重排列表、关闭菜单或移动焦点。

## 4. Error Contract

每个可见错误必须包含：

1. 用户标题与发生内容。
2. 对当前任务或数据的影响。
3. 稳定错误代码；旧字符串使用 command fallback code。
4. 至少一项建议。
5. 适用的直接动作。

Retry 只有在 `retryable=true` 且动作可安全重复时出现；否则必须呈现诊断、设置、返回或取消等非重放动作。

默认不显示 `technicalDetails`、raw metrics、stack、credentials、token 或完整本地路径。技术详情必须
折叠且经 redaction；打开日志必须通过后端安全路径白名单。`role=alert` 只用于阻断且需要立即处理的
错误；非阻断 stale/成功/进度变化使用 polite status。

## 5. Progress and Freshness Contract

- 无项目或尚未开始时，不渲染 `aria-valuenow=0` 的伪进度。
- 已知 determinate progress 使用 `progressbar`、合理范围和值描述。
- total/current 不可靠时展示 indeterminate/“正在估算”，不显示剩余分钟数。
- 只有存在经验证、同硬件/同方案的历史估算契约后，才允许显示范围与依据；本功能不创建该契约。
- Stage 改变、任务终态、stale 与恢复成功进入状态朗读；普通百分比最多按有意义阈值播报。

## 6. Modal Dialog and Drawer Contract

- 容器具有 `role=dialog`（危险确认可用 `alertdialog`）、`aria-modal=true` 和可见标题关联。
- 打开时捕获一次实际 trigger；普通 drawer 聚焦标题或首个有意义控件，危险确认聚焦“取消”。
- Tab/Shift+Tab 在顶层 overlay 内循环；背景不可交互并设 inert。
- Escape 只由栈顶处理；busy/不可取消状态不关闭，并通过 `aria-busy` 表达。
- busy 时至少保留可聚焦容器，不能使对话框成为零焦点区域。
- 关闭后恢复 trigger；trigger 已消失时聚焦稳定页面标题/后备目标。
- Backdrop click 仅适用于可安全取消的 overlay。

## 7. Menu Contract

- Trigger：`aria-haspopup=menu`、`aria-expanded`、`aria-controls`。
- Enter/Space/ArrowDown 打开并聚焦首个 enabled item；ArrowUp 打开末项。
- 菜单内 Up/Down 循环、Home/End 首末、Enter/Space 激活、Escape 关闭并回 trigger。
- Tab 关闭菜单并按正常页面顺序离开；disabled item 从 roving 顺序跳过。

## 8. Tabs and Stage Navigation Contract

### Horizontal tabs

- `tablist/tab/tabpanel` 的 id、`aria-controls`、`aria-labelledby` 成对。
- 只有 active tab 为 `tabIndex=0`；其他为 -1。
- Left/Right 循环，Home/End 首末；面板为即时本地内容时自动激活。
- Tab 从 active tab 离开到 panel 内下一个可聚焦对象。

### Phase and Stage

- Phase summary 使用原生 button、`aria-expanded` 与 `aria-controls`。
- Stage 保持语义列表+button，不使用含嵌套动作的错误 listbox 角色。
- Up/Down/Home/End 在 stage 主按钮间移动；Enter/Space 选择。
- 当前项用 `aria-current` 或 `aria-pressed`，状态文本可被辅助技术读取。

## 9. Shortcut Contract

应用或页面级快捷键在以下任一条件成立时必须退出：

- `event.defaultPrevented`；
- `event.isComposing` 或组合输入兼容标记；
- target 是 input、textarea、select、contenteditable；
- target/ancestor 是 textbox、searchbox、combobox、spinbutton 等编辑角色；
- 顶层 overlay 已处理该按键。

向导有未提交输入或复制任务时，Escape/导航必须先确认。核心动作必须始终有可聚焦按钮，快捷键不是
唯一入口。

## 10. Status Announcement Contract

- 应用只提供一个 visually-hidden polite status announcer，消息以稳定 semantic key 去重。
- 可播报：操作开始/成功/失败、Stage 改变、stale/恢复、危险操作结果。
- 用户尝试启动 B 被 A 阻断时，播报一次 assertive 拒绝消息并保持焦点在 B 的 Start；普通 A 状态刷新
  使用 polite。A 结束后保持 Start 焦点并播报其现在可用。
- 不播报：每次资源采样、每条活动记录、每次轮询、无意义的小百分比变化。
- 可见回执与 live message 同时存在；live region 不是信息的唯一载体。

## 11. Responsive and Visual Contract

- 1440×1024 是主布局，1024×768 为完整功能布局；不设计手机布局。
- <=1120px 保留 rail 与一次点击打开的完整项目 drawer；搜索、项目状态和项目菜单不可消失。
- 活动详情、预览/质量和关键错误在窄窗有可达 drawer/展开入口。
- 布局使用 `minmax(0, 1fr)`、wrap/stack、max-height 与内部滚动；不得依赖缩小文字隐藏溢出。
- Windows 125%/150% 缩放下主操作、标题和错误不能裁切。
- 状态不只靠颜色；focus-visible 覆盖所有交互元素；forced-colors 仍可识别。
- `prefers-reduced-motion` 下停止非必要 spinner/transition，并保留文字状态。

## 12. Relink Identity Conflict Contract

- 重定位提交前由 Rust 验证原 recent 记录仍匹配 ID/path，并读取候选目录的真实项目 ID。
- 候选属于另一个项目时，原记录/path/availability 原样保留，不乐观替换、不自动移除。
- 显示阻断错误“所选目录属于另一个项目”和“原记录未更改”，提供“选择其他位置”及
  “作为独立项目打开”；后者仅在用户显式激活时调用普通打开语义。
- 身份冲突后焦点到错误标题或安全的“选择其他位置”，不得默认落到独立打开动作。
- 若流程位于项目 drawer 内，错误和动作继续留在同一顶层 focus trap，Escape 不得一次关闭两层。

## 13. High-impact Action Flow

本功能新增或修改的 pause、cancel、rerun stage、restore/delete checkpoint、delete project 界面入口
均遵循下列流程；为兼容既有客户端保留的旧 Tauri mutation 不属于新 UI 调用路径，组件和 service
测试必须防止新界面直接调用这些旧入口：

```text
request preview token -> render target/impact -> safe default focus
-> user confirms with token -> single-flight mutation
-> success receipt + authoritative refresh
or failure UiError + preserve current facts
```

状态在预览后变化、令牌到期或令牌被重放时，mutation 必须在零写入状态下拒绝，不能使用过期确认：

1. 保持原 confirmation dialog 打开，停止 busy，将旧影响标记为“已过期”，禁用旧 Confirm。
2. 以 `role=alert` 明确“项目状态已变化，尚未执行任何操作”，然后自动请求最新预览。
3. 新预览返回后替换影响与令牌，清除旧勾选/arming 状态，并将焦点移到更新提示/标题；不得自动
   聚焦或触发新 Confirm，用户必须再次显式确认。
4. 最新预览若 `allowed=false`，不显示 Confirm，聚焦 Cancel 或恢复动作。
5. 刷新失败时保留旧预览仅供参考，Confirm 持续不可用，提供“重试刷新”和 Cancel。
6. 每次 stale cycle 只 assertive 播报一次；新说明完成后 polite 播报“影响说明已更新，需要重新确认”。
