# Data Model: 前端页面交互与用户体验优化

本文件描述 UX 层派生状态及有限 IPC 增量。除“最近项目索引重定位”外，新增实体均为运行时 UI
模型，不进入 `project.json`、Schema、Pipeline 持久状态、活动 JSONL 或用户素材。

## 1. PageContext

表示当前窗口的任务上下文，由现有 `Page` 和所选项目派生。

| Field | Type | Rules |
| --- | --- | --- |
| `kind` | `project_center \| project_creation \| project_workspace` | 必须与当前 `Page.type` 一致 |
| `title` | string | 用户语言，不能为空 |
| `description` | string | 解释当前页面目的，不包含原始路径 |
| `projectId` | string or null | 仅项目工作台存在 |
| `primaryAction` | action id or null | 当前唯一首要操作；禁用时必须有原因 |
| `backAction` | action id or null | 向导和项目工作台按上下文提供 |

**Relationships**: `project_workspace` 引用一个 `ProjectInfo` 和一个 `PipelineViewState`；其他上下文
不得展示项目运行控制。

## 2. AsyncResource<T>

统一表达查询数据、新鲜度和错误，而不在刷新时清空最后有效值。

| Field | Type | Rules |
| --- | --- | --- |
| `data` | `T \| null` | 最近一次成功值；refresh/stale 时保留 |
| `status` | `idle \| loading \| success \| refreshing \| stale \| error` | 见状态机 |
| `completeness` | `complete \| partial \| null` | 有成功 data 时必须存在；空集合可为 complete，partial 必须说明缺失范围 |
| `partialIssues` | `AsyncPartialIssue[]` | partial 时非空；每项只有安全 scope、`UiError` 与适用的 retry action key |
| `lastSuccessfulAt` | timestamp or null | 仅成功后更新，失败不覆盖 |
| `requestedAt` | timestamp or null | 当前/最近一次请求开始时间 |
| `error` | `UiError \| null` | success 时清空；stale/error 时存在 |
| `requestKey` | string or null | 用于拒绝被替换请求的迟到结果 |

### State transitions

```text
idle --load--> loading
loading --success--> success
loading --failure(no data)--> error
success --refresh--> refreshing
refreshing --success--> success
refreshing --failure(with data)--> stale
stale --refresh--> refreshing
stale --success--> success
stale --failure--> stale
error --retry(if retryable)--> loading
```

**Validation**:

- `loading` 和 `error` 可在 `data = null` 时阻断区域。
- `refreshing` 和 `stale` 必须有非空 data；否则规范化为 loading/error。
- `success + complete + 空集合` 是明确的空成功，必须呈现领域空状态而不是 loading/error。
- `success + partial` 必须保留已获得的 data，并携带安全的缺失范围；只有关联问题 `retryable = true`
  时才携带重试动作，不得伪装为完整成功。
- `completeness = null` 时 `partialIssues` 必须为空；`completeness = partial` 时至少包含一项且不得含原始路径。
- 完全失败使用 `error + data = null`；刷新失败使用 `stale + data != null`，两者不得混用。
- unknown 数值使用 `null`，不能自动转换为 `0`。
- Retry 只在关联 `UiError.retryable = true` 且存在已知安全动作时可用；可能产生副作用的 mutation 在重试前
  必须重新读取并验证目标身份和影响，不得直接重放旧请求。

## 3. PipelineViewState

按项目隔离的 Pipeline 快照及新鲜度。

| Field | Type | Rules |
| --- | --- | --- |
| `projectId` | string | map key，必须等于 snapshot.project_id |
| `snapshot` | existing `PipelineSnapshot \| null` | Rust/持久项目是事实源 |
| `freshness` | `AsyncResourceMeta` | 记录最后成功刷新与 stale/error |
| `lastSequence` | non-negative integer | 不接受更旧的活动快照 |
| `isActive` | boolean | 从状态和全局活动任务派生，不单独持久化 |

**Merge rules**:

