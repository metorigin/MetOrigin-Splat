# MetaOrigin Splat UI Phase 2–6 详细执行设计

## 1. 目标与边界

本文是 `ui-redesign-timeline-workspace.md` 的执行级补充，覆盖以下五个阶段：

1. 三步新建项目向导。
2. 完整时间线与运行控制。
3. 日志、错误和 Checkpoint。
4. 真实点云与 PLY 预览。
5. 设置、引擎和资源监控。

选定的图三“时间线工作区”仍是唯一视觉基准。Phase 1 已完成工作区壳层、项目侧栏、顶部运行栏、状态栏、原生选择器、项目索引和本地引擎定位；后续不重新设计这些区域，只补齐真实行为和状态。

最终用户路径必须完整闭环：

```text
选择素材
  → 看到真实预检结果
  → 创建项目
  → 开始重建
  → 查看四阶段进度与真实日志
  → 暂停、取消、恢复或重试
  → 检查 COLMAP 与 Brush 质量
  → 预览并打开 output/scene.ply
```

### 1.1 全阶段共同原则

- 未知数据统一显示“尚未测量”，不根据界面状态伪造指标。
- 破坏性操作必须先计算影响范围，再由用户确认。
- UI 使用用户阶段名称，日志和详情才显示技术 Stage 名称。
- 运行状态以持久化 `project.json` 为准，内存状态只提供实时增量。
- 任何事件都带 `project_id`、递增 `sequence` 和 UTC 时间戳。
- 同一时间只运行一个 Pipeline，但允许浏览和创建其他项目。
- 所有文件选择、目录打开和诊断导出使用原生 Windows 能力。
- 图标继续使用 Phosphor Icons，不加入 Emoji、自制 SVG 或 CSS 图形。

## 2. 跨阶段基础架构

### 2.1 前端状态分层

前端分成三层状态，避免组件各自轮询和相互覆盖：

| 层 | 内容 | 生命周期 |
| --- | --- | --- |
| AppState | 当前项目、项目索引、应用设置、引擎和资源状态 | 应用级 |
| WorkspaceState | Pipeline 快照、选中 Phase/Stage、预览模式、日志筛选 | 当前项目级 |
| WizardState | 素材、预检、预设、自定义参数、创建进度 | 向导打开期间 |

所有 Tauri 调用进入 `services/desktop.ts` 或拆分后的 typed service，不允许组件直接散落 `invoke("command")`。

建议结构：

```text
src/
  app/
    appReducer.ts
    workspaceReducer.ts
  services/
    projectService.ts
    pipelineService.ts
    artifactService.ts
    diagnosticsService.ts
  components/
    wizard/
    timeline/
    activity/
    preview/
    settings/
  hooks/
    usePipelineEvents.ts
    useProjectArtifacts.ts
    useResourceMetrics.ts
```

### 2.2 项目运行状态机

现有 `ProjectStatus` 需要扩展为可准确表达控制过程的状态：

```text
Creating
Ready
Starting
Running
Pausing
Paused
Cancelling
Cancelled
Recovering
Failed
Completed
```

状态转换：

```text
Ready/Cancelled/Failed → Starting → Running
Running → Pausing → Paused → Recovering → Running
Running/Paused → Cancelling → Cancelled
Running → Failed
Running → Completed
应用异常退出时 Running/Starting/Pausing/Cancelling → Recovering
```

瞬态状态也必须写入 `project.json`。应用启动后发现瞬态状态时，不假装任务仍在运行，而是进入 `Recovering` 并校验磁盘产物。

### 2.3 统一事件模型

新增稳定 DTO：

```text
PipelineEventRecord
  event_id
  project_id
  sequence
  timestamp
  kind
  severity
  phase_id
  stage_id
  user_message
  technical_message
  metrics
  source_log
```

`user_message` 可直接展示；`technical_message` 只进入详情和诊断包。路径在 UI 默认转换为 `<PROJECT_ROOT>`、`<ENGINE_ROOT>` 等别名。

### 2.4 统一产物索引

新增 `ArtifactSummary`，前端不自行猜测文件位置：

