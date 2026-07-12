
下面以暂定产品名 **MetaOrigin Splat**、GitHub 仓库 `metorigin/splat` 为基础，制定一份可直接执行的开发计划，并附上一套可以粘贴给 Claude Code 的主提示词。

产品名称后续可以修改，不影响架构设计。

---

# 一、项目基本定义

## 1.1 项目名称

```text
MetaOrigin Splat
```

仓库地址规划：

```text
github.com/metorigin/splat
```

一句话定位：

> 一款开源、本地运行、无需配置 Python 环境的 Gaussian Splatting 桌面应用，将视频或照片自动转换为可查看和导出的三维场景。

英文定位：

> An open-source desktop application for turning photos and videos into Gaussian Splats using local compute.

## 1.2 MVP 技术链路

```text
视频或图片
    ↓
素材检查
    ↓
FFmpeg 视频抽帧
    ↓
图像预处理
    ↓
COLMAP 特征提取
    ↓
COLMAP 特征匹配
    ↓
COLMAP Sparse Reconstruction
    ↓
数据格式检查与转换
    ↓
Brush 本地 GPU 训练
    ↓
Checkpoint / PLY
    ↓
预览与导出
```

## 1.3 第一阶段支持范围

|项目|MVP 范围|
|---|---|
|操作系统|Windows 10/11 x64|
|输入|MP4、MOV、JPG、PNG|
|场景|静态物体、静态室内外场景|
|SfM|本地 COLMAP|
|训练后端|Brush|
|GPU|以 Brush 实际支持情况为准，优先验证 NVIDIA|
|输出|PLY、项目文件、日志|
|UI|Tauri + React + TypeScript|
|核心后端|Rust|
|本地运行|全流程本地，不上传用户素材|
|安装方式|Windows 安装包和便携版|
|开源方式|GitHub Public Repository|

## 1.4 MVP 不包含的内容

首个版本暂不实现：

- 云训练；
    
- 多机训练；
    
- 动态 3DGS；
    
- 手机端训练；
    
- 完整 Gaussian 编辑器；
    
- 自研 SfM；
    
- 自研 3DGS 训练器；
    
- 自动生成公网分享链接；
    
- macOS 和 Linux 正式发行版；
    
- 商业授权系统；
    
- 账号体系；
    
- 在线素材同步。
    

---

# 二、产品目标

## 2.1 核心目标

用户完成以下操作即可训练：

```text
安装软件
→ 导入视频或图片
→ 选择质量
→ 点击开始
→ 等待训练
→ 预览并导出
```

普通用户不应被要求理解以下概念：

- Conda；
    
- CUDA Toolkit；
    
- PyTorch；
    
- SIFT；
    
- Sequential Matcher；
    
- Sparse Reconstruction；
    
- SH Degree；
    
- Densification；
    
- Learning Rate；
    
- Checkpoint 文件格式。
    

这些内容可以存在于高级模式中，但不能阻塞普通用户。

## 2.2 核心成功指标

### 安装指标

- 不要求用户安装 Python；
    
- 不要求用户安装 Conda；
    
- 不要求用户安装编译器；
    
- 软件能够检测缺失的 GPU 驱动或运行依赖；
    
- 安装后可以直接启动。
    

### 任务指标

- 标准素材成功率目标：80% 以上；
    
- 每个步骤都有明确状态；
    
- 失败后能够定位到具体阶段；
    
- 已完成的抽帧和 COLMAP 结果不重复执行；
    
- 支持重新打开项目；
    
- 支持从训练检查点继续。
    

### 用户体验指标

- 首次使用不超过三个主要操作；
    
- 默认设置无需用户理解算法参数；
    
- 错误提示必须包含处理建议；
    
- 用户可以查看详细日志，但默认界面不显示大量底层输出；
    
- 用户始终知道当前处于哪个阶段。
    

---

# 三、总体架构设计

## 3.1 技术架构

```text
┌───────────────────────────────────────────┐
│               Desktop UI                  │
│        Tauri + React + TypeScript          │
│                                           │
│ 项目管理 / 素材导入 / 设置 / 进度 / 预览     │
└──────────────────────┬────────────────────┘
                       │ Tauri Commands / Events
┌──────────────────────▼────────────────────┐
│              Rust Application Core        │
│                                           │
│ Project Manager                           │
│ Pipeline Orchestrator                     │
│ Process Runner                            │
│ Hardware Detector                         │
│ Event Bus                                 │
│ Error Mapper                              │
│ Checkpoint Manager                        │
└───────┬──────────────┬──────────────┬─────┘
        │              │              │
┌───────▼──────┐ ┌─────▼───────┐ ┌────▼───────────┐
│ FFmpeg Adapter│ │COLMAP Adapter│ │ Brush Adapter  │
└───────┬──────┘ └─────┬───────┘ └────┬───────────┘
        │              │              │
┌───────▼──────────────▼──────────────▼─────┐
│               Project Workspace           │
│ source / frames / colmap / training       │
│ output / logs / cache / project.json      │
└───────────────────────────────────────────┘
```

## 3.2 核心设计原则

### 外部引擎必须使用适配器

不能让 UI 或业务代码直接拼接 COLMAP、FFmpeg、Brush 命令。

必须定义统一适配层：

```rust
pub trait EngineAdapter {
    fn name(&self) -> &'static str;
    fn detect(&self) -> Result<EngineInfo, EngineError>;
    fn validate(&self, context: &TaskContext) -> Result<(), EngineError>;
    fn build_command(&self, context: &TaskContext) -> Result<CommandSpec, EngineError>;
}
```

这样未来可以替换：

- Brush → OpenSplat；
    
- COLMAP → GLOMAP；
    
- FFmpeg → 其他媒体处理器。
    

### Pipeline 必须是状态机

不能使用一个超长函数顺序执行全部命令。

每一步必须拥有：

- 唯一 ID；
    
- 输入；
    
- 输出；
    
- 当前状态；
    
- 开始时间；
    
- 结束时间；
    
- 重试次数；
    
- 失败原因；
    
- 日志路径；
    
- 是否可跳过；
    
- 是否可恢复。
    

### 项目是唯一事实来源

UI 不自行保存业务状态。

核心状态统一存放在：

```text
project.json
```

以及运行时状态存储中。

### 所有外部进程统一执行

FFmpeg、COLMAP、Brush 必须通过一个统一的 `ProcessRunner` 启动。

它负责：

- stdout；
    
- stderr；
    
- 日志落盘；
    
- 退出码；
    
- 取消；
    
- 超时；
    
- 进程树终止；
    
- 进度解析；
    
- 崩溃记录；
    
- Windows 路径和编码兼容。
    

---

# 四、建议仓库结构

推荐先采用单仓库模式。

