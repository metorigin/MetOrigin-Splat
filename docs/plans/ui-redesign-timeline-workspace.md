# MetOrigin Splat UI 重设计实施计划

## 1. 设计基线

本计划以已选定的第 3 套方案“时间线工作区”为唯一视觉与交互基线。设计参考保存在本地忽略目录 `.artifacts/ui-redesign/selected-option-3.png`，不提交生成图和测试截图。

目标不是把现有四个页面重新换肤，而是把产品重组为一个持续存在的桌面生产工作区：用户始终能看见项目、当前阶段、结果质量、日志上下文、资源状态和下一步操作。

核心任务链固定为：

```text
选择或创建项目
  → 导入素材并完成预检
  → 确认重建方案
  → 在统一工作区运行和干预流水线
  → 检查重建质量与模型结果
  → 导出或打开 scene.ply
```

### 1.1 不可妥协的产品原则

- 不再把 FFmpeg、COLMAP、Brush 混称为“训练”；用户主动作统一叫“开始重建”。
- 不再为运行过程跳转到独立训练页；准备、运行、失败、恢复和完成都发生在同一个项目工作区。
- 12 个技术 Stage 在数据层保留，在界面层归并为 4 个用户阶段。
- 当前阶段、最近日志、输出质量和安全操作必须在同一屏可见。
- 所有破坏性操作都必须说明影响范围并二次确认。
- 真实数据未知时显示“尚未测量”，禁止展示推测值。
- 引擎缺失、磁盘不足或素材无效时，在启动前阻断，而不是运行后失败。
- 1024×768 是可用下限，1440×1024 是主要设计视口。

## 2. 信息架构

应用只保留四个一级工作域：

| 工作域 | 用途 | 入口 |
| --- | --- | --- |
| 项目库 | 新建、打开、搜索和切换项目 | 左侧项目栏 |
| 项目工作区 | 时间线、实时预览、质量、日志、运行控制 | 点击项目 |
| 结果 | 预览最终 PLY、检查清单、打开输出目录 | 工作区“结果导出”阶段或右侧结果按钮 |
| 设置 | 引擎、项目目录、性能和诊断设置 | 顶栏操作菜单或状态栏 |

“新建项目”是覆盖工作区的向导，不是一级导航。“日志”“Checkpoint”“质量诊断”是工作区内的上下文面板，不再拆成孤立页面。

## 3. 窗口与布局规格

### 3.1 1440×1024 主布局

| 区域 | 建议尺寸 | 行为 |
| --- | --- | --- |
| 顶部标题/运行栏 | 高 84 px | 固定；显示项目标题、总体进度和运行控制 |
| 左侧项目栏 | 宽 232 px | 固定；可折叠至 64 px |
| 中央时间线 | 剩余宽度约 740 px | 主滚动区域；阶段可展开 |
| 右侧预览/质量栏 | 宽 440 px | 可调整宽度；可收起 |
| 底部活动面板 | 高 230–360 px | 可拖动改变高度；可收起 |
| 底部状态栏 | 高 40 px | 固定；显示引擎、GPU、VRAM 和系统状态 |

### 3.2 1024×768 降级布局

- 左侧项目栏默认折叠，只显示图标和当前项目状态。
- 右侧预览栏改为“预览 / 质量”抽屉，通过工具栏按钮打开。
- 底部活动面板默认只显示一行最新事件，点击后向上展开。
- 顶栏只保留总体进度、“暂停/继续”和操作菜单；耗时信息进入进度详情。
- 主动作按钮始终保持可见，不能因为滚动或窗口缩放离开视口。

## 4. 四阶段映射

| 用户阶段 | 包含的 Pipeline Stage | 默认展示 |
| --- | --- | --- |
| 1. 素材准备 | MediaValidation、FrameExtraction、ImagePreprocessing | 输入、抽帧数量、输出大小、耗时 |
| 2. 相机重建 | ColmapFeatureExtraction、ColmapMatching、ColmapMapping、ColmapValidation | 注册图像、注册率、稀疏点、重投影误差 |
| 3. 模型训练 | TrainingPreparation、BrushTraining、ModelValidation | 迭代、Checkpoint、GPU/VRAM、PLY 顶点数 |
| 4. 结果导出 | Export、PreviewGeneration | scene.ply、manifest、预览和输出目录 |

阶段标题展示用户语言；展开后才显示技术 Stage。缓存命中使用“已缓存”，不能伪装为本次重新执行完成。

