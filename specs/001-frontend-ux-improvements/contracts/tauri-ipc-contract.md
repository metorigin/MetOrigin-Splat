# Tauri IPC Contract

本契约区分“必须保持的既有接口”和“为 UX 新增的向后兼容接口”。所有路径在 Rust 边界重新验证；
前端不得把本契约当作任意本地文件访问能力。

## 1. Existing Contracts That Remain Stable

以下 command/event 的名称、参数和核心响应语义不得因本功能改变：

- `list_recent_projects`, `open_project`, `remove_recent_project`, `delete_project`
- `start_pipeline`, `get_pipeline_state`, `pause_pipeline`, `cancel_pipeline`, `resume_pipeline`
- `retry_stage`, `rerun_from_stage`, `accept_colmap_quality_risk`
- `get_pipeline_events`, `get_project_artifacts`, `list_checkpoints`
- `restore_checkpoint`, `delete_checkpoint`, `open_project_location`
- `get_app_settings`, `save_app_settings`, `check_engines`, `get_resource_metrics`
- `export_diagnostics`
- `pipeline://event` and existing PipelineSnapshot sequence semantics

活动列表继续支持 `stageId`, `severity`, `search`, `cursor`, `limit`；前端必须实际消费
`next_cursor`，不新增聚合接口。

以下新增命令独立于上述接口：`list_recent_project_index`、`check_recent_project_availability`、
`relink_recent_project`、`get_active_pipeline_summary`、`preview_workspace_action` 和
`execute_workspace_action`。它们不改变任何既有命令名称、参数或响应语义。

## 2. Non-blocking Recent Project Availability

`list_recent_projects` 的名称、参数、`ProjectInfo[]` 响应和刷新语义保持不变。新增快速只读命令
`list_recent_project_index() -> ProjectInfo[]`，仅读取持久 recent index 并尽快返回，不同步逐目录
探测，也不调用会修改 recent index 的 `open_project`。新 UX 使用快速命令先渲染；`ProjectInfo` 和
recent-index JSON 格式不增加 availability 字段。

### Command

`check_recent_project_availability`

### Request

```json
{
  "projectId": "recorded-project-id",
  "projectPath": "E:\\projects\\scene.splat-project"
}
```

### Success response

```json
{
  "project_id": "recorded-project-id",
  "checked_path": "E:\\projects\\scene.splat-project",
  "availability": "available | missing | unreadable | check_failed",
  "checked_at": "2026-08-13T12:00:00Z",
  "reason_code": null,
  "refreshed_project": {
    "id": "recorded-project-id",
    "name": "Scene",
    "path": "E:\\projects\\scene.splat-project",
    "status": "running",
    "updated_at": "2026-08-13T11:59:59Z",
    "stage_label": "优化"
  }
}
```

Rules:

- command 为 async；阻塞文件系统探测放入 `spawn_blocking`，每次只检查一条记录。
- 只有可访问父层明确确认目标 NotFound 时返回 `missing`；不得使用会把 I/O 错误折叠为 false 的
  `Path::exists()` 作为唯一判据。
- 权限、卷断开、超时或临时 I/O 返回 `check_failed`；路径存在但内容确定不是该项目或项目数据确定
  无效返回 `unreadable`。两者均不得删除或更新 recent index。
- 路径与 `project.json` ID 匹配时返回 `available`，并且 `refreshed_project` MUST 携带本次读取所得的最新
  `ProjectInfo`，使列表可原位更新 ready/running/failed/completed 和 stage 状态；其他 availability 值的
  `refreshed_project` MUST 为 null。
- 前端只有在 project ID/path/generation 仍匹配且 `updated_at` 不倒退时才能合并 `refreshed_project`；
  同项目更新的活动 Pipeline snapshot 对运行态/当前阶段优先，合并不得改变 recent index 顺序。
- availability 检查不得迁移或写入项目，不执行引擎，不读取用户媒体内容。
- 前端最多并发 4 个检查；`unknown/checking` 是 UI 状态，不是 IPC 或持久字段。

## 3. Relink Recent Project

### Command

`relink_recent_project`

### Request

```json
{
  "projectId": "existing-project-id",
  "previousPath": "D:\\old\\scene.splat-project",
  "candidatePath": "E:\\moved\\scene.splat-project"
}
```

### Success response

返回完整 `ProjectInfo`，`path = candidatePath`；前端随后单独刷新 availability。

### Validation

1. recent index 中必须仍存在同时匹配 `projectId + previousPath` 的记录。
2. candidatePath 必须是非 symlink 的真实目录并包含可读取 `project.json`。
3. 打开后的项目 ID 必须等于 `projectId`；不得只按名称匹配。
4. 写入临时索引后必须先反序列化验证；替换时将旧索引保留为 recovery/backup，新索引安装后重读
   验证，成功才清理恢复副本，失败必须回滚。不得先永久删除唯一旧索引再尝试 rename。