```text
splat/
├── README.md
├── README.zh-CN.md
├── LICENSE
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── CHANGELOG.md
├── Cargo.toml
├── package.json
├── pnpm-workspace.yaml
├── rust-toolchain.toml
├── .editorconfig
├── .gitignore
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── feature_request.yml
│   │   └── config.yml
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── windows-build.yml
│   │   └── release.yml
│   ├── pull_request_template.md
│   └── dependabot.yml
├── apps/
│   └── desktop/
│       ├── src/
│       ├── src-tauri/
│       ├── public/
│       ├── tests/
│       └── package.json
├── crates/
│   ├── splat-core/
│   ├── splat-domain/
│   ├── splat-pipeline/
│   ├── splat-process/
│   ├── splat-project/
│   ├── splat-hardware/
│   ├── splat-engine-ffmpeg/
│   ├── splat-engine-colmap/
│   ├── splat-engine-brush/
│   └── splat-telemetry/
├── schemas/
│   ├── project.schema.json
│   ├── event.schema.json
│   └── preset.schema.json
├── presets/
│   ├── fast.json
│   ├── balanced.json
│   └── quality.json
├── docs/
│   ├── architecture.md
│   ├── development.md
│   ├── engine-integration.md
│   ├── project-format.md
│   ├── release-process.md
│   ├── troubleshooting.md
│   ├── adr/
│   └── plans/
├── scripts/
│   ├── bootstrap.ps1
│   ├── download-engines.ps1
│   ├── verify-engines.ps1
│   └── package-windows.ps1
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── e2e/
└── vendor/
    └── licenses/
```

---

# 五、核心模块开发计划

## 5.1 Domain 模块

职责：

- 定义项目；
    
- 定义任务；
    
- 定义 Pipeline；
    
- 定义阶段；
    
- 定义事件；
    
- 定义错误；
    
- 定义预设；
    
- 定义硬件信息。
    

核心数据类型：

```rust
Project
ProjectSettings
ProjectStatus
Pipeline
PipelineStage
StageStatus
TaskProgress
EngineInfo
HardwareProfile
AppError
RecoveryState
ExportResult
```

必须满足：

- 可序列化；
    
- 可版本升级；
    
- 不依赖 UI；
    
- 不依赖具体引擎；
    
- 单元测试覆盖主要状态转换。
    

## 5.2 Project Manager

职责：

- 创建项目；
    
- 打开项目；
    
- 校验项目；
    
- 保存项目；
    
- 项目版本迁移；
    
- 路径管理；
    
- 缓存清理；
    
- 磁盘占用统计。
    

项目目录：

```text
example.splat-project/
├── project.json
├── source/
│   └── input.mp4
├── frames/
├── processed/
├── colmap/
│   ├── database.db
│   ├── sparse/
│   └── logs/
├── training/
│   ├── checkpoints/
│   ├── config/
│   └── logs/
├── output/
│   ├── scene.ply
│   └── manifest.json
├── cache/
└── logs/
```

`project.json` 示例：

```json
{
  "schemaVersion": 1,
  "id": "0194f6b3-9c35-7b21-92e8-bf0ef22d8a11",
  "name": "museum-room",
  "createdAt": "2026-07-12T12:00:00Z",
  "updatedAt": "2026-07-12T12:30:00Z",
  "source": {
    "type": "video",
    "originalPath": "source/input.mp4"
  },
  "preset": "balanced",
  "status": "running",
  "currentStage": "colmap_mapping",
  "stages": {
    "media_validation": {
      "status": "completed",
      "progress": 1.0
    },
    "frame_extraction": {
      "status": "completed",
      "progress": 1.0
    },
    "colmap_feature_extraction": {
      "status": "completed",
      "progress": 1.0
    },
    "colmap_matching": {
      "status": "completed",
      "progress": 1.0
    },
    "colmap_mapping": {
      "status": "running",
      "progress": 0.46
    }
  }
}
```

## 5.3 Process Runner

这是第一版最重要的基础设施之一。

接口应至少支持：

```rust
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<OsString, OsString>,
    pub log_file: PathBuf,
    pub timeout: Option<Duration>,
}

pub struct ProcessHandle {
    pub process_id: u32,
    pub started_at: DateTime<Utc>,
}

pub enum ProcessEvent {
    Started,
    StdoutLine(String),
    StderrLine(String),
    Progress(TaskProgress),
    Exited(i32),
    Cancelled,
    TimedOut,
}
```

验收标准：

- 正确处理包含中文和空格的 Windows 路径；
    
- stdout 和 stderr 实时读取；
    
- 日志同时落盘；
    
- 可以取消进程；
    
- 取消时终止子进程树；
    
- 能区分用户取消和进程异常；
    
- 不通过 Shell 字符串执行命令，避免转义和注入问题；
    
- 敏感路径不发送到外部服务。
    

## 5.4 FFmpeg Adapter

职责：

- 检测 FFmpeg；
    
- 读取视频信息；
    
- 计算抽帧参数；
    
- 执行抽帧；
    
- 解析进度；
    
- 验证输出帧；
    
- 生成抽帧清单。
    

输入：

```text
input.mp4
```

输出：

```text
frames/000001.jpg
frames/000002.jpg
frames/000003.jpg
frames/frames.json
```

必须处理：

- 视频损坏；
    
- 不支持的编码；
    
- 可变帧率；
    
- 旋转元数据；
    
- 文件名包含中文；
    
- 输出目录无权限；
    
- 磁盘不足；
    
- 用户取消。
    

## 5.5 COLMAP Adapter

建议将 COLMAP 拆成多个独立 Stage：

```text
colmap_database_init
colmap_feature_extraction
colmap_feature_matching
colmap_mapping
colmap_model_validation
```

需要支持的初始模式：

- 图片来源为视频：优先尝试顺序匹配；
    
- 图片来源为独立照片：可使用 exhaustive matching；
    
- 后续再加入 vocabulary tree matching。
    

COLMAP 集成必须做到：

- 不在核心代码中写死未经验证的 CLI 参数；
    
- 在集成时读取当前绑定版本的帮助信息；
    
- 每个 COLMAP 版本建立兼容性记录；
    
- 使用固定测试数据验证命令；
    
- 检查注册图像数；
    
- 检查 sparse model 是否存在；
    
- 检查 cameras、images、points3D 数据完整性。
    

建议定义：

```rust
pub struct ColmapResult {
    pub registered_images: usize,
    pub total_images: usize,
    pub point_count: usize,
    pub model_path: PathBuf,
}
```

失败提示示例：

```text
无法建立稳定的相机轨迹。

已注册图像：4 / 180

可能原因：
1. 视频运动过快或存在模糊；
2. 场景纹理不足；
3. 相邻画面重叠不够；
4. 画面中存在大量动态物体。

建议：
1. 使用更缓慢、连续的拍摄方式；
2. 降低抽帧间隔；
3. 确保目标从多个角度被拍摄；
4. 避免强反光、透明和纯色表面。
```

## 5.6 Brush Adapter

Brush 必须作为可替换训练后端接入。

注意事项：

- 不假设 Brush 的 CLI 参数长期不变；
    
- 开发开始时先确认使用的 Brush 版本；
    
- 保存绑定版本和校验值；
    
- 建立 Brush 版本兼容矩阵；
    
- 实现训练前能力检测；
    
- 验证 Brush 是否可读取当前 COLMAP 输出；
    
- 对训练输出建立统一解析层；
    
- 不让 UI 直接依赖 Brush 的日志格式。
    

建议接口：