1. 不同 `projectId` 永不互相覆盖。
2. 活动快照 `sequence < lastSequence` 被丢弃。
3. 打开项目产生的 `sequence = 0` 非终态不能覆盖更新的活动快照。
4. 活动任务退出后的 persisted terminal `sequence = 0` 可完成收敛。

## 4. BackgroundTaskSummary

由唯一活动 `PipelineViewState` 和 `ProjectInfo` 派生，不持久化。

| Field | Type | Rules |
| --- | --- | --- |
| `projectId` / `projectPath` | string | 必须来自同一 snapshot/project |
| `projectName` | string | 找不到项目记录时使用安全 fallback |
| `phaseId` | existing phase id or null | 根据 current stage 派生 |
| `stageId` | existing stage id or null | 技术详情可展开 |
| `status` | existing `ProjectStatus` | 不重新定义业务状态 |
| `progress` | number or null | 仅已知时展示 |
| `freshness` | current/refreshing/stale | stale 必须显示最后更新时间 |

全局最多存在一个摘要。目标项目与活动项目不同时，所有会启动执行的操作派生
`PipelineStartConflict`，但打开、浏览和切换项目仍保持可用。

### PipelineStartConflict

| Field | Type | Rules |
| --- | --- | --- |
| `targetProjectId` | string | 用户尝试启动的项目 |
| `activeTask` | `BackgroundTaskSummary` | 必须来自 Rust 活动 Pipeline 事实 |
| `status` | `blocked_active_project` | 不产生 queued/cancelling 状态 |
| `returnAction` | action id | 一次操作返回活动项目 |

状态转换为 `requested -> blocked_active_project`；活动项目与目标项目都不得被 mutation。若用户执行
“创建并开始”，项目创建可成功，但启动子步骤进入该阻断状态，且新项目不得写成 Running/Recovering。

## 5. UiError

所有用户错误展示的标准形态；来源可为结构化 AppError、JSON 字符串或 command fallback。

| Field | Type | Rules |
| --- | --- | --- |
| `code` | string | 结构化错误码优先；fallback 使用稳定的 `UI-*` 码 |
| `category` | user/environment/media/engine/filesystem/resource/internal/unknown | 未知不得假装具体类别 |
| `title` | string | 简短用户语言 |
| `message` | string | 发生内容，不含未脱敏技术详情 |
| `impact` | string | 说明受影响的任务/数据 |
| `suggestions` | string[] | 至少一项可执行建议 |
| `retryable` | boolean | 必须由 payload 或 command catalog 按操作安全性决定；未知时为 false |
| `actions` | `UiErrorAction[]` | 仅允许已知安全动作 |
| `technicalDetails` | string or null | 默认折叠，显示/复制前脱敏 |
| `logReference` | safe relative reference or null | 不接受任意绝对路径打开 |

### UiErrorAction

`retry | recheck | open_settings | show_activity | reveal_safe_log | export_diagnostics | dismiss`。
每个 action 包含 label、enabled、disabledReason；仅当 `retryable = true` 时允许 `retry/recheck`。可能产生
副作用的操作不得把旧 mutation 直接映射为 Retry，必须先重新验证当前目标与影响；组件不得执行合同外任意命令。

## 6. RecentProjectAvailability

最近项目目录的会话级读取健康状态，按稳定的 `projectId + checkedPath` 保存于前端 AppContext，
不属于 `ProjectInfo`，也不写入 recent index。

```text
unknown -> checking -> available
                    -> missing
                    -> unreadable
                    -> check_failed -> checking (单项重试)
missing/unreadable -> relinking -> available
                              -> mismatch/check_failed (失败保留原记录)
```

| Field | Type | Rules |
| --- | --- | --- |
| `projectId` | string | 必须仍存在于当前 recent list |
| `checkedPath` | string | 必须等于当前记录 path；否则响应作废 |
| `generation` | integer | 列表刷新/重定位递增；拒绝迟到响应 |
| `status` | `unknown \| checking \| available \| missing \| unreadable \| check_failed` | 见下表 |
| `checkedAt` | timestamp or null | terminal result 时存在 |
| `reasonCode` | safe enum or null | check_failed/unreadable 使用，不含原始路径或 OS 错误 |
| `retryable` | boolean | check_failed 的只读检查为 true；unreadable 不是同请求重试，改用诊断/重新定位；其他按安全动作决定 |
| `refreshedProject` | `ProjectInfo \| null` | available 必须存在；仅通过匹配和新鲜度校验后合并 |