5. 任一步失败保留原记录和原路径，不修改新/旧项目目录。
6. 项目 ID 不匹配时不得自动调用 `open_project`；响应可指示 `can_open_independently=true`，实际打开
   必须由用户随后明确选择。
7. create/record、`open_project`、`remove_recent_project`、`delete_project` 与 `relink_recent_project` 的 recent-index
   读取—校验—修改—安装—内存同步必须共享应用级专用写入锁。条件验证必须在获得锁后基于最新索引
   重做；任何失败释放锁，且不得以调用前快照覆盖另一命令已提交的记录。availability 探测不得持锁。

### Error examples

- `UI-PROJECT-RELINK-MISMATCH`: 新目录属于另一个项目。
- `UI-PROJECT-RELINK-MISSING`: 新目录不存在。
- `UI-PROJECT-RELINK-UNREADABLE`: 新项目数据不可读取。
- `UI-PROJECT-RELINK-CONFLICT`: 原 recent 记录在确认期间发生变化。

## 4. Active Pipeline Conflict

新增只读 `get_active_pipeline_summary() -> PipelineSnapshot | null`，专门返回 Rust
`AppState.active_pipeline` 的当前摘要；无活动任务必须返回 null，不回退到所选项目的持久快照。
响应完全复用既有 `PipelineSnapshot` 字段与语义。既有 `get_pipeline_state` 不变，前端在进入应用和
竞态拒绝后使用新命令刷新摘要。

`start_pipeline`/`resume_pipeline` 保持现有响应契约，并遵守：

1. Rust 在引擎/GPU preflight 和任何目标项目状态写入前检查 `AppState.active_pipeline`。
2. 活动项目 A 与目标 B 不同时，返回稳定 `UI-PIPELINE-ACTIVE-CONFLICT`，并包含/允许重新读取 A 的
   安全摘要与 ID；A 不取消、不暂停，B 不排队且项目持久状态不变。
3. `resume_pipeline` 不得先把 B 写成 `Recovering` 再发现冲突。
4. 前端已知冲突时不应发送启动请求；后端门禁仍是 race 和所有入口的权威保护。
5. “创建并开始 B”可返回创建成功，但启动子步骤必须被拒绝并显示 A 的返回入口。

## 5. Preview Workspace Action

### Command

`preview_workspace_action`

### Request

```json
{
  "request": {
    "projectId": "project-id",
    "projectPath": "D:\\projects\\scene.splat-project",
    "action": "pause | cancel | rerun_stage | restore_checkpoint | delete_checkpoint | delete_project",
    "stageId": "BrushTraining",
    "checkpointIteration": 3000
  }
}
```

`stageId` 仅 `rerun_stage` 使用；`checkpointIteration` 仅 Checkpoint 动作使用，其他动作省略/null。

### Success response

```json
{
  "action": "restore_checkpoint",
  "targetLabel": "Checkpoint 3,000 step",
  "allowed": true,
  "blockedReason": null,
  "irreversible": false,
  "preserved": ["素材准备", "相机重建", "Checkpoint 3,000 step"],
  "invalidated": ["3,000 step 之后的 Checkpoint", "模型校验", "预览与导出"],
  "regenerated": ["Brush 训练", "模型校验", "预览与导出"],
  "warnings": ["恢复几何状态，不恢复优化器状态"],
  "sizeBytes": null,
  "previewToken": "opaque-single-use-token",
  "createdAt": "2026-08-13T12:00:00Z",
  "expiresAt": "2026-08-13T12:10:00Z"
}
```

### Rules

- command 只读，不移动、删除、失效或写入任何数据。
- 项目 ID/path 必须重新验证，active pipeline 和 Checkpoint 条件使用与真正 mutation 相同的领域规则。
- `previewToken` 是应用内存签发的不透明、单次使用令牌，绑定 action、target、影响指纹并在签发后
  10 分钟到期；到期只导致零写入刷新预览，不能自动执行或延长旧确认。
- 影响指纹只包含会改变说明的事实：run identity/current stage/control intent、相关 stage/产物终态、
  checkpoint iteration/size/mtime/valid/current、project ID/path/active 状态；不得包含连续 progress 或
  普通 sequence，以免确认页无意义过期。
- 返回内容必须是用户安全文案/相对产物描述，不返回不必要的完整路径或 raw logs。
- `allowed=false` 时 `blockedReason` 必填；仍可返回影响信息帮助用户理解。

### Guarded execution