```rust
pub trait TrainingEngine {
    fn detect(&self) -> Result<TrainingEngineInfo, EngineError>;
    fn validate_dataset(&self, dataset: &Dataset) -> Result<(), EngineError>;
    fn start_training(
        &self,
        request: TrainingRequest
    ) -> Result<TrainingProcess, EngineError>;
    fn find_checkpoints(
        &self,
        project: &Project
    ) -> Result<Vec<Checkpoint>, EngineError>;
    fn export(
        &self,
        request: ExportRequest
    ) -> Result<ExportResult, EngineError>;
}
```

## 5.7 Hardware Manager

MVP 至少检测：

- 操作系统；
    
- CPU；
    
- 内存；
    
- GPU 名称；
    
- 显存；
    
- 磁盘空间；
    
- DirectX 或 Vulkan 能力；
    
- 外部引擎能否启动。
    

输出：

```rust
pub struct HardwareProfile {
    pub operating_system: OperatingSystem,
    pub cpu_name: Option<String>,
    pub memory_total_bytes: u64,
    pub gpu_devices: Vec<GpuDevice>,
    pub available_disk_bytes: u64,
    pub recommended_preset: PresetId,
    pub warnings: Vec<HardwareWarning>,
}
```

不能仅根据 GPU 名称推断一切。

最终是否兼容，应以：

```text
引擎自检是否成功
```

作为主要判断依据。

## 5.8 Pipeline Orchestrator

建议状态：

```rust
pub enum PipelineStageId {
    MediaValidation,
    FrameExtraction,
    ImagePreprocessing,
    ColmapFeatureExtraction,
    ColmapMatching,
    ColmapMapping,
    ColmapValidation,
    TrainingPreparation,
    BrushTraining,
    ModelValidation,
    PreviewGeneration,
    Export,
}
```

状态：

```rust
pub enum StageStatus {
    Pending,
    Preparing,
    Running,
    Pausing,
    Paused,
    Cancelling,
    Cancelled,
    Completed,
    Failed,
    Skipped,
}
```

Pipeline 必须支持：

- 开始；
    
- 取消；
    
- 重试失败阶段；
    
- 从最后成功阶段继续；
    
- 检查已存在输出；
    
- 重新执行某一阶段；
    
- 阶段级日志；
    
- 进程崩溃恢复。
    

第一版可以不实现真正的任意时刻暂停。

因为部分外部程序并不天然支持暂停。

MVP 可以定义：

```text
取消并保留结果
```

而不是承诺：

```text
任意时刻暂停进程并原地恢复
```

## 5.9 Error Mapper

错误分层：

```text
用户错误
环境错误
素材错误
引擎错误
文件系统错误
系统资源错误
内部错误
```

建议错误码：

|范围|类型|
|---|---|
|1000–1099|项目和文件错误|
|1100–1199|素材错误|
|1200–1299|磁盘和权限错误|
|2000–2099|FFmpeg 错误|
|3000–3099|COLMAP 错误|
|4000–4099|Brush 错误|
|5000–5099|GPU 和硬件错误|
|9000–9099|内部错误|

错误结构：

```rust
pub struct AppError {
    pub code: String,
    pub category: ErrorCategory,
    pub title: String,
    pub user_message: String,
    pub technical_message: Option<String>,
    pub suggestions: Vec<String>,
    pub retryable: bool,
    pub log_path: Option<PathBuf>,
}
```

---

# 六、UI 页面计划

## 6.1 首页

内容：

- 新建项目；
    
- 打开项目；
    
- 最近项目；
    
- 软件版本；
    
- 引擎状态；
    
- 环境警告。
    

## 6.2 新建项目向导

步骤：

```text
选择输入
→ 素材分析
→ 选择保存位置
→ 选择预设
→ 创建项目
```

## 6.3 项目页面

显示：

- 项目名称；
    
- 素材数量；
    
- 当前阶段；
    
- 项目占用空间；
    
- 训练预设；
    
- 注册图像数量；
    
- 最后运行时间；
    
- 继续训练；
    
- 重新执行；
    
- 打开输出目录。
    

## 6.4 训练页面

显示：

- 总体进度；
    
- 当前阶段；
    
- 当前阶段进度；
    
- 已运行时间；
    
- 训练迭代；
    
- 资源占用；
    
- 最新日志；
    
- 取消按钮；
    
- 详细日志入口。
    

## 6.5 结果页面

第一版可以分两步：

### MVP

- 打开外部或独立 Viewer；
    
- 显示输出路径；
    
- 导出 PLY；
    
- 打开输出目录。
    

### 后续版本

- 内嵌 WebGPU Viewer；
    
- 镜头书签；
    
- 简单裁剪；
    
- 背景设置；
    
- 质量统计。
    

## 6.6 设置页面

内容：

- 引擎路径；
    
- 默认项目目录；
    
- 缓存策略；
    
- 日志等级；
    
- 更新通道；
    
- 高级参数；
    
- 隐私说明；
    
- 第三方许可证。
    

---

# 七、预设设计

## 7.1 快速预览

目标：

- 快速验证素材能否完成重建；
    
- 降低分辨率和训练迭代；
    
- 优先缩短反馈时间。
    

配置示意：

```json
{
  "id": "fast",
  "frameExtraction": {
    "fps": 2,
    "maxFrames": 300
  },
  "imageProcessing": {
    "maxLongEdge": 1280
  },
  "training": {
    "qualityLevel": "preview"
  }
}
```

## 7.2 标准质量

默认预设：

```json
{
  "id": "balanced",
  "frameExtraction": {
    "fps": 3,
    "maxFrames": 800
  },
  "imageProcessing": {
    "maxLongEdge": 1920
  },
  "training": {
    "qualityLevel": "balanced"
  }
}
```

## 7.3 高质量

配置由硬件能力决定，不能无条件开放。

应用需要显示：

```text
该模式可能消耗较多显存、内存和磁盘空间。
```

具体参数必须在完成 Brush 实际测试之后确定，不能在代码中依据其他 3DGS 实现直接照搬。

---

# 八、十二周开发计划

## 第 0 周：项目准备

目标：

建立开源项目基础。

任务：

- 创建 `metorigin/splat`；
    
- 确定许可证；
    
- 创建 README；
    
- 添加贡献指南；
    
- 添加行为准则；
    
- 添加安全策略；
    
- 建立 Issue 和 PR 模板；
    
- 建立开发分支策略；
    
- 确定版本号规则；
    
- 确认 FFmpeg、COLMAP、Brush 的再分发许可；
    
- 建立第三方许可证目录。
    

交付物：

```text
仓库可正常克隆
基础文档完整
CI 空流程可运行
许可证初步确认
```

验收：

- GitHub 首页信息完整；
    
- Pull Request 可以触发 CI；
    
- 主分支禁止未审核直接合并；
    
- 第三方组件许可证有记录。
    

---

## 第 1 周：技术验证

目标：

手动打通最小链路。

任务：

- 准备三个测试数据集；
    
- 手动执行 FFmpeg 抽帧；
    
- 手动执行 COLMAP；
    
- 验证 COLMAP 输出；
    