| Value | Meaning |
| --- | --- |
| `unknown` | 索引已经显示但尚未调度检查 |
| `checking` | 单项只读检查进行中；不阻断列表或其他记录 |
| `available` | 路径存在、是目录且项目 ID 可验证 |
| `missing` | 可访问的父层已明确确认目标路径不存在 |
| `unreadable` | 路径存在，但内容确定不是该项目或项目数据确定无效 |
| `check_failed` | 权限、磁盘断开或临时 I/O 导致本轮无法得出事实；必须保留记录并可重试 |

列表成功后立即可搜索和操作，检查最多 4 个并发且逐项原位更新。`check_failed` 表示当前检查结果，
但不得触发移除或把记录当作 `missing`；批次或单项重试会创建新 generation/request key。

`available` 结果的 `refreshedProject` 只有在 ID、path、generation 仍与当前行匹配，且 `updated_at` 不早于
当前 `ProjectInfo` 时才能合并。合并更新 ready/running/failed/completed 等生命周期状态和 stage label，
保持 recent index 顺序、行实例、已打开菜单和焦点不变；同项目的更新 Pipeline snapshot 对活动运行态和
当前阶段具有更高优先级，避免较慢的路径检查覆盖较新的执行事实。

### RelinkAttempt

| Field | Type | Rules |
| --- | --- | --- |
| `projectId` / `previousPath` | string | 必须仍精确匹配 recent index 记录 |
| `candidatePath` | string | Rust 边界验证的真实目录 |
| `candidateProjectId` | string or null | 仅安全验证成功时获得 |
| `outcome` | `matched \| mismatch \| unavailable \| conflict` | 只有 matched 允许索引写入 |

`mismatch` 必须保持原记录与路径不变；候选目录只有在用户明确选择后才通过普通 `open_project`
作为独立项目打开。

### RecentProjectIndexTransaction

服务端运行时的串行化边界，不改变 `recent-projects.json` 格式。

| Field | Type | Rules |
| --- | --- | --- |
| `lock` | application-scoped mutex | 所有 recent-index 读改写命令共享；availability 只读探测不得持有 |
| `expectedRecord` | project ID + previous path or null | relink/remove 等条件更新在锁内重新校验 |
| `candidate` | `ProjectInfo[]` | 从锁内读取的最新索引派生，禁止从过期调用方快照覆盖 |
| `recoveryPath` | internal path or null | 新索引安装与回读完成前保留旧数据 |

```text
waiting -> locked -> source_validated -> candidate_validated -> installed -> read_back_validated -> committed
                    -> rejected/conflict (零写入)
                    -> failed -> rolled_back -> unlocked
```

应用状态中的 recent list 只在持久索引 commit 后、仍处于同一事务锁域时同步。任何错误或 panic-safe
提前返回都必须释放锁；并发 create/record/open/remove/delete/relink 以获得锁后的最新索引为准，不能丢失另一事务
已提交的记录。

## 7. ActivityQuery and ActivityPageState

复用现有 `get_pipeline_events`。

| Field | Type | Rules |
| --- | --- | --- |
| `projectPath` | string | 必填 |
| `stageId` | stage id or null | 与所选 Stage 联动 |
| `severity` | info/warning/error or null | 单值筛选；“全部”为 null |
| `search` | string | trim 后传递；空串为 null |
| `cursor` | integer or null | 首屏 null；继续加载使用 next_cursor |
| `items` | event records | 按 sequence 去重并升序合并 |
| `nextCursor` | integer or null | null 表示无更多记录 |
| `total` | integer | 当前筛选后的总数 |
| `resource` | `AsyncResourceMeta` | 失败保留现有 items 并标 stale |

查询条件变化会清空 cursor 和旧筛选结果，但被替换请求的迟到结果不得写入当前列表。