## 5. 区域与功能规格

### A. 左侧项目栏

#### A1. 品牌与折叠按钮

- Logo 和“MetOrigin Splat”点击后返回项目库默认视图。
- 汉堡按钮在 1440 视口切换 232/64 px，在 1024 视口打开或关闭覆盖式项目栏。
- 折叠状态保存在本机 UI 设置中，不写入项目文件。
- 图标按钮必须提供中文 Tooltip 和可见焦点样式。

#### A2. “新建项目”按钮

- 打开三步向导：导入素材 → 检查与方案 → 确认创建。
- 如果已有 Pipeline 运行，允许创建新项目，但不允许启动第二个 Pipeline；向导明确显示“当前已有任务运行”。
- 快捷键：`Ctrl+N`。

#### A3. 项目搜索框

- 按项目名、源文件名和状态过滤本地项目。
- 输入 150 ms 后过滤；不访问网络。
- `Esc` 清空；无结果时显示“没有匹配项目”，而不是空白。

#### A4. 最近项目列表

每个项目行显示：状态色、名称、最近更新时间、当前用户阶段和简短状态。

- 点击整行：切换当前工作区。
- 运行中项目：蓝色状态和实时阶段。
- 完成项目：绿色状态和“打开结果”语义。
- 失败项目：红色状态和失败阶段。
- 丢失目录：灰色状态；点击后提供“重新定位”或“从列表移除”。
- 右键/更多菜单：重命名、打开目录、从列表移除；删除项目文件必须进入单独确认流程。

#### A5. “显示更多项目”

- 默认显示最近 5 个；点击后展开到 20 个。
- 再次点击收起；项目超过 20 个时打开完整项目库视图。

#### A6. “打开项目…”

- 使用原生目录选择器选择 `.splat-project` 目录。
- 选择后校验 `project.json`、schema 和项目锁。
- 有恢复需求时先进入恢复确认，不直接启动 Pipeline。
- 快捷键：`Ctrl+O`。

### B. 顶部项目与运行栏

#### B1. 项目标题

- 显示当前项目名。
- 铅笔按钮进入原位编辑；`Enter` 保存，`Esc` 取消。
- 空值、路径非法字符和同目录重名即时阻断。
- 重命名只修改项目显示名，不静默移动项目目录。

#### B2. 总体进度

- 显示百分比和连续进度条。
- 进度按 Stage 权重计算，不采用 12 阶段简单平均。
- 未运行显示“尚未开始”；恢复分析时显示“不确定，正在校验”。
- 点击进度区域定位到当前阶段并展开。

#### B3. 已用时间与预计剩余

- 已用时间来自当前运行的单调时钟；应用重启后由持久化时间戳恢复。
- 剩余时间必须基于已完成阶段和相同预设历史估算；无历史时显示“正在估算”。
- Tooltip 说明估算可能随 COLMAP/Brush 数据质量变化。

#### B4. “取消（安全）”

- 打开确认对话框，说明当前阶段、可保留内容和重新开始的代价。
- 确认后：发出取消令牌、终止当前进程树、等待退出、验证已有输出、写入 Cancelled 状态并释放项目锁。
- 已完成 Stage 和合法 Brush Checkpoint 保留；不完整的临时输出由 Stage 清理策略处理。
- 取消进行中按钮变为“正在取消…”，不能重复提交。
- 快捷键：`Ctrl+Shift+X`，仍需确认。

#### B5. “暂停 / 继续”

“暂停”定义为可恢复的优雅停止，不承诺外部进程原地挂起：

- FFmpeg/COLMAP：停止当前进程，恢复时重新执行当前 Stage，之前完成的 Stage 走缓存。
- Brush：等待或保留最近合法 PLY Checkpoint，恢复时从该 Checkpoint 继续几何训练。
- 暂停完成后项目状态为 Paused，按钮变为“继续”。
- 继续时重新创建 Orchestrator、执行恢复校验并获取项目锁。
- 暂停中显示“正在保存进度…”，不能同时取消。

#### B6. “操作”菜单

菜单项根据状态动态启用：

- 打开项目目录
- 打开输出目录
- 查看项目文件
- 从当前阶段重新运行
- 从指定阶段重新运行
- 管理 Checkpoint
- 清理无效缓存
- 导出诊断包
- 项目设置

“清理缓存”“从指定阶段重新运行”必须说明会失效的下游 Stage 并二次确认。