- 手动执行 Brush；
    
- 验证输出模型；
    
- 记录所有命令；
    
- 记录各工具版本；
    
- 记录典型错误；
    
- 记录 GPU、耗时和磁盘占用。
    

交付物：

```text
docs/plans/technical-spike.md
scripts/manual-pipeline.ps1
固定测试数据说明
版本兼容性记录
```

验收：

- 至少一个测试数据可以完整生成 PLY；
    
- 所有外部命令可被脚本复现；
    
- 不依赖手动移动文件；
    
- 明确 Brush 实际输入格式和输出格式。
    

---

## 第 2 周：仓库和 Domain 模型

目标：

完成基础代码骨架。

任务：

- 初始化 Rust workspace；
    
- 初始化 Tauri 应用；
    
- 初始化 React + TypeScript；
    
- 创建 domain crate；
    
- 创建 project crate；
    
- 定义 Project Schema；
    
- 定义 Stage 和 Status；
    
- 定义 AppError；
    
- 添加 JSON Schema；
    
- 添加序列化测试；
    
- 添加项目迁移接口。
    

交付物：

```text
可启动的空桌面应用
Project 数据模型
project.schema.json
基础单元测试
```

验收：

- Rust 测试通过；
    
- TypeScript 检查通过；
    
- 可以创建并保存空项目；
    
- 可以重新打开项目；
    
- 错误格式统一。
    

---

## 第 3 周：Process Runner

目标：

可靠启动和管理外部程序。

任务：

- 实现无 Shell 的命令执行；
    
- 实现 stdout/stderr 流读取；
    
- 实现日志落盘；
    
- 实现退出码处理；
    
- 实现取消；
    
- 实现 Windows 进程树终止；
    
- 实现 UTF-8 和系统编码兼容；
    
- 实现事件通知；
    
- 添加假进程测试工具；
    
- 测试中文路径、空格路径和长路径。
    

交付物：

```text
splat-process crate
process runner integration tests
日志文件规范
```

验收：

- 可以稳定运行长时间外部任务；
    
- UI 能实时接收日志；
    
- 取消后没有残留子进程；
    
- 中文目录下测试通过。
    

---

## 第 4 周：FFmpeg 集成

目标：

实现视频导入和自动抽帧。

任务：

- FFmpeg 能力检测；
    
- FFprobe 元数据读取；
    
- 视频信息解析；
    
- 抽帧计划计算；
    
- 空间预估；
    
- 实时进度解析；
    
- 输出帧验证；
    
- 旋转信息处理；
    
- 失败错误映射；
    
- UI 导入视频流程。
    

交付物：

```text
FFmpeg Adapter
视频素材分析
frames.json
抽帧 UI
```

验收：

- MP4 和 MOV 测试通过；
    
- 取消操作有效；
    
- 磁盘不足时任务提前阻止；
    
- 抽帧完成后帧数量正确。
    

---

## 第 5 周：COLMAP 特征与匹配

目标：

完成 COLMAP 前半段流程。

任务：

- COLMAP 版本检测；
    
- 创建数据库；
    
- Feature Extraction；
    
- Sequential Matching；
    
- Exhaustive Matching；
    
- 日志解析；
    
- 进度估算；
    
- 输入图片检查；
    
- 数据库输出验证；
    
- 失败重试策略。
    

交付物：

```text
COLMAP Adapter 基础版本
特征和匹配 Stage
结构化日志
```

验收：

- 视频帧使用顺序匹配成功；
    
- 独立照片可使用 exhaustive matching；
    
- 数据库产生有效匹配；
    
- 错误可以映射到用户提示。
    

---

## 第 6 周：COLMAP Mapping 与验证

目标：

输出完整 Sparse Reconstruction。

任务：

- Mapper 执行；
    
- 模型目录检测；
    
- 选择最佳模型；
    
- 解析注册图像数；
    
- 解析相机数量；
    
- 解析稀疏点数量；
    
- 建立成功阈值；
    
- 输出诊断报告；
    
- 支持重试 Mapping；
    
- 支持调整抽帧后重新执行。
    

交付物：

```text
完整 COLMAP Pipeline
ColmapResult
重建质量报告
```

验收：

- 测试数据完成 Sparse Reconstruction；
    
- 注册图像数可显示；
    
- 失败时提供明确建议；
    
- 已完成特征提取时重跑 Mapping 不重复前置步骤。
    

---

## 第 7 周：Brush 集成

目标：

完成本地训练闭环。

任务：

- 固定 Brush 版本；
    
- 实现 Brush 检测；
    
- 检查数据兼容；
    
- 生成训练配置；
    
- 启动训练；
    
- 解析训练进度；
    
- 检测输出；
    
- 检测 Checkpoint；
    
- 训练取消；
    
- 训练恢复能力验证；
    
- 输出模型验证。
    

交付物：

```text
Brush Adapter
TrainingRequest
Checkpoint Scanner
PLY 输出
```

验收：

- 从 COLMAP 结果自动启动训练；
    
- UI 可看到训练状态；
    
- 训练输出自动进入项目目录；
    
- 不要求用户手动输入命令。
    

---

## 第 8 周：完整 Pipeline 和恢复

目标：

实现一键任务和失败恢复。

任务：

- 实现 Pipeline Orchestrator；
    
- 实现依赖关系；
    
- 实现阶段跳过；
    
- 实现阶段重试；
    
- 实现崩溃恢复；
    
- 实现启动时未完成项目检测；
    
- 实现输出完整性校验；
    
- 实现取消并保留数据；
    
- 实现项目锁；
    
- 防止同一项目同时运行两个任务。
    

交付物：

```text
完整 Pipeline 状态机
恢复流程
项目锁机制
```

验收：

- 应用关闭后重新打开可以继续；
    
- 已完成阶段不会重复运行；
    
- 损坏输出不会被误判为完成；
    
- 同一项目不能重复启动。
    

---

## 第 9 周：桌面 UI 完善

目标：

完成可用的桌面产品流程。

任务：

- 首页；
    
- 新建项目向导；
    
- 最近项目；
    
- 素材分析页面；
    
- 预设选择；
    
- 训练页面；
    
- 日志页面；
    
- 结果页面；
    
- 设置页面；
    
- 用户错误提示；
    
- Loading、Empty、Error 状态；
    
- 键盘和窗口基本适配。
    

交付物：

```text
完整 MVP UI
中英文基础文案
```

验收：

- 用户无需打开终端；
    
- 所有核心流程可在 GUI 中完成；
    
- 没有无响应的长时间操作；
    
- 关键按钮有防重复点击。
    

---

## 第 10 周：打包、更新和许可证

目标：

生成可以分发的 Windows 版本。

任务：

- Windows 安装包；
    
- Windows 便携版；
    
- 引擎包结构；
    
- 引擎完整性校验；
    
- SHA-256 校验；
    
- 第三方许可证页面；
    
- 引擎版本信息；
    
- 崩溃日志收集说明；
    
- 自动更新设计；
    
- 暂不实现自动更新时，提供手动检查更新。
    

交付物：

```text
Splat-Setup-x.y.z.exe
Splat-Portable-x.y.z.zip
THIRD_PARTY_NOTICES
```