## 8. WorkspaceActionRequest and ActionImpactPreview

### Request

| Field | Type | Rules |
| --- | --- | --- |
| `projectId` | string | 与 projectPath 中项目 ID 匹配 |
| `projectPath` | string | Rust 边界重新验证 |
| `action` | pause/cancel/rerun_stage/restore_checkpoint/delete_checkpoint/delete_project | 封闭联合类型 |
| `stageId` | stage id or null | 仅 rerun_stage 必填 |
| `checkpointIteration` | integer or null | Checkpoint 动作必填 |

### Preview

| Field | Type | Rules |
| --- | --- | --- |
| `action` | request action | 必须匹配请求 |
| `targetLabel` | string | 用户安全目标，不返回不必要绝对路径 |
| `allowed` | boolean | false 时 `blockedReason` 必填 |
| `irreversible` | boolean | 删除类为 true；暂停/取消按实际语义 |
| `preserved` | string[] | 已验证且保留的阶段/产物 |
| `invalidated` | string[] | 会失效/归档的下游内容 |
| `regenerated` | string[] | 后续会重建的内容 |
| `warnings` | string[] | 包括“不恢复优化器状态”等限制 |
| `sizeBytes` | integer or null | 可安全计算时返回 |
| `previewToken` | opaque string | 绑定 action、target 与影响指纹，仅供一次提交 |
| `createdAt` / `expiresAt` | timestamp | 签发后 10 分钟到期；到期必须重新预览 |

预览只读。影响指纹只包含会改变影响范围的事实（项目身份/状态、活动 run/stage/control intent、
Checkpoint identity/current/validity、相关产物），不得包含连续 progress 等无关变化。

`impactFingerprint` 仅存在于服务端 token registry 记录，不属于序列化到前端的 Preview 字段；前端只
持有不透明 `previewToken`。

```text
issued -> consumed (指纹仍匹配，mutation 执行一次)
       -> stale (影响事实变化，零写入并返回最新预览)
       -> expired (超时，零写入并重新预览)
       -> replayed (已消费令牌再次使用，零写入)
```

前端 stale 后保持确认界面打开，将旧说明标记为过期，载入新预览并清除旧确认状态；用户必须针对
新令牌再次显式确认。

## 9. ActionReceipt

高影响操作完成后的持续可见回执，不写入项目格式。

| Field | Type | Rules |
| --- | --- | --- |
| `id` | unique runtime id | 防止重复播报 |
| `action` | workspace action | 必填 |
| `status` | success/error | loading 由 mutation state 表达 |
| `title` / `message` | string | 用户语言、已脱敏 |
| `completedAt` | timestamp | 必填 |
| `affectedResources` | resource keys[] | 决定成功后的显式刷新 |
| `dismissible` | boolean | 失败/危险成功不得自动立即消失 |

## 10. OverlayState

共享 modal stack 的运行时模型。

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | 栈内唯一 |
| `kind` | dialog/drawer/menu | menu 可使用独立 roving 合约 |
| `trigger` | element reference | 只在打开时捕获一次，不序列化 |
| `busy` | boolean | busy 时 Escape/backdrop 关闭被禁用 |
| `returnFallbackId` | string or null | trigger 不可用时的稳定焦点目标 |

只有栈顶 overlay 处理 Escape/Tab；所有 overlay 关闭后必须恢复背景 inert 状态。

## Persistence and Migration Assessment

- `project.json`、JSON Schema、Pipeline state、COLMAP SQLite 和素材：无变化。
- 最近项目索引：availability 不写入。所有读改写事务使用应用级专用锁串行化；重定位使用 temp write +
  parse validation + recovery copy + replace + read-back validation；新索引验证成功前旧索引始终有可恢复
  副本，失败回滚，启动读取可恢复遗留副本。
- 预览令牌与活动冲突状态：仅运行时内存数据，应用重启后失效。
- UI runtime entities：应用重启后重新派生，不需要迁移。
- 因此本功能不增加 schema version，也不需要数据库迁移计划。