#### B7. 检查点状态条

- 显示最后合法 Checkpoint 或自动恢复点、时间和产生阶段。
- 绿色：已验证；黄色：正在写入；红色：损坏或不兼容。
- “管理检查点”打开侧面板，列出迭代、文件大小、版本和验证状态。
- 恢复旧 Checkpoint 会使之后训练/验证/导出状态失效，必须确认。

### C. 中央阶段时间线

#### C1. 阶段容器

每个用户阶段具有：序号、状态图标、标题、摘要、持续时间、进度、展开按钮和纵向连接线。

- 点击标题或展开箭头：展开/收起。
- 当前阶段自动展开；完成阶段默认收起为摘要；失败阶段自动展开并滚动到错误。
- 状态不能只靠颜色表达，同时使用图标和文本。

#### C2. 技术 Stage 行

每行显示：Stage 名称、用途、状态、百分比/数量、耗时、缓存标记和错误标记。

- 点击 Stage：选中该行，同时刷新右侧预览、质量区域和底部日志上下文。
- 双击不触发运行；所有重试通过明确按钮完成。
- 缓存命中显示“已缓存”和 0 秒，不显示成“刚完成”。
- Pending 显示依赖关系；被上游阻断时显示“等待上游”。

#### C3. 当前 Stage 进度

- FFmpeg：当前帧/计划帧、时间位置和抽帧速率。
- COLMAP Feature/Matching：已处理图像/匹配对。
- COLMAP Mapping：已注册图像、稀疏点和当前模型。
- Brush：迭代/总迭代、Checkpoint 迭代和 GPU 使用。
- 没有可靠进度时使用不确定进度动画，不虚构百分比。

#### C4. 阶段级动作

- “重试此阶段”：仅失败、取消或可重新运行 Stage 可用；先使所有下游状态失效。
- “跳过此阶段”：默认仅允许 PreviewGeneration 等非关键可选 Stage；关键依赖 Stage 永久禁用并解释原因。
- “查看详细日志”：定位到底部日志，并固定 Stage 过滤器。
- “打开输出”：仅当前 Stage 已产生可验证输出时可用。

### D. 右侧实时预览

#### D1. 预览标题

- 标题随选中 Stage 变化：抽帧预览、稀疏重建、训练预览或最终模型。
- 副标题显示数据时间点，避免用户误以为画面持续实时更新。

#### D2. 预览画布

- 素材阶段：显示抽取帧 Contact Sheet，可点击查看原帧。
- 相机重建：加载 COLMAP sparse 模型，展示点云和相机视锥。
- 模型训练/结果：加载最新合法 PLY Checkpoint 或 `output/scene.ply`。
- 无可视化输出时显示原因和下一次可用节点，不使用假图。
- 加载大模型时显示进度、取消加载和显存/内存提示。

#### D3. 预览工具栏

| 按钮 | 功能 | 不可用条件 |
| --- | --- | --- |
| 重置视角 | 恢复默认包围盒视角 | 无模型 |
| 旋转/轨道 | 鼠标拖动旋转视角 | 静态帧预览 |
| 平移 | 切换平移模式 | 静态帧预览 |
| 适配窗口 | 将模型包围盒完整放入视口 | 无模型 |
| 网格 | 显示/隐藏地面网格 | 素材预览 |
| 相机 | 显示/隐藏 COLMAP 相机视锥 | 非 sparse 模型 |
| 全屏 | 在工作区内最大化预览 | 永远可用 |
| 截图 | 保存当前预览 PNG | 预览未就绪 |

所有工具栏按钮使用图标 + Tooltip；选中模式有持续状态，不依赖 Hover。

#### D4. 显示模式下拉框

- Sparse 阶段：点云、相机、点云+相机。
- Brush/结果：Gaussian Splat、点模式、质量调试模式（仅确有实现时显示）。
- 选择保存在项目 UI 偏好，不影响 Pipeline 输出。

### E. 当前质量与阶段比较

#### E1. 质量指标

根据阶段动态显示最多 4 个最重要指标：

- COLMAP：注册图像、注册率、稀疏点、重投影误差。
- Brush：迭代、Splat 数量、Checkpoint 大小、模型验证状态。
- 输出：PLY 大小、顶点数、manifest 和预览可用性。

每项同时展示阈值状态；点击指标显示定义和建议。数据缺失显示“—”。

#### E2. 缓存与重运行比较