验收：

- 干净 Windows 环境可以安装；
    
- 卸载不删除用户项目；
    
- 缺失引擎时给出明确提示；
    
- 安装包包含所有必须许可证文本。
    

---

## 第 11 周：测试与性能优化

目标：

进入 Beta。

测试矩阵：

|类型|测试内容|
|---|---|
|系统|Windows 10、Windows 11|
|路径|英文、中文、空格、长路径|
|视频|MP4、MOV、横屏、竖屏|
|图片|JPG、PNG、混合分辨率|
|GPU|至少测试两类设备|
|失败|模糊、低纹理、动态物体|
|资源|低磁盘、低内存、低显存|
|中断|关闭应用、取消任务、异常退出|
|权限|只读目录、受限目录|
|重复运行|同项目多次执行|

交付物：

```text
测试报告
已知问题
性能基线
Beta 安装包
```

验收：

- 不存在高频崩溃；
    
- 关键路径 E2E 测试通过；
    
- 失败日志足以定位问题；
    
- 测试数据不会被提交到仓库的大文件历史中。
    

---

## 第 12 周：公开发布

目标：

发布 `v0.1.0-alpha` 或 `v0.1.0-beta`。

任务：

- 完善 README；
    
- 增加截图和 Demo；
    
- 编写安装说明；
    
- 编写拍摄指南；
    
- 编写故障排查；
    
- 创建 GitHub Release；
    
- 创建 Roadmap；
    
- 开启 Discussions；
    
- 准备首批 Issue；
    
- 标注已知限制；
    
- 制定社区反馈流程。
    

发布内容：

```text
安装包
便携包
SHA-256
Release Notes
第三方许可证
示例数据说明
```

---

# 九、发布版本规划

## v0.1.0-alpha

目标：

内部和早期测试者可运行。

包含：

- 视频导入；
    
- FFmpeg；
    
- COLMAP；
    
- Brush；
    
- 基础训练页面；
    
- PLY 输出。
    

不承诺：

- 广泛 GPU 兼容；
    
- 稳定恢复；
    
- 自动更新；
    
- 完整 Viewer。
    

## v0.2.0-beta

包含：

- 项目恢复；
    
- GPU 检测；
    
- 错误诊断；
    
- 完整安装包；
    
- 基础结果预览；
    
- 更多测试设备。
    

## v0.3.0

包含：

- 内嵌 Viewer；
    
- 更多导出格式；
    
- 项目磁盘管理；
    
- 更完善的预设；
    
- 多语言基础支持。
    

## v1.0.0

条件：

- Windows 主流环境稳定；
    
- 核心链路成功率达到目标；
    
- 恢复功能可靠；
    
- 文档完整；
    
- 安装和卸载稳定；
    
- 引擎许可证和分发方式明确。
    

---

# 十、测试策略

## 10.1 单元测试

覆盖：

- 状态机；
    
- 项目序列化；
    
- 路径生成；
    
- 错误映射；
    
- 日志解析；
    
- 参数校验；
    
- 预设读取；
    
- 项目版本迁移。
    

## 10.2 集成测试

覆盖：

- Process Runner；
    
- FFmpeg 测试视频；
    
- COLMAP 小型数据集；
    
- Brush 小型训练样本；
    
- 项目创建和恢复；
    
- 进程取消。
    

## 10.3 E2E 测试

测试用例：

```text
启动应用
→ 新建项目
→ 选择视频
→ 完成抽帧
→ 完成 COLMAP
→ 启动训练
→ 生成输出
→ 打开结果
```

E2E 测试不必每次提交运行完整训练。

CI 中使用：

- Mock Engine；
    
- Fake Process；
    
- 小型 Fixture。
    

真实 GPU E2E 可以在手动发布流程中执行。

## 10.4 Fixture 策略

仓库中不要放大型用户素材。

建议使用：

```text
tests/fixtures/small-static-scene
```

大型测试数据通过：

- Release Assets；
    
- 独立测试仓库；
    
- 对象存储；
    
- 下载脚本。
    

同时记录：

- 来源；
    
- 许可证；
    
- 校验值；
    
- 预期结果。
    

---

# 十一、CI/CD 计划

## 11.1 Pull Request CI

每个 PR 执行：

```text
Rust fmt
Rust clippy
Rust unit tests
TypeScript lint
TypeScript typecheck
Frontend tests
Schema validation
License checks
```

## 11.2 Windows Build

执行：

- Rust release build；
    
- 前端 production build；
    
- Tauri build；
    
- 安装包生成；
    
- Artifact 上传。
    

## 11.3 Release Workflow

触发方式：

```text
Git tag: v0.1.0
```

执行：

- 校验版本；
    
- 生成 changelog；
    
- 构建安装包；
    
- 构建便携包；
    
- 生成 SHA-256；
    
- 上传 GitHub Release；
    
- 附加第三方许可证；
    
- 标记预发布或正式发布。
    

## 11.4 分支策略

建议：

```text
main
feature/*
fix/*
docs/*
release/*
```

初期不建议长期维护 `develop` 分支，避免增加流程负担。

规则：

- `main` 始终可构建；
    
- 每项功能通过 PR；
    
- 至少一项 CI 通过后才能合并；
    
- Squash Merge；
    
- Commit 使用 Conventional Commits。
    

示例：

```text
feat(pipeline): add resumable stage execution
fix(colmap): handle paths containing non-ascii characters
docs: add Windows development guide
```

---

# 十二、主要风险

## 12.1 Brush CLI 不稳定

风险：

- CLI 参数变化；
    
- 输出日志变化；
    
- Checkpoint 格式变化；
    
- GPU 后端行为不同。
    

处理：

- 锁定版本；
    
- 适配器隔离；
    
- 建立版本探测；
    
- 添加兼容测试；
    
- 不让 UI 解析原始 Brush 日志。
    

## 12.2 COLMAP 成功率不足

风险：

- 用户素材质量差；
    
- 低纹理；
    
- 模糊；
    
- 大量动态物体；
    
- 重复纹理；
    
- 相邻画面重叠不足。
    

处理：

- 素材预检查；
    
- 抽帧策略；
    
- 多种匹配方式；
    
- 注册率检测；
    
- 失败建议；
    
- 后续增加自动重试策略。
    

## 12.3 安装包过大

处理：

- 应用本体与 Engine Pack 分离；
    
- 首次运行下载引擎；
    
- 同时提供离线完整包；
    
- 支持按需更新引擎。
    

MVP 早期可以先提供完整包，优先保证稳定性。

## 12.4 GPU 兼容性复杂

处理：

- 不通过宣传承诺全部 GPU；
    
- 首次启动执行引擎自检；
    
- 记录设备和结果；
    
- 建立公开兼容矩阵；
    
- 优先保证一类 GPU 稳定。
    

## 12.5 第三方许可证

处理：

- 开发第一周完成许可证审计；
    
- 记录二进制来源；
    
- 保留许可证文本；
    
- 明确 FFmpeg 构建配置；
    
- 不分发许可证状态不清晰的二进制；
    
- 开源许可证和第三方组件许可证分别管理。
    