```text
ArtifactSummary
  frames_manifest
  contact_sheet
  colmap_result
  sparse_preview
  latest_checkpoint
  model_validation
  scene_ply
  output_manifest
```

每项包含：相对路径、是否存在、是否验证、大小、更新时间、来源 Stage 和错误原因。

---

## 3. Phase 2：三步新建项目向导

## 3.1 向导容器

向导覆盖中央工作区，左侧项目栏和底部系统状态栏继续可见。宽度上限 920 px，三步共用固定头部和底部动作区。

头部显示：

- 标题“新建项目”。
- 步骤指示器：`1 导入素材 / 2 检查与方案 / 3 确认创建`。
- “关闭”按钮：没有复制任务时直接关闭；复制中先确认是否取消。

底部始终显示：

- 左侧“上一步”。
- 右侧“下一步”或最终创建按钮。
- 当前步骤的阻断原因。

键盘：

- `Esc`：关闭或弹出取消确认。
- `Alt+Left`：上一步。
- `Ctrl+Enter`：当前步骤验证通过时进入下一步；第三步执行“创建并开始重建”。

## 3.2 第一步：导入素材

### 显示区域

1. 视频入口卡片。
2. 图片文件夹入口卡片。
3. 选择后的素材摘要。
4. 缩略图/Contact Sheet 预览。
5. 读取状态与错误说明。

### 按钮与行为

| 按钮 | 行为 | 禁用条件 | 失败反馈 |
| --- | --- | --- | --- |
| 选择视频 | 打开原生文件选择器 | 正在分析 | 保留当前选择并显示错误 |
| 选择图片文件夹 | 打开原生目录选择器 | 正在分析 | 显示无法读取或无图片 |
| 替换素材 | 重新打开对应选择器 | 正在复制 | 原选择在新分析成功前保留 |
| 清除素材 | 清空当前草稿素材 | 正在分析/复制 | 无 |
| 查看原文件 | 在资源管理器中定位 | 路径已丢失 | 显示“素材位置不可用” |
| 下一步 | 进入预检 | 分析未成功 | 在按钮旁显示阻断原因 |

### 真实信息

视频必须显示：

- 文件名与文件大小。
- 分辨率、帧率、时长、编码和旋转信息。
- 源总帧数；未知时显示“源帧数未知”。
- Fast/Balanced/Quality 下的预计抽帧数预览。

图片文件夹必须显示：

- 有效图片数、被忽略文件数。
- 分辨率范围、横竖屏分布和格式分布。
- 至少 6 张真实缩略图。
- 同名、损坏、零字节和不可读取图片数量。

### 数据与后端

扩展 `analyze_media` 为统一结果：

```text
MediaAnalysis
  source_kind
  source_path
  display_name
  size_bytes
  video_metadata?
  image_set_metadata?
  preview_items[]
  warnings[]
  blockers[]
```

分析不复制 1.56 GiB 视频。缩略图写到应用临时目录，向导关闭时清理。

### 第一步验收

- 测试视频显示 `3840×2160`、约 `29.97 fps`、约 `133.135 秒` 和实际编码。
- 取消原生选择器不会清空原选择。
- FFprobe 缺失时阻断下一步，并提供“打开引擎设置”。
- 中文路径和大文件不会卡住 UI 主线程。

## 3.3 第二步：检查与方案

### 显示区域

1. 预检总览：可运行、警告或阻断。
2. 引擎检查：FFmpeg/FFprobe、COLMAP、Brush。
3. 磁盘空间：预计需求、可用空间和安全余量。
4. 三个预设对比表。
5. 折叠的高级设置。

### 预检结果分级

- 绿色“可以开始”：无阻断项。
- 黄色“可以继续但有风险”：素材模糊、帧间变化弱、空间余量低等。
- 红色“暂时不能开始”：缺引擎、目录无权限、磁盘不足、无有效媒体。

### 预设表