- 列出本阶段子 Stage 是缓存跳过、首次运行还是重新运行。
- “跳过”只表示已验证缓存命中。
- “重新运行”显示触发原因：用户操作、缓存失效、恢复校验失败或参数变化。
- 点击一行会选中对应 Stage。

#### E3. “打开输出目录”

- 使用系统文件管理器打开项目 `output/`。
- 目录尚不存在时禁用并显示原因。

#### E4. “打开 PLY”

- 仅 `scene.ply` 通过验证后启用。
- 默认在内置预览中打开；菜单允许“在文件管理器中显示”。
- 不自动调用未知的系统关联程序。

### F. 底部活动与日志面板

#### F1. Tab

| Tab | 内容 |
| --- | --- |
| 活动日志 | 结构化事件流，默认显示 |
| 事件 | Stage 生命周期、缓存、恢复和用户操作 |
| 警告 | 非阻断质量和资源告警，显示数量 |
| 错误 | 阻断错误，显示数量 |

Tab 支持键盘左右键切换；数量为 0 时仍可查看空状态。

#### F2. 日志列表

- 列：时间、级别、阶段、消息。
- 默认跟随最新事件；用户向上滚动后暂停自动跟随，并显示“回到最新”。
- 支持按阶段、级别和文本过滤。
- 日志内容等宽字体；路径可复制但默认折叠机器绝对路径。
- 日志上限采用虚拟列表，不把完整大日志加载进 DOM。

#### F3. 日志详情

- 点击日志行，在右侧详情显示完整消息、上下文指标、来源日志和相关建议。
- “复制详情”：复制脱敏后的可分享文本。
- “查看原始日志”：打开只读日志查看器，不直接打开可执行文件。

#### F4. “重试此阶段”

- 只对失败或用户明确停止的 Stage 可用。
- 点击后展示将被失效的下游 Stage；确认后执行。
- 运行中不可用；必须先暂停或取消。

#### F5. “跳过此阶段”

- 仅对明确标记 `optional` 的 Stage 可用。
- 禁止跳过 FrameExtraction、COLMAP 核心重建、BrushTraining、ModelValidation 和 Export。
- 跳过理由写入项目状态与事件日志。

#### F6. “查看详细日志”

- 切换到日志查看器并锁定当前 Stage/进程。
- 支持 stdout/stderr 分流、搜索、复制和打开日志目录。

### G. 底部系统状态栏

#### G1. 引擎版本

- 显示 FFmpeg、COLMAP、Brush 的可用状态和实际版本。
- 点击任一引擎打开“引擎设置”，显示来源路径、版本、验证结果和许可证入口。
- 缺失时使用黄色警告并给出“定位引擎”按钮。

#### G2. GPU / VRAM

- 显示 GPU 名称、CUDA 可用性、当前 VRAM/总 VRAM 和简洁进度条。
- 指标采样失败时显示“GPU 指标不可用”，不把引擎判断为失败。
- VRAM 超过预警阈值时显示黄色；接近 OOM 时显示红色并产生警告事件。

#### G3. 系统

- 显示 Windows 版本和当前资源告警数量。
- 点击打开诊断信息，不把完整系统信息常驻主界面。

## 6. 新建项目向导

### 第 1 步：导入素材

- “选择视频”：原生文件选择器，支持 MP4/MOV/AVI/MKV。
- “选择图片文件夹”：原生目录选择器，扫描 JPG/JPEG/PNG。
- 支持拖放；拖入混合内容时要求用户选择处理方式。
- 选择后立即显示真实缩略图、文件名、时长/数量、分辨率和编码。
- “替换素材”重新选择；不会在用户确认前复制 1.5 GiB 文件。

### 第 2 步：检查与方案

- FFprobe 和素材校验使用统一 `EngineLocator`。
- 显示素材质量、预计帧数、预计项目空间、可用磁盘和引擎状态。
- 预设采用紧凑对比表：Fast/Balanced/Quality；明确帧、分辨率、迭代和估算范围。
- “高级设置”允许查看但不默认展开：FPS、最大帧数、最长边、训练迭代、SH degree。
- 所有自定义值经过 schema 校验并写入项目设置，而不是只改变 UI。

### 第 3 步：确认创建

- 输入项目名并显示实际项目目录。
- 检查重名、权限、磁盘空间和当前活动 Pipeline。
- “仅创建项目”：创建后进入 Ready 工作区。
- “创建并开始重建”：创建、复制/链接素材、进入工作区并启动。
- 创建过程中显示复制进度和取消；取消后清理未完成项目目录。