---

# 十三、Claude Code 主执行提示词

下面这段可以直接作为 Claude Code 的项目主提示词。建议放到仓库：

```text
docs/plans/claude-code-master-prompt.md
```

也可以在首次运行 Claude Code 时直接粘贴。

```markdown
你现在是 MetaOrigin Splat 项目的首席软件架构师和高级全栈工程师。

你将在当前 Git 仓库中协助开发一个 Windows 优先的开源桌面应用。该应用用于将本地视频或照片自动转换为 Gaussian Splatting 三维场景。

项目暂定名称为 MetaOrigin Splat。

GitHub 组织：
metorigin

目标仓库：
metorigin/splat

你的职责不是一次性生成一个无法维护的大型代码库，而是按照明确阶段，持续构建一个可测试、可审查、可发布和可扩展的工程项目。

# 一、项目目标

用户应当能够完成以下流程：

1. 安装桌面应用；
2. 导入一段视频，或者一个图片文件夹；
3. 应用检查素材、硬件和磁盘空间；
4. 视频通过本地 FFmpeg 自动抽帧；
5. 图片通过本地 COLMAP 完成特征提取、匹配和 Sparse Reconstruction；
6. 将 COLMAP 结果交给本地 Brush 进行 Gaussian Splatting 训练；
7. 应用显示阶段、进度、日志和错误；
8. 训练完成后生成并导出 PLY；
9. 用户可以保存项目、重新打开项目，并从已完成的阶段继续；
10. 用户数据不得自动上传到任何外部服务。

# 二、MVP 范围

第一版只正式支持：

- Windows 10/11 x64；
- MP4、MOV 视频；
- JPG、PNG 图片；
- 静态场景；
- 本地 FFmpeg；
- 本地 COLMAP；
- 本地 Brush；
- 本地 GPU 训练；
- PLY 输出；
- Tauri 桌面应用；
- React + TypeScript 前端；
- Rust 后端。

第一版不实现：

- 云训练；
- 账号系统；
- 多机训练；
- 动态 3DGS；
- 移动端；
- macOS 和 Linux 正式发行；
- 完整 Gaussian 编辑器；
- 自研 SfM；
- 自研训练器；
- 公网分享服务。

# 三、强制工程原则

必须遵守以下原则。

## 3.1 不假设第三方 CLI

在没有通过以下方式验证之前，不允许凭记忆编写 FFmpeg、COLMAP 或 Brush 的具体 CLI 参数：

- 检查仓库现有文档；
- 检查绑定二进制版本；
- 执行 `--help` 或等价命令；
- 查看当前版本官方文档；
- 通过最小测试数据验证。

尤其不得假设 Brush 的训练参数、输出格式、进度日志或恢复方式。

如果第三方 CLI 尚未确认，先建立抽象接口、Mock Adapter、文档和 TODO Issue，不要编造参数。

## 3.2 所有外部引擎必须通过 Adapter

UI、业务层和 Pipeline 不允许直接调用 FFmpeg、COLMAP、Brush。

必须通过以下适配层：

- FfmpegAdapter；
- ColmapAdapter；
- BrushAdapter。

未来需要能够替换：

- Brush → OpenSplat 或其他训练引擎；
- COLMAP → GLOMAP 或其他 SfM；
- Viewer → 其他查看器。

## 3.3 所有外部进程必须通过 ProcessRunner

禁止在不同模块中重复实现子进程启动。

ProcessRunner 必须统一负责：

- program 和 args 分离；
- 工作目录；
- 环境变量；
- stdout；
- stderr；
- 日志文件；
- 退出码；
- 超时；
- 取消；
- Windows 子进程树终止；
- 进度事件；
- UTF-8 和非 UTF-8 输出；
- 中文路径和空格路径；
- 进程异常；
- 用户取消。

禁止使用未转义的 Shell 命令字符串拼接。

## 3.4 Pipeline 必须使用显式状态机

每个 Stage 必须包含：

- ID；
- 状态；
- 输入；
- 输出；
- 开始时间；
- 结束时间；
- 进度；
- 错误；
- 重试次数；
- 日志位置；
- 输出验证逻辑；
- 是否允许重试；
- 是否允许跳过。

Stage 状态至少包括：

- Pending；
- Preparing；
- Running；
- Paused；
- Cancelling；
- Cancelled；
- Completed；
- Failed；
- Skipped。

第一版不应虚假承诺所有外部进程支持真正暂停。

对于不支持暂停的任务，应实现：

“取消并保留已经完成的数据”。

## 3.5 项目状态必须可恢复

核心项目状态保存到 `project.json`。

每个成功 Stage 完成后必须原子写入项目状态。

禁止直接覆盖导致文件损坏，应采用：

1. 写入临时文件；
2. flush；
3. 原子替换。

应用启动时必须能够检测：

- 上次是否异常退出；
- 当前 Stage 是否仍标记为 Running；
- 已有输出是否完整；
- 哪个 Stage 可以继续；
- 是否存在项目锁。

## 3.6 错误必须面向用户

所有错误都应转换为统一 AppError。

AppError 至少包含：

- code；
- category；
- title；
- user_message；
- technical_message；
- suggestions；
- retryable；
- log_path。

不允许将以下信息直接作为默认用户错误提示：

- stack trace；
- panic；
- segmentation fault；
- raw exception；
- 未解释的 exit code。

技术错误可以进入详细日志。

## 3.7 本地优先和隐私

默认情况下：

- 不上传素材；
- 不上传项目路径；
- 不上传日志；
- 不启用分析统计；
- 不连接未声明服务；
- 不收集硬件数据。

任何未来遥测都必须：

- 默认关闭或明确征得同意；
- 文档说明；
- 可在设置中关闭；
- 不包含用户素材和完整本地路径。

## 3.8 不允许无意义占位实现

禁止提交以下形式的功能冒充完成：

- 返回固定成功；
- 使用 sleep 模拟真实任务但未明确标注 Mock；
- 空的 catch；
- 忽略 Result；
- 仅打印 TODO；
- 大量未关联 Issue 的 TODO；
- 声称支持恢复但未验证；
- 声称支持某 GPU 但未测试。

Mock 仅允许用于测试，并且命名必须明确包含 Mock 或 Fake。

# 四、技术栈

桌面端：

- Tauri；
- React；
- TypeScript；
- 推荐使用 Vite；
- 状态管理应保持轻量，优先使用 React Query、Zustand 或简单 Context，避免初期引入过重架构。

Rust：

- stable toolchain；
- Tokio 用于异步任务；
- Serde 用于序列化；
- thiserror 用于内部错误；
- tracing 用于结构化日志；
- uuid 或 UUID v7 用于项目和任务 ID；
- chrono 或 time 用于时间。

测试：

- Rust 单元测试；
- Rust 集成测试；
- 前端单元测试；
- Mock Engine；
- 小型 E2E Fixture。

不要在未经讨论时引入：

- 数据库服务器；
- 微服务；
- Docker 作为普通用户运行依赖；
- Redux 大型架构；
- 多仓库拆分；
- 云基础设施；
- Kubernetes。

# 五、建议仓库结构

请优先建立以下结构：

splat/
├── apps/desktop/
├── crates/splat-domain/
├── crates/splat-core/
├── crates/splat-project/
├── crates/splat-pipeline/
├── crates/splat-process/
├── crates/splat-hardware/
├── crates/splat-engine-ffmpeg/
├── crates/splat-engine-colmap/
├── crates/splat-engine-brush/
├── schemas/
├── presets/
├── scripts/
├── tests/
├── docs/
└── vendor/licenses/

如果当前仓库已有结构，不要立即推翻。

先分析现有结构，并提出迁移计划。

# 六、必须建立的核心类型

至少建立以下类型，名称可以在说明理由后调整：

- Project；
- ProjectSource；
- ProjectSettings；
- ProjectStatus；
- PipelineStageId；
- StageStatus；
- StageState；
- PipelineState；
- TaskProgress；
- AppError；
- ErrorCategory；
- EngineInfo；
- HardwareProfile；
- GpuDevice；
- CommandSpec；
- ProcessEvent；
- ProcessResult；
- TrainingRequest；
- Checkpoint；
- ExportResult。

所有公共类型必须：

- 有文档注释；
- 有合理的派生 Trait；
- 能够被测试；
- 避免与 UI 类型耦合；
- 避免直接存放难以迁移的第三方原始数据。

# 七、Pipeline 阶段

至少设计以下 Stage：

1. MediaValidation；
2. FrameExtraction；
3. ImagePreprocessing；
4. ColmapFeatureExtraction；
5. ColmapMatching；
6. ColmapMapping；
7. ColmapValidation；
8. TrainingPreparation；
9. BrushTraining；
10. ModelValidation；
11. PreviewGeneration；
12. Export。

每一个 Stage 必须有：

- 输入验证；
- 执行方法；
- 输出验证；
- 进度事件；
- 错误映射；
- 重试策略；
- 是否可以使用缓存的判断。

# 八、项目目录格式

项目目录建议：

project.splat-project/
├── project.json
├── source/
├── frames/
├── processed/
├── colmap/
├── training/
├── output/
├── cache/
└── logs/

不得将绝对路径作为唯一依赖。

项目内部文件尽量使用相对路径。

外部源文件可以记录：

- 原始绝对路径；
- 是否复制到项目；
- 当前是否可访问。

必须建立 JSON Schema：

- schemas/project.schema.json；
- schemas/preset.schema.json；
- schemas/event.schema.json。

必须包含 schemaVersion，并准备未来迁移机制。

# 九、UI 要求

UI 必须包含：

1. 首页；
2. 新建项目；
3. 素材分析；
4. 预设选择；
5. 项目详情；
6. 训练进度；
7. 详细日志；
8. 结果与导出；
9. 设置；
10. 关于与第三方许可证。

用户默认只看到友好状态。

高级日志必须能够展开查看。

所有长任务必须：

- 不阻塞 UI；
- 显示当前阶段；
- 显示取消按钮；
- 防止重复点击；
- 在应用关闭前提示任务仍在运行。

# 十、开发顺序

必须按以下顺序推进，除非现有仓库状态有充分理由调整。

## Phase 0：仓库审计

第一步只做分析，不立即重写。

检查：

- 当前文件结构；
- Git 状态；
- 现有 README；
- Cargo 配置；
- Node 配置；
- Tauri 配置；
- 许可证；
- CI；
- 测试；
- 已有代码。

输出：

- `docs/plans/repository-audit.md`；
- `docs/plans/implementation-roadmap.md`；
- 当前风险；
- 建议的第一批小任务。

## Phase 1：工程基础

建立：

- Rust workspace；
- 前端工程；
- fmt；
- clippy；
- eslint；
- typecheck；
- 测试；
- CI；
- 基础文档。

完成标准：

- 空应用可启动；
- CI 全绿；
- README 有本地开发说明。

## Phase 2：Domain 和 Project

完成：

- 核心模型；
- Project Manager；
- JSON Schema；
- 原子保存；
- 项目打开和创建；
- 单元测试。

完成标准：

- 创建项目；
- 保存；
- 关闭；
- 重新打开；
- 状态一致。

## Phase 3：ProcessRunner

完成：

- 子进程；
- 日志；
- 取消；
- 超时；
- Windows 路径；
- 测试 Fake Process。

完成标准：

- 运行可控；
- 取消无残留；
- 日志完整。

## Phase 4：FFmpeg

完成：

- 检测；
- 元数据；
- 抽帧；
- 进度；
- 输出验证。

## Phase 5：COLMAP

完成：

- 特征；
- 匹配；
- Mapping；
- 结果解析；
- 错误诊断。

## Phase 6：Brush

完成：

- 检测；
- 数据集验证；
- 训练；
- Checkpoint；
- 导出；
- 版本兼容记录。

## Phase 7：Pipeline

完成：

- 状态机；
- 依赖；
- 重试；
- 恢复；
- 缓存；
- 项目锁。

## Phase 8：UI

完成：

- 全流程 GUI；
- 用户错误；
- 日志；
- 结果。

## Phase 9：Packaging

完成：

- Windows 安装包；
- 便携包；
- 引擎包；
- 许可证；
- 校验值。

## Phase 10：QA 和 Release

完成：

- 测试矩阵；
- 文档；
- Release；
- 已知问题；
- Roadmap。

# 十一、每次执行任务时的响应格式

每次准备修改代码前，必须先输出：

## 1. 当前目标

用一段话说明这次只解决什么问题。

## 2. 当前状态

说明相关模块目前已经有什么、缺少什么。

## 3. 计划修改的文件

列出预计新增、修改和删除的文件。

未经说明，不要删除文件。

## 4. 实施步骤

将工作拆成可以验证的小步骤。

## 5. 风险

指出可能影响兼容性、数据安全或后续架构的风险。

完成代码修改后，必须输出：

## 6. 实际修改

准确列出完成内容。

## 7. 测试

列出执行的命令及结果。

## 8. 未完成事项

明确说明哪些内容没有完成，不允许暗示已经完成。

## 9. 下一步

只推荐一个最合理的下一任务，不要一次扩展多个方向。

# 十二、代码质量规则

Rust：

- `cargo fmt --check` 必须通过；
- `cargo clippy --all-targets --all-features -- -D warnings` 应尽量通过；
- 禁止在生产代码中无理由使用 unwrap；
- 不允许静默丢弃错误；
- 公共 API 有文档；
- 模块职责清晰；
- 避免巨型文件；
- 避免不必要的 clone；
- 文件操作明确处理失败；
- 重要写入使用原子方式。

TypeScript：

- strict mode；
- 禁止滥用 `any`；
- API 类型来源统一；
- 不在组件中写底层命令；
- 组件保持单一职责；
- 长任务状态从统一 store 或 query 层读取；
- 用户错误和技术错误分开显示。

通用：

- 一个 PR 解决一个明确问题；
- 小步提交；
- 不引入未使用依赖；
- 依赖需要说明理由；
- 避免过早抽象；
- 同时避免将第三方引擎逻辑散落在业务代码中。

# 十三、文档要求

至少维护：

- README.md；
- README.zh-CN.md；
- CONTRIBUTING.md；
- SECURITY.md；
- CHANGELOG.md；
- docs/architecture.md；
- docs/development.md；
- docs/project-format.md；
- docs/engine-integration.md；
- docs/troubleshooting.md；
- docs/release-process.md；
- docs/adr/。

影响架构的决定需要创建 ADR。

ADR 格式：

- Context；
- Decision；
- Alternatives；
- Consequences；
- Status。

# 十四、安全要求

禁止：

- 将用户文件上传到网络；
- 将完整用户路径写入公开日志；
- 执行来自项目文件的任意命令；
- 使用 Shell 拼接未验证参数；
- 自动执行下载文件而不校验；
- 提交密钥；
- 在日志中记录 Token；
- 运行来源不明的二进制。

下载引擎包时必须：

- 使用 HTTPS；
- 校验 SHA-256；
- 记录版本；
- 显示许可证；
- 失败时不使用部分下载文件。

# 十五、第一轮具体任务

请先完成以下工作，不要立即实现完整 FFmpeg、COLMAP 或 Brush 流程。

第一轮只做：

1. 审计当前仓库；
2. 创建 `docs/plans/repository-audit.md`；
3. 创建 `docs/plans/implementation-roadmap.md`；
4. 创建或修正基础目录结构；
5. 初始化 Rust workspace；
6. 初始化 Tauri + React + TypeScript 桌面应用；
7. 建立 `splat-domain`；
8. 定义最小 Project、PipelineStageId、StageStatus、AppError；
9. 建立基础测试；
10. 建立 CI；
11. 更新 README 的本地开发步骤。

第一轮完成标准：

- `cargo test --workspace` 通过；
- 前端 lint 和 typecheck 通过；
- Tauri 开发模式能够启动；
- CI 配置有效；
- 创建和序列化一个最小 Project 的测试通过；
- 不包含伪造的 FFmpeg、COLMAP 或 Brush 实现。

开始前，先输出仓库审计和拟修改文件，不要直接大范围写代码。
```