| 字段 | Fast | Balanced | Quality |
| --- | --- | --- | --- |
| 抽帧速率/最大帧 | 真实 preset 值 | 真实 preset 值 | 真实 preset 值 |
| 最长边 | 真实 preset 值 | 真实 preset 值 | 真实 preset 值 |
| Brush 迭代 | 3000 | preset 实际值 | preset 实际值 |
| 预计磁盘 | 根据本次素材计算 | 根据本次素材计算 | 根据本次素材计算 |
| 适用场景 | 快速闭环 | 默认推荐 | 高质量最终输出 |

时间估算只有存在同硬件、同预设历史样本时显示区间；否则显示“首次运行，暂不估算”。

### 高级设置

默认收起，包含：

- 抽帧 FPS。
- 最大帧数。
- 最长边。
- Brush 迭代数。
- SH degree。
- Checkpoint 间隔。

每项显示默认值、有效范围、恢复默认和影响说明。修改后立即重新计算预计帧数和磁盘，但不重新读取完整视频。

### 按钮

| 按钮 | 行为 |
| --- | --- |
| 重新检查 | 重新定位引擎并刷新磁盘/素材状态 |
| 打开引擎设置 | 打开设置抽屉并定位缺失项 |
| 恢复推荐设置 | 恢复本机推荐预设和默认高级参数 |
| 上一步 | 返回素材，不丢失分析结果 |
| 下一步 | 预检无 blocker 时进入确认 |

### 后端

新增 `preflight_project(request)`，返回：

```text
ProjectPreflight
  engine_checks[]
  source_check
  destination_check
  estimated_frames
  estimated_disk_bytes
  available_disk_bytes
  recommended_preset
  warnings[]
  blockers[]
```

所有预设值由 Rust 读取项目 preset 文件并返回，前端不复制一套常量。

## 3.4 第三步：确认创建

### 显示区域

- 项目名称输入框。
- 项目根目录与最终 `.splat-project` 路径。
- 素材处理方式：复制到项目（首轮唯一正式支持方式）。
- 素材、预设、预计帧数、磁盘需求摘要。
- 当前是否已有其他 Pipeline 运行。

### 按钮

| 按钮 | 行为 |
| --- | --- |
| 更改项目目录 | 原生目录选择器 |
| 仅创建项目 | 创建完成后进入 Ready 工作区 |
| 创建并开始重建 | 创建后执行最终预检并启动 Pipeline |
| 取消复制 | 取消复制并清理未完成项目目录 |

### 创建事务

创建必须是可回滚事务：

1. 生成临时目录 `{name}.splat-project.creating`。
2. 写入 `Creating` 项目状态。
3. 分块复制素材并发出 `project://copy-progress`。
4. 校验目标大小和文件数量。
5. 原子写入完整 `project.json`。
6. 将临时目录重命名为最终目录。
7. 写入项目索引。

任何步骤失败都清理临时目录，不在最近项目里留下伪成功条目。用户主动取消也执行相同清理。

### Phase 2 提交拆分

1. `feat(project): add media analysis preflight and transactional creation`
2. `feat(ui): implement three-step project creation wizard`
3. `test(ui): verify native media import and creation recovery`

---

## 4. Phase 3：完整时间线与运行控制

## 4.1 四阶段时间线

固定映射：

| 用户阶段 | 技术 Stage |
| --- | --- |
| 素材准备 | MediaValidation、FrameExtraction、ImagePreprocessing |
| 相机重建 | ColmapFeatureExtraction、ColmapMatching、ColmapMapping、ColmapValidation |
| 模型训练 | TrainingPreparation、BrushTraining、ModelValidation |
| 结果导出 | Export、PreviewGeneration |

每个 Phase 摘要显示：状态、完成数量、阶段耗时、关键指标和展开箭头。当前、失败和恢复中的 Phase 自动展开。

Stage 行显示：

- 状态图标和中文名称。
- 当前数量/总数量或可靠百分比。
- 持续时间。
- `已缓存`、`重试 1 次`、`需要恢复` 等标签。
- 选中后联动右侧预览、质量区和底部日志。

## 4.2 进度算法

首轮使用固定权重，之后可用真实技术测试校准：