## 7. 状态与交互规则

### 7.1 项目工作区状态

| 状态 | 主动作 | 允许操作 |
| --- | --- | --- |
| Ready | 开始重建 | 编辑设置、替换素材、打开目录 |
| Running | 暂停 | 安全取消、查看日志、预览 |
| Pausing | 正在保存进度 | 只允许查看 |
| Paused | 继续 | 安全取消、改动会失效下游的设置 |
| Cancelling | 正在取消 | 只允许查看 |
| Cancelled | 继续重建 | 清理缓存、改预设、打开已有输出 |
| Failed | 重试失败阶段 | 查看诊断、从指定阶段重跑 |
| Completed | 打开结果 | 重新导出、从指定阶段重跑 |

### 7.2 应用重启恢复

1. 打开项目后读取持久化 PipelineState。
2. 如果存在 Running/Pausing/Cancelling，执行 CrashRecovery。
3. 校验每个已完成 Stage 的输出。
4. 工作区先展示恢复报告，由用户选择“继续恢复”或“保持暂停”。
5. Brush 仅在合法 Checkpoint 存在时显示具体恢复迭代；优化器未恢复必须明确说明。

### 7.3 失败处理

- 错误消息包含：发生阶段、用户可理解原因、可执行建议、日志入口。
- 技术栈信息留在详情，不直接暴露给普通界面。
- 失败阶段自动选中，时间线和错误 Tab 同步。
- 重试前再次校验引擎、磁盘和输入，避免立即重复同一失败。

## 8. 后端接口变化

### 8.1 现有命令保留并修正

| 命令 | 调整 |
| --- | --- |
| `analyze_media` | 接受 AppHandle，使用 `EngineLocator` 解析 FFprobe |
| `create_project` | 返回复制进度；复制失败不静默忽略 |
| `list_recent_projects` | 改为磁盘持久化项目索引，不只存在内存 |
| `open_project` | 返回恢复摘要、产物摘要和锁状态 |
| `start_pipeline` | 支持从恢复状态和显式起始 Stage 启动 |
| `cancel_pipeline` | 返回取消结果、保留产物和最后 Checkpoint 摘要 |
| `get_pipeline_state` | 附带运行计时和当前活动项目 |

### 8.2 新增命令

| 命令 | 功能 |
| --- | --- |
| `select_media` | 原生选择视频文件或图片目录 |
| `select_project_directory` | 原生选择已有项目目录 |
| `rename_project` | 修改显示名并原子保存 |
| `remove_recent_project` | 只移除索引，不删除文件 |
| `open_project_directory` | 用系统文件管理器打开项目目录 |
| `open_output_directory` | 打开 output 目录 |
| `pause_pipeline` | 优雅停止并持久化 Paused |
| `resume_pipeline` | 恢复校验后继续 |
| `retry_stage` | 使目标和下游状态失效后重跑 |
| `rerun_from_stage` | 用户选择起点并确认影响范围 |
| `get_pipeline_events` | 返回分页结构化事件 |
| `read_stage_log` | 分页读取并区分 stdout/stderr |
| `list_checkpoints` | 列出并验证 Checkpoint |
| `restore_checkpoint` | 恢复指定 Checkpoint，并失效下游 |
| `delete_checkpoint` | 删除单个 Checkpoint，需确认且不能删除正在使用项 |
| `get_project_artifacts` | 返回 frames/COLMAP/PLY/manifest 摘要 |
| `get_resource_metrics` | 返回 GPU、VRAM、磁盘和采样状态 |
| `export_diagnostics` | 生成脱敏诊断包 |

### 8.3 新增事件

```text
project://copy-progress
pipeline://state-changed
pipeline://stage-progress
pipeline://event
pipeline://paused
pipeline://resumed
pipeline://cancelled
pipeline://failed
pipeline://completed
resource://sample
artifact://updated
```

事件都带项目 ID，前端必须忽略非当前项目事件。

## 9. 前端结构