---

# 十四、Claude Code 每轮任务模板

主提示词设置后，每一轮再发送一个较小的任务提示词。

```markdown
请执行 MetaOrigin Splat 的下一项开发任务。

当前任务：

[在这里写本轮唯一任务，例如：实现 ProcessRunner 的最小可用版本]

本轮范围：

- 只处理与当前任务直接相关的文件；
- 不实现后续引擎；
- 不进行无关重构；
- 不修改公开 API，除非先说明理由；
- 不删除已有测试；
- 不提交未经验证的第三方 CLI 参数。

开始前先输出：

1. 当前代码状态；
2. 实施方案；
3. 预计修改文件；
4. 测试方案；
5. 风险。

然后再实施。

完成后必须：

1. 执行格式化；
2. 执行相关测试；
3. 执行 lint 或 clippy；
4. 汇报实际测试结果；
5. 列出未完成事项；
6. 推荐下一项唯一任务。

本轮验收标准：

[在这里填写明确的可验证条件]

不满足验收标准时，不要声称任务已经完成。
```

---

# 十五、第一轮 Claude Code 提示词

建立仓库后，可以直接用下面这段开始第一次执行：

```markdown
请开始 MetaOrigin Splat 项目的 Phase 0 和 Phase 1。

项目目标是开发一个 Windows 优先的开源桌面应用，通过本地 FFmpeg、COLMAP 和 Brush，将视频或图片转换为 Gaussian Splatting 场景。

本轮只完成工程基础，不接入真实 FFmpeg、COLMAP 或 Brush。

具体任务：

1. 审计当前仓库文件和 Git 状态；
2. 不覆盖有价值的现有文件；
3. 创建：
   - docs/plans/repository-audit.md
   - docs/plans/implementation-roadmap.md
   - docs/architecture.md
   - docs/development.md
4. 初始化或修正 Rust workspace；
5. 初始化 Tauri + React + TypeScript；
6. 创建以下 Rust crates：
   - splat-domain
   - splat-project
   - splat-process
   - splat-pipeline
7. 在 splat-domain 中实现最小类型：
   - ProjectId
   - Project
   - ProjectStatus
   - PipelineStageId
   - StageStatus
   - StageState
   - ErrorCategory
   - AppError
8. 所有类型应支持必要的序列化、反序列化、Debug、Clone 和测试；
9. 为 Project 定义 schemaVersion；
10. 建立项目 JSON 序列化和反序列化测试；
11. 建立基础 GitHub Actions：
    - cargo fmt check
    - cargo clippy
    - cargo test
    - frontend lint
    - frontend typecheck
12. 更新 README.md 和 README.zh-CN.md，加入开发环境和启动步骤；
13. 不实现假的引擎调用；
14. 不写死未经验证的 FFmpeg、COLMAP、Brush 参数；
15. 不添加云服务、账号、遥测或数据库。

建议目录：

- apps/desktop
- crates/splat-domain
- crates/splat-project
- crates/splat-process
- crates/splat-pipeline
- schemas
- presets
- docs
- scripts
- tests

开始修改前，请先输出：

1. 当前仓库审计摘要；
2. 计划新增和修改的文件；
3. 技术选择；
4. 风险；
5. 分步实施计划。

完成后执行并汇报：

- cargo fmt --check
- cargo clippy --workspace --all-targets
- cargo test --workspace
- 前端 lint
- 前端 typecheck

如果环境缺少构建依赖，请明确说明，不要伪造测试成功。

本轮最终验收标准：

- 项目目录清晰；
- Rust workspace 可解析；
- 单元测试通过；
- 前端可以完成 typecheck；
- Tauri 开发入口存在；
- Project 可以序列化后正确恢复；
- CI 文件存在且配置合理；
- 文档中明确下一阶段是 ProcessRunner；
- 没有引入真实引擎的伪实现。
```