| Phase | 权重 |
| --- | ---: |
| 素材准备 | 8% |
| 相机重建 | 35% |
| 模型训练 | 52% |
| 结果导出 | 5% |

Phase 内再按真实 Stage 耗时拆分。总体进度为“已完成权重 + 当前 Stage 权重 × 可靠进度”。

如果引擎没有可靠百分比：

- 当前 Stage 使用不确定动画。
- 总进度只累计已完成权重。
- 不因轮询时间增长而自动推进。

预计剩余时间只在已有同设备、同预设历史时显示 P50–P90 区间；否则显示“正在积累估算样本”。

## 4.3 顶部运行控制

### 开始重建

可用状态：Ready、Cancelled、可恢复 Failed。

点击后先执行快速预检：素材、引擎、磁盘和项目锁。通过后按钮变成“正在启动”，收到 `pipeline://state-changed Running` 后才显示“暂停”。

### 暂停

语义是“可恢复的优雅停止”，不是挂起进程：

- FFmpeg/COLMAP：停止进程树；恢复时重跑当前 Stage。
- Brush：保留最近合法几何 PLY Checkpoint；恢复时从该几何继续，但优化器状态会重置。

确认框显示：当前 Stage、可保留内容、预计需要重做的范围。Pausing 时所有破坏性操作禁用。

### 继续

执行恢复校验、重新获取项目锁、构建 Orchestrator 并从最后有效边界运行。恢复报告明确列出“复用、重跑、无效化”的 Stage。

### 取消（安全）

确认框显示：

- 当前阶段。
- 将终止的进程。
- 已保留的缓存/Checkpoint。
- 下次继续的起点。

Cancelling 完成前不允许重复提交。返回值必须包含终止结果和最后合法产物。

### 操作菜单

| 菜单项 | 可用条件 | 确认要求 |
| --- | --- | --- |
| 打开项目目录 | 项目存在 | 无 |
| 打开输出目录 | output 存在 | 无 |
| 从当前 Stage 重跑 | 非 Running | 显示下游失效范围 |
| 从指定 Stage 重跑 | 非 Running | 选择 Stage 后二次确认 |
| 管理 Checkpoint | 存在训练目录 | 删除/恢复需确认 |
| 清理无效缓存 | 非 Running | 显示文件数量和大小 |
| 导出诊断包 | 永远可用 | 无 |
| 项目设置 | 非 Cancelling | 改参数时显示失效范围 |

## 4.4 Stage 操作

- “重试此阶段”：Failed/Cancelled Stage 可用。
- “跳过此阶段”：仅 `optional=true` 的 PreviewGeneration 等 Stage 可用。
- “查看详细日志”：展开活动面板并锁定 Stage。
- “打开输出”：只有验证过的产物可用。

重试或从指定 Stage 重跑时，后端负责计算并持久化所有下游失效，不允许只在前端改变颜色。

## 4.5 后端变化

`ActivePipeline` 增加：

```text
task_handle
control_intent: None | Pause | Cancel
accepted_at
started_at
last_event_sequence
```

新增/补齐命令：

```text
pause_pipeline
resume_pipeline
retry_stage
rerun_from_stage
get_pipeline_snapshot
```

返回值均带 `project_id`，前端拒绝应用其他项目的事件。

新增事件：

```text
pipeline://state-changed
pipeline://stage-changed
pipeline://stage-progress
pipeline://recovery-report
pipeline://control-completed
```

## 4.6 Phase 3 验收

- 重复点击开始只产生一个后台任务。
- FFmpeg、COLMAP、Brush 运行中都能安全取消进程树。
- Brush 500 step 暂停后，重启应用能明确显示可恢复 Checkpoint。
- 失败 Stage 自动选中并展开。
- 缓存命中显示“已缓存”，不计入本次耗时。
- 关闭应用再打开不会显示幽灵 Running 状态。

### Phase 3 提交拆分

1. `feat(pipeline): add persisted pause resume and rerun controls`
2. `feat(ui): connect weighted pipeline timeline and run controls`
3. `test(pipeline): cover control races recovery and downstream invalidation`

---