```text
src/
  app/
    AppShell.tsx
    appReducer.ts
    routes.ts
  components/
    shell/TitleRunBar.tsx
    shell/ProjectSidebar.tsx
    shell/SystemStatusBar.tsx
    project/ProjectRow.tsx
    project/NewProjectWizard.tsx
    workspace/PipelineTimeline.tsx
    workspace/PipelinePhase.tsx
    workspace/StageRow.tsx
    workspace/RunControls.tsx
    workspace/CheckpointBar.tsx
    preview/PreviewPane.tsx
    preview/PreviewToolbar.tsx
    preview/QualityMetrics.tsx
    preview/StageComparison.tsx
    activity/ActivityPanel.tsx
    activity/LogTable.tsx
    activity/LogDetail.tsx
    dialogs/ConfirmImpactDialog.tsx
    dialogs/RecoveryDialog.tsx
    dialogs/CheckpointManager.tsx
  hooks/
    usePipelineState.ts
    usePipelineEvents.ts
    useResourceMetrics.ts
    useProjectIndex.ts
  types/
    workspace.ts
  styles/
    tokens.css
    shell.css
    workspace.css
    states.css
```

继续使用 React Context + reducer，先不引入额外状态库。所有 Tauri 调用通过有类型的 service 层封装，组件不直接散落命令字符串。

## 10. 视觉系统

### 10.1 色彩令牌

| Token | 用途 | 建议值 |
| --- | --- | --- |
| `--bg-canvas` | 应用底色 | `#101318` |
| `--bg-sidebar` | 左栏 | `#15191f` |
| `--bg-panel` | 面板 | `#191e25` |
| `--bg-elevated` | 选中/弹层 | `#202731` |
| `--border-subtle` | 分隔线 | `#2c333d` |
| `--text-primary` | 主文本 | `#f2f4f7` |
| `--text-secondary` | 次文本 | `#aab2bf` |
| `--text-muted` | 弱文本 | `#737d8c` |
| `--accent-primary` | 主动作 | `#f0445e` |
| `--accent-active` | 运行态 | `#4c8dff` |
| `--state-success` | 完成/验证 | `#3fc77e` |
| `--state-warning` | 告警 | `#e9a23b` |
| `--state-danger` | 失败/破坏操作 | `#ef4e5d` |

禁止把渐变作为主要层级手段。层级优先依靠间距、文字、分隔线和背景微差。

### 10.2 字体与图标

- 字体：Segoe UI Variable、Segoe UI、Microsoft YaHei UI 回退链。
- 正文 14 px；密集日志 12–13 px；页面标题 20–24 px。
- 图标采用 Phosphor Icons 的 regular/bold 两档，禁止 Emoji 和自制 SVG。
- 图标按钮最小点击区域 32×32 px；关键按钮最小高 36 px。

## 11. 键盘与无障碍

- `Ctrl+N` 新建项目；`Ctrl+O` 打开项目；`Ctrl+L` 聚焦日志搜索。
- `Space` 在时间线焦点上展开/收起；上下键移动 Stage。
- `Ctrl+P` 暂停/继续；破坏操作不提供无确认单键快捷方式。
- 所有面板支持键盘调整或提供等价按钮。
- 状态色达到 WCAG AA，对比不足时增加文本、图标或边框。
- 进度变化使用 `aria-live="polite"`，高频日志不进入实时朗读区。
- 焦点在弹窗关闭后返回触发按钮。
- `prefers-reduced-motion` 下关闭位移动画，只保留必要淡入。

## 12. 实施阶段与提交边界

### Phase 1：设计基础与可操作壳层

范围：

- 引入视觉令牌和 Phosphor 图标。
- 实现 AppShell、顶部运行栏、项目侧栏、状态栏和响应式面板框架。
- 接入原生文件/目录选择和系统目录打开插件。
- 持久化项目索引，修正 `analyze_media` 的 FFprobe 定位。

验收：新建、打开、搜索、切换项目都有真实行为；1024×768 不遮挡主动作。

提交：`feat(ui): establish timeline workspace shell and native project actions`

### Phase 2：新建项目向导

范围：

- 三步向导、真实素材预检、预设对比、高级设置和磁盘检查。
- 复制进度、取消、错误恢复和“仅创建/创建并开始”。

验收：测试视频可以从原生选择器完成项目创建；失败不会留下伪成功项目。

提交：`feat(ui): redesign media import and project preflight flow`

### Phase 3：四阶段时间线与运行控制

范围：

- 12 Stage 到 4 Phase 的映射。
- 阶段折叠、选中、实时进度、缓存、耗时和错误状态。
- 暂停、继续、安全取消、重试和从指定阶段运行。

验收：真实 FFmpeg/COLMAP/Brush 运行时状态一致；应用重启能展示并恢复。