新增 `execute_workspace_action({ "previewToken": "opaque-single-use-token" })`。既有 mutation command
名称、参数和原有服务器身份/合法性验证保持不变，作为兼容入口继续可用，但不承诺具有预览令牌
语义；本功能新增或修改的 UI 不得直接调用这些 command，而是只提交令牌，由
guarded command 从运行时记录取得 action/target 并分派同一领域操作。Rust 在任何 mutation 前原子
验证并消费令牌：

- token/action/target 不匹配、超时或已消费：零写入拒绝；
- 影响指纹变化：返回 `UI-ACTION-PREVIEW-STALE` 与最新 `ActionImpactPreview`，零写入并要求重新确认；
- 匹配：令牌消费一次并执行一次，响应返回 completed receipt；重放必须拒绝。

```json
{
  "kind": "completed",
  "receipt": {
    "action": "restore_checkpoint",
    "completed_at": "2026-08-13T12:02:00Z",
    "affected_resources": ["pipeline", "checkpoints", "artifacts"]
  }
}
```

影响已变化时返回成功传输的判别联合，而不是通用错误字符串，以便原 dialog 原位刷新：

```json
{
  "kind": "stale",
  "code": "UI-ACTION-PREVIEW-STALE",
  "message": "项目状态已变化，尚未执行任何操作。",
  "preview": {}
}
```

### Command contract test matrix

- `get_active_pipeline_summary`: active 时返回与权威 project ID/sequence 一致的 snapshot；无 active
  返回 null；状态锁失败返回安全结构化错误，不能回退到已选择项目。
- `preview_workspace_action`: 六种 action 均覆盖有效请求、缺失/多余条件字段、身份失败、allowed=false
  与脱敏响应；只读路径逐项断言项目、索引、Pipeline、Checkpoint 和产物零变化。
- `execute_workspace_action`: 六种 action 均覆盖 completed 分派；另覆盖 stale、expired、replay、未知
  token 和 malformed request，拒绝路径逐项断言零写入且 token 状态符合一次消费规则。
- legacy mutation：签名和原有成功/失败验证保持兼容；静态或服务层测试证明所有新 UI 调用只经
  `previewWorkspaceAction`/`executeWorkspaceAction`，不存在直接旁路。
- recent-index mutation：create/record/open/remove/delete/relink 中至少两个并发命令从同一初始索引
  开始，最终结果包含两个已提交变化或其中一个明确 conflict，不允许静默丢更新；覆盖失败后锁释放和
  recovery 后下一事务成功。

## 6. Compatible Error Payload

前端错误通道接受两种格式：

1. 既有 string。
2. 可序列化对象：

```json
{
  "code": "E-1201",
  "category": "filesystem",
  "title": "无法保存项目",
  "user_message": "项目目录不可写。",
  "impact": "当前操作未完成，已有项目数据保持不变。",
  "suggestions": ["检查目录权限后重试"],
  "retryable": true,
  "technical_message": null,
  "log_reference": null
}
```

Compatibility rules:

- 前端必须双格式解析；不能假定所有 commands 已迁移。
- object 未知字段忽略；缺少可选字段由 command fallback catalog 补充。
- `retryable` 必须按操作是否可安全重复决定；旧字符串无明确 catalog 规则时默认为 false。可能产生副作用的
  mutation 不得直接重放旧请求，必须先重新验证目标身份和当前影响，guarded action 重新获取预览/令牌。
- `technical_message` 和 log reference 在 UI/复制前必须脱敏。
- Tauri command 不得把 `AppError.localized_for_ui()` 的 technical cause 直接拼入 user message。

## 7. Event and Refresh Rules

- `pipeline://event` payload 保持现状；event 是 refresh signal，不是完整事实状态。
- 收到 `stage_started/completed/failed/skipped` 或 terminal event 后：
  - 立即请求最新 Pipeline snapshot；
  - 按 event kind 使 activity 失效；
  - completed/failed/terminal 使 artifacts 和 checkpoints 失效；
  - 保留轮询兜底。
- 迟到请求必须按 project id、sequence 和 request key 丢弃。
- 刷新失败不得清空上一次成功响应。

## 8. Redaction and Safe Path Rules

- 用户可见/复制错误、活动详情与回执不得包含 token、credential、私钥、环境变量值、用户主目录或
  不必要的绝对项目路径。
- 路径显示使用项目名、相对路径或截短值；需要完整定位时调用已有安全 opener command。
- `source_log`、`technical_message` 和 metrics 视为敏感候选，必须经统一 redaction。
- 测试必须包含 canary secret、主目录和项目绝对路径，并断言默认 UI/复制文本/诊断包不泄漏。

## 9. No Persistence Migration

这些 IPC 增量不修改 `project.json`、Schema version、COLMAP database、事件 JSONL 格式或用户媒体。
最近项目 availability 与预览令牌不持久化；索引只在用户成功重定位到同一项目时原子更新路径，
旧索引可直接读取，因此无需迁移。