## 5. Phase 4：日志、错误和 Checkpoint

## 5.1 活动面板

面板保留图三底部位置，四个 Tab：

| Tab | 内容 |
| --- | --- |
| 活动日志 | 用户可读的实时流水 |
| 事件 | Stage、缓存、恢复和用户操作 |
| 警告 | 非阻断质量/资源问题 |
| 错误 | 阻断问题与恢复建议 |

顶部工具：Stage 筛选、级别筛选、文本搜索、自动跟随、清空筛选、展开/收起。

日志表列为：时间、级别、阶段、消息。点击行后右侧详情显示完整上下文，不把长路径挤进表格。

## 5.2 日志存储

每个项目写入：

```text
logs/events.jsonl
logs/{stage}.stdout.log
logs/{stage}.stderr.log
logs/pipeline.log
```

`events.jsonl` 是结构化事件；stdout/stderr 保持原始文本。UI 分页读取，不一次把大日志放入 DOM。

命令：

```text
get_pipeline_events(cursor, limit, filters)
read_stage_log(stage_id, stream, offset, limit)
get_event_detail(event_id)
```

默认每页 200 条，使用稳定 cursor；实时事件到达时只追加，不重新请求整页。

## 5.3 自动跟随规则

- 初始自动跟随最新消息。
- 用户向上滚动超过一屏后停止跟随。
- 显示“回到最新（N）”按钮。
- 用户回到底部后恢复自动跟随。
- 高频进度日志最多每 250 ms 更新一条 UI 记录，原始日志不丢失。

## 5.4 错误卡片

错误详情固定包含：

- 发生阶段。
- 用户能理解的原因。
- 是否可重试。
- 建议操作列表。
- “重试此阶段”。
- “打开原始日志”。
- “复制诊断详情”。
- “导出诊断包”。

用户界面不显示 Rust backtrace、完整机器路径或命令行密钥；这些内容只进入脱敏诊断包。

## 5.5 Checkpoint 管理器

从顶部检查点状态条或操作菜单打开右侧抽屉。

列表字段：

- 迭代数。
- 创建时间。
- 文件大小。
- PLY 顶点/Splat 数。
- Brush 版本。
- 验证状态。
- 当前使用标记。

每个 Checkpoint 必须经过 PLY 头、非零顶点、大小和可读取性验证。

### 按钮

| 按钮 | 行为 |
| --- | --- |
| 预览 | 在右侧预览区临时加载，不改变 Pipeline |
| 恢复到此处 | 使之后的训练、验证、导出失效并进入 Paused |
| 在文件夹中显示 | 资源管理器定位 PLY |
| 删除 | 显示大小和是否会失去唯一恢复点 |
| 删除无效项 | 只清理验证失败且未被引用的文件 |

必须明确提示：Brush v0.3.0 的 Checkpoint 是几何 PLY，不包含优化器状态；恢复是几何续训，不保证 Loss 曲线连续。

## 5.6 后端变化

新增命令：

```text
list_checkpoints
validate_checkpoint
restore_checkpoint
delete_checkpoint
delete_invalid_checkpoints
export_diagnostics
```

恢复旧 Checkpoint 的事务：

1. 验证文件。
2. 计算下游失效范围。
3. 写入恢复事件。
4. 更新 PipelineState 和项目状态。
5. 原子保存。

## 5.7 Phase 4 验收

- 10 万行日志不会阻塞工作区滚动。
- stdout/stderr 能分开查看和搜索。
- 500 step Checkpoint 可见、可验证、可预览。
- 删除正在使用或唯一合法 Checkpoint 被阻断。
- 所有用户控制行为都能在事件 Tab 追溯。

### Phase 4 提交拆分

1. `feat(pipeline): persist structured events logs and checkpoint metadata`
2. `feat(ui): add activity error and checkpoint workbench`
3. `test(ui): verify log scale filtering and checkpoint impact flows`

---

## 6. Phase 5：真实点云与 PLY 预览

## 6.1 预览状态与数据源

右侧预览严格随选中 Stage 切换：