提交：`feat(ui): add interactive pipeline timeline and recovery controls`

### Phase 4：活动日志、错误和 Checkpoint

范围：

- 结构化事件持久化、日志分页、过滤和详情。
- 错误建议、阶段重试、Checkpoint 管理与恢复影响确认。

验收：训练中取消后可看到 Checkpoint、恢复到 3000 step，并能追溯所有操作。

提交：`feat(ui): add contextual logs diagnostics and checkpoint management`

### Phase 5：实时预览与结果

范围：

- Contact Sheet、COLMAP sparse 点云/相机和 PLY/Gaussian Splat 预览。
- 预览工具栏、质量指标、结果清单、打开输出和截图。

验收：`colmap/result.json` 和 `output/scene.ply` 均能在内置预览中打开；无产物时不显示假画面。

提交：`feat(ui): integrate reconstruction preview quality and result export`

### Phase 6：设置、资源和产品收口

范围：

- 引擎路径与版本、项目默认目录、GPU/VRAM/磁盘指标、诊断导出。
- 空/加载/失败/离线状态、快捷键、无障碍、1024/1440 布局。

验收：缺失引擎和低资源在启动前可理解地阻断；完整键盘流程可用。

提交：`feat(ui): complete engine settings resource status and accessibility`

### Phase 7：视觉对照与真实冒烟

范围：

- 用 1440×1024 对照选定设计图执行 Design QA。
- 在 1024×768 做原生窗口冒烟。
- 用真实自行车视频完成创建、运行、暂停/恢复、失败查看、完成和打开 PLY。
- 修复所有 P0/P1/P2 视觉与交互差异。

验收：`design-qa.md` 为 `final result: passed`；前后端门禁与 Tauri debug build 全部通过。

提交：`test(ui): verify timeline workspace against real pipeline`

## 13. 测试矩阵

### 13.1 单元与组件测试

- Stage → Phase 映射和加权进度。
- 项目状态到按钮可用性的状态机。
- 暂停/取消/重试的影响范围计算。
- 日志过滤、脱敏和分页。
- 预设自定义值校验。
- 缺失指标不生成虚假数据。

### 13.2 前端交互测试

- 原生命令使用 mock 覆盖成功、取消、失败。
- 新建向导三步、替换素材和返回。
- 侧栏折叠、项目搜索、状态过滤。
- 时间线展开、Stage 选择、右侧/日志联动。
- 确认弹窗焦点管理、键盘导航和 Reduced Motion。

### 13.3 Rust/Tauri 集成测试

- 项目索引持久化和丢失目录。
- pause/resume/cancel 的锁释放和状态持久化。
- retry/rerun 的下游失效。
- 日志分页、Checkpoint 验证和路径脱敏。
- Dialog/Opener 命令只操作已授权路径。

### 13.4 真实素材验收

- 使用 `<DATASET_ROOT>/video/20260701_C0115.MP4` 创建 Fast 项目。
- 预检显示 3840×2160、133.133 秒和约 266 帧。
- 运行中展示 COLMAP 注册图像和稀疏点。
- Brush 500 step 暂停，应用重启后继续到 3000 step。
- 完成后内置预览并打开 `output/scene.ply`。
- 再次运行时可区分缓存跳过和重新运行。

### 13.5 全量门禁

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

## 14. 明确不在首轮范围内

- 云同步、账号、团队协作和远程渲染。
- 多个 Pipeline 并行执行；首轮仍保持全应用单活动 Pipeline。
- 在 UI 内编辑 COLMAP/Brush 的所有底层参数。
- 自动删除原始素材或项目目录。
- 把 Loss、ETA 或质量分数伪造成引擎未提供的真实指标。

## 15. 完成定义

只有同时满足以下条件，UI 重设计才算完成：

- 图 3 中所有可见区域都有真实数据来源或明确空状态。
- 图 3 中所有按钮都有实现、禁用条件、反馈和错误处理。
- 新建项目不再依赖 `window.prompt`。
- 独立训练页被统一工作区替代，运行状态入口可达。
- 暂停、继续、取消、恢复、重试和缓存语义与后端一致。
- 真实 FFmpeg → COLMAP → Brush 流程能从 UI 完成并打开最终 PLY。
- 1024×768 和 1440×1024 均通过视觉与交互检查。
- Design QA 通过，测试和 Tauri debug build 全绿，工作区无未提交改动。