---

# 十六、后续 Claude Code 任务顺序

建议严格按下面顺序逐个执行，不要一次发送全部。

```text
1. 仓库审计与工程初始化
2. Domain 模型
3. Project Manager
4. ProcessRunner
5. ProcessRunner Windows 取消与进程树
6. FFmpeg 能力检测
7. FFprobe 视频元数据
8. FFmpeg 抽帧
9. COLMAP 能力检测
10. COLMAP Feature Extraction
11. COLMAP Matching
12. COLMAP Mapping
13. COLMAP 结果验证
14. Brush 能力检测
15. Brush 数据集验证
16. Brush 训练执行
17. Brush Checkpoint 和输出
18. Pipeline 状态机
19. Pipeline 缓存和跳过
20. Pipeline 崩溃恢复
21. 首页和新建项目 UI
22. 素材分析 UI
23. 训练进度 UI
24. 日志和错误 UI
25. 结果与导出 UI
26. Windows 打包
27. 第三方许可证
28. 测试矩阵
29. Beta Release
```

每个任务最好保持在：

```text
一个清晰目标
一组相关文件
一套明确测试
一个可审查 PR
```

不要让 Claude Code 在一轮中同时实现 COLMAP、Brush、UI、打包和发布。这样很容易出现表面完整、实际不可运行的代码。