| 选中阶段 | 预览内容 |
| --- | --- |
| 素材准备 | 抽帧 Contact Sheet / 原帧 |
| 相机重建 | COLMAP sparse 点云和相机视锥 |
| 模型训练 | 最新合法 Brush Checkpoint |
| 结果导出 | `output/scene.ply` |

无产物时显示具体原因和“在哪个节点后可用”，不显示假点云。

## 6.2 Contact Sheet

FrameExtraction 完成后生成轻量预览清单：

```text
frames/preview/index.json
frames/preview/thumb_0001.jpg
...
```

默认均匀抽取 12 张缩略图，不复制所有原图。点击缩略图打开大图查看器，支持上一张、下一张、适配窗口和在文件夹中显示。

## 6.3 COLMAP sparse 预览

新增 `SparsePreviewPack`：

```text
schema_version
model_path
registered_images
total_images
points[]
cameras[]
bounds
quality
```

后端从选定的 COLMAP 模型解析真实 `cameras/images/points3D`。大点云按固定种子均匀采样，首屏上限 200,000 点；质量统计仍使用完整模型。

前端使用 Three.js：

- `Points` 绘制真实稀疏点和 RGB。
- `LineSegments` 绘制相机视锥。
- 轨道、平移、缩放使用标准 controls。
- 不用 CSS/DOM 模拟点云。

## 6.4 PLY 与 Gaussian Splat 预览

分两级交付：

1. 必须完成的真实 PLY 点模式：解析 PLY 头和顶点，显示真实点/颜色。
2. 验证后启用 Gaussian Splat 模式：只选择能正确读取 Brush v0.3.0 实际 PLY 属性的渲染器。

渲染器选型必须拿真实 `scene.ply` 验证：

- 属性名和数据类型兼容。
- 70,035 splats 可加载。
- 相机轨道正确。
- 16 GB VRAM 下无明显泄漏。
- 销毁或切换项目后释放 GPU 资源。

若 Gaussian 渲染器未通过验证，模式下拉只显示“点模式”，不能展示一个视觉错误的伪 Gaussian 模式。

## 6.5 预览工具栏

| 按钮 | 行为 | 禁用条件 |
| --- | --- | --- |
| 重置视角 | 回到默认包围盒视角 | 无模型 |
| 轨道 | 左键旋转 | 静态图片 |
| 平移 | 左键平移 | 静态图片 |
| 适配窗口 | 完整显示包围盒 | 无模型 |
| 网格 | 显示/隐藏地面网格 | 图片预览 |
| 相机 | 显示/隐藏相机视锥 | 非 sparse |
| 全屏 | 最大化右侧预览 | 永远可用 |
| 截图 | 保存当前画布 PNG | 未加载完成 |

显示模式下拉：点云、相机、点云+相机、点模式、Gaussian Splat。只显示当前产物实际支持的模式。

## 6.6 加载与内存控制

- 加载过程显示读取、解析和上传 GPU 三段进度。
- 用户可取消预览加载，不影响 Pipeline。
- 切换 Stage 时取消旧加载并释放几何、材质和纹理。
- 预览失败不会把 Pipeline 标记失败，只产生警告。
- 1024 视口中预览进入抽屉；关闭抽屉可暂停绘制循环。

## 6.7 质量区域

指标来自真实文件：

### 素材阶段

- 分辨率、帧率、时长、抽帧数量。

### COLMAP 阶段

- 注册图像数。
- 注册率。
- 稀疏点数。
- 平均重投影误差。

### Brush/结果阶段

- 当前迭代。
- Checkpoint 大小。
- PLY 顶点/Splat 数。
- 最终 PLY 大小和验证状态。

阈值状态只根据明确规则显示：注册率低于 50% 为红色，50–75% 为黄色，高于 75% 为绿色；重投影误差阈值根据实际 COLMAP 验证规则保持一致。

## 6.8 后端命令

```text
get_project_artifacts
get_frame_preview
get_sparse_preview_pack
inspect_ply
authorize_preview_asset
save_preview_screenshot
```

前端只访问当前项目根目录内、由后端授权的产物，不能传入任意机器路径。

## 6.9 Phase 5 验收

- 266 张帧能生成真实 Contact Sheet。
- `colmap/result.json` 中 196/266 和 28,365 点在 UI 正确显示。
- sparse 预览使用真实点坐标和相机姿态。
- 500 与 3000 step Checkpoint 都能切换预览。
- 最终 3,922,395 bytes、70,035 splats 的 `scene.ply` 可解析。
- 模型切换 20 次后内存/显存不会持续增长。

### Phase 5 提交拆分

1. `feat(artifacts): expose validated frame colmap and ply preview data`
2. `feat(ui): add real sparse point cloud and ply preview renderer`
3. `feat(ui): connect quality metrics result manifest and screenshots`
4. `test(ui): verify preview lifecycle against real pipeline artifacts`

---

## 7. Phase 6：设置、引擎和资源监控

## 7.1 设置入口与布局

入口：

- 顶部“操作 → 项目设置”。
- 点击底部任一引擎。
- 点击 GPU/VRAM。
- 预检阻断项中的“打开设置”。

使用右侧大抽屉，不离开工作区。设置分四组：引擎、项目默认值、性能、诊断。

## 7.2 引擎设置

每个引擎卡片显示：

- 名称和实际版本。
- 可执行文件路径与来源：环境变量、应用资源或 PATH。
- 最近验证时间。
- 验证状态和错误。
- 许可证入口。

按钮：

| 按钮 | 行为 |
| --- | --- |
| 定位引擎目录 | 选择统一引擎根目录 |
| 单独定位 | 选择对应 exe |
| 重新检测 | 执行版本/帮助命令 |
| 恢复自动定位 | 清除本机自定义路径 |
| 打开所在目录 | 资源管理器打开 |

`METORIGIN_ENGINE_DIR` 存在时显示为只读高优先级来源；UI 不静默覆盖环境变量。

设置保存在应用配置目录，Pipeline 和 `check_engines` 必须通过同一个 `EngineLocator` 读取。

## 7.3 项目默认值

- 默认项目根目录。
- 默认预设。
- 创建后默认行为：仅创建或创建并开始。
- 素材复制策略；首轮只允许“复制”。
- 日志保留上限。
- 缩略图缓存上限。

改变默认值不修改已有项目。

## 7.4 硬件与资源监控

当前 `HardwareDetector` 是占位，需真实实现：

### 系统资源

- 使用系统 API/sysinfo 获取 CPU、内存和磁盘。
- 磁盘以当前项目盘符为准，不只看系统盘。

### NVIDIA GPU

首轮使用已安装驱动提供的 `nvidia-smi`，通过 `ProcessRunner` 执行结构化查询：

```text
name
driver_version
memory.total
memory.used
utilization.gpu
temperature.gpu
```

采样间隔：运行时 2 秒，空闲时 5 秒，窗口最小化时 15 秒。命令失败显示“GPU 指标不可用”，不把 Pipeline 判为失败。

### 阈值

- 项目盘剩余不足预计需求 + 5 GiB：阻断启动。
- VRAM 使用率超过 85%：黄色告警。
- VRAM 使用率超过 95%：红色告警。
- GPU 温度阈值只告警，不自动终止任务。

资源告警写入事件流，避免只在状态栏一闪而过。

## 7.5 状态栏交互

- 引擎绿色：全部通过验证；黄色：缺失或版本不可读；红色：路径存在但启动失败。
- GPU 显示设备简称和利用率。
- VRAM 显示 `已用 / 总量` 和细进度条。
- 系统显示项目盘剩余空间和告警数量。
- 点击任一组打开对应设置分区。

1024 视口只显示图标和关键值，详细文本进入 Tooltip/抽屉。

## 7.6 诊断包

“导出诊断包”生成 zip，包含：

- 脱敏项目摘要。
- PipelineState 和事件尾部。
- 各 Stage 日志尾部。
- 引擎版本和来源类型。
- GPU/系统摘要。
- 产物存在性与大小，不包含 PLY、视频和原图本体。

所有绝对路径替换为 `<PROJECT_ROOT>`、`<ENGINE_ROOT>`、`<USER_HOME>`。生成前显示包含内容，生成后提供“在文件夹中显示”。

## 7.7 无障碍和响应式收口

- 所有图标按钮有中文名称和 Tooltip。
- 所有状态同时使用图标、文本和颜色。
- 时间线支持上下键、Space 展开、Enter 选中。
- Tab 面板支持左右键切换。
- 拖动面板都有键盘等价按钮。
- 高频进度不进入 `aria-live`；阶段切换和错误进入 polite 区域。
- `prefers-reduced-motion` 关闭位移动画。
- 1440×1024 与 1024×768 都不出现隐藏主动作的溢出。

## 7.8 后端命令

```text
get_app_settings
save_app_settings
set_engine_directory
set_engine_executable
clear_engine_override
check_engines
get_hardware_profile
get_resource_metrics
export_diagnostics
```

资源事件：

```text
resource://sample
resource://warning
engine://status-changed
```

## 7.9 Phase 6 验收

- 移走 `.engines` 后，预检在开始前明确阻断。
- 重新定位目录后不重启应用即可恢复绿色状态。
- 状态栏显示 RTX 5080 Laptop 和真实 VRAM。
- 项目盘不足时创建/启动被阻断并显示需求差额。
- 诊断包不包含真实用户名、数据集绝对路径或媒体本体。

### Phase 6 提交拆分

1. `feat(hardware): add real engine settings and resource sampling`
2. `feat(ui): add settings diagnostics and responsive status surfaces`
3. `test(ui): verify resource warnings accessibility and diagnostics redaction`

---

## 8. 推荐执行顺序

为了尽早形成可测试闭环，不按“大页面”开发，而按垂直切片执行：

1. 视频分析 → 预检 → 事务创建。
2. Pipeline 状态快照 → 时间线真实渲染。
3. 安全取消 → 暂停 → 恢复 → 重试。
4. 结构化事件 → 日志查看器 → 错误卡片。
5. Checkpoint 列表 → 验证 → 恢复/删除。
6. 帧预览 → sparse 预览 → PLY 点模式 → Gaussian 模式验证。
7. 质量指标 → 结果清单 → 截图/打开输出。
8. 引擎设置 → GPU/VRAM/磁盘 → 诊断包。
9. 1024/1440 响应式与完整键盘流程。
10. 真实素材冒烟和 Design QA。

每个切片必须同时完成：Rust 接口、前端真实行为、错误状态、自动测试和一次截图检查。

## 9. 全流程真实验收脚本

使用 `<DATASET_ROOT>/video/20260701_C0115.MP4`：

1. 新建 Fast 项目，确认 3840×2160、29.97 fps、133.135 秒。
2. 确认预检显示约 266 帧和三个引擎真实版本。
3. 创建项目时观察 1.56 GiB 复制进度并验证取消清理。
4. 开始重建，观察 FFmpeg 实时帧数。
5. COLMAP 阶段检查 196/266、73.7%、28,365 点和真实误差。
6. Brush 到 500 step 后暂停并关闭应用。
7. 重启，查看恢复报告并继续到 3000 step。
8. 查看 500/3000 Checkpoint，确认几何恢复语义。
9. 在预览区切换 sparse、Checkpoint 和最终 PLY。
10. 打开 `output/scene.ply`，确认约 3.92 MB、70,035 splats。
11. 再次运行，确认有效阶段显示“已缓存”。
12. 导出诊断包并检查路径脱敏。

## 10. 全量门禁与完成定义

每阶段至少运行：

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --dir apps/desktop tauri build --debug --no-bundle
```

最终还必须：

- 以 1440×1024 将实现截图与图三放入同一对照图。
- 在 1024×768 完成原生窗口交互检查。
- 修复所有 Design QA P0/P1/P2。
- 项目根目录存在 `design-qa.md`，且内容为 `final result: passed`。
- 所有按钮都有真实行为、禁用条件、反馈和失败处理。
- 所有显示区域都有真实数据源或明确空状态。
- 工作区无未提交修改，阶段提交边界清晰。
