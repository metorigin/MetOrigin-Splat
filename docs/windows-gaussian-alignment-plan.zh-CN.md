# Windows 高斯生成与 macOS 功能对齐实施方案

日期：2026-10-30。状态：实施中；逐项实现、自动验证及原生门槛见[实施记录](validation/windows-alignment.md)。应用源码基线：`69a6990`。

本方案将 Windows 的重建链路升级到与当前 Mac 同源的 Brush 1.0，补齐机器能力检查、运行配置、实时预览、资源管理、开发启动和引擎打包。通用界面、Spark、SuperSplat、媒体处理与结果校验继续使用现有共享实现。COLMAP 固定 4.1.0，Windows 使用经过验证的 CUDA 路径，Mac 保持 CPU 路径。

交付必须同时满足两个条件：Windows 在配套引擎下完成真实照片和视频重建；Mac 既有引擎、运行配置和原生流程没有因共享修改退化。Windows 构建成功不能替代 Windows GPU 验收，也不能替代 Mac 原生回归。

本文中的新增脚本、命令、接口和任务均为实施目标，不能当作当前仓库已经具备的功能。

## 1 目标和交付范围

### 1.1 用户可见结果

1. Windows 开发者通过一个专用入口完成引擎检查、首次准备和桌面启动；后续启动复用已验证缓存。
2. Windows 完整安装包包含 FFmpeg、FFprobe、COLMAP 和配套 Brush；正常运行使用包内资源，无需逐个定位可执行文件。
3. 照片和视频均可完成预处理、相机重建、训练、实时预览、最终查看、编辑保存与导出。
4. 暂停、取消、退出和恢复具有明确状态；失败保留最后有效模型与可恢复记录。
5. 设置和预检准确显示实际引擎版本、GPU、后端、有效训练参数及不可用原因。
6. Mac 保留原有 CPU COLMAP、Metal Brush、统一内存策略、窗口和退出语义。

### 1.2 本轮边界

首轮 Windows 目标为 Windows 10/11 x64、NVIDIA 独显、COLMAP 4.1 CUDA、Brush 1.0 WGPU。现有测试机为 RTX 5080 Laptop GPU，检测总显存约 16 GB、驱动 592.01，已发现 CUDA 12.8 工具链。该机器是一项验证环境，不代表全部 Windows GPU 或最低配置验收。

本轮保留旧 Windows 0.3 引擎的显式兼容路径和旧项目查看能力。跨引擎恢复按新的训练尝试处理；优化器状态不连续。

COLMAP 4.3 数据库升级、AMD/Intel 完整支持、Mac 新性能优化、改变公共质量预设和公开发布签名不属于本轮完成条件。现有 Mac M3/M4 未通过项继续在原记录中跟踪。

## 2 已确认的源码基线和缺口

| 对象 | 已确认状态 | 实施约束 |
| --- | --- | --- |
| 主项目 | `69a6990`，共享 UI、预览、编辑和流水线修复已合入 | 在当前代码上增加 Windows 接入，避免再复制一套公共实现 |
| 本地 Brush | `main`，`1388f74c6fe0236f68ee4915564bf00e9d2e3747`，工作区干净，stock 1.0.0 | 这是 Mac 补丁基础；本地尚未包含 MetOrigin 机器接口和 live 实现 |
| Mac Brush 派生版本 | 基础提交加 `metorigin-macos.6.patch` | 原补丁、哈希和 Mac 构建配方保持冻结 |
| 本地 COLMAP | `main`，`fa089062a56261d11b070aaea0c767cc3730526f`，版本 4.3.0.dev0 | 不直接用于当前应用项目数据库 |
| 目标 COLMAP | 4.1.0，`fa8e3b3ff591552855f8ad2806723c80f963f69c` | 本地对象库尚缺该提交，构建前必须获取并验证 |
| 当前 Windows 包 | FFmpeg 8.1.2、COLMAP 4.1.0 CUDA、Brush 0.3.0 加旧 live companion | 现有准备命令不能代表新版 Windows 对齐完成 |

Mac `.6` 补丁 SHA-256 为 `1e342de3d80fc9ae3ac38873814b17b9bc6d8ce067159ad3eae02ef3148353d2`。本地 Brush 的补丁适用性检查已通过，源码未被应用补丁。

| 层面 | 当前缺口 | 主要源码 |
| --- | --- | --- |
| 能力检查 | Windows 仅检查 NVIDIA 驱动；新能力解析限定 Darwin ARM64 和 Metal | [Brush runtime](../crates/splat-engine-brush/src/runtime.rs) |
| 运行配置 | Tauri 对非 Metal 返回无 profile；仅有 Mac profile 构造 | [桌面 runtime](../apps/desktop/src-tauri/src/commands/runtime.rs)、[pipeline runtime](../crates/splat-pipeline/src/runtime.rs) |
| 契约 | Rust 和 Schema 的 Windows 分支限定 `legacy_0_3` | [domain runtime](../crates/splat-domain/src/runtime.rs)、[Schema](../schemas/execution-profile.schema.json) |
| 发现和打包 | Windows 脚本固定旧文件名；自动 `.engines` 环境覆盖可能遮挡界面配置 | [locator](../crates/splat-hardware/src/locator.rs)、[应用入口](../apps/desktop/src-tauri/src/lib.rs)、[准备脚本](../scripts/windows/Prepare-EnginePack.ps1) |
| 资源保护 | 非 Mac 预览策略固定为 Allow；训练预算是统一内存策略 | [资源策略](../apps/desktop/src-tauri/src/commands/system/resources.rs) |
| 退出 | Mac 原生退出保护已有接线，Windows 需独立接入和验收 | [lifecycle](../apps/desktop/src-tauri/src/lifecycle.rs) |
| COLMAP 兼容 | 无 profile 的旧路径仅检查 help 成功，可能放行 4.3 | [COLMAP adapter](../crates/splat-engine-colmap/src/adapter.rs)、[执行设置](../crates/splat-engine-colmap/src/execution.rs) |

## 3 保护 Mac 的实施规则

### 3.1 冻结引擎和平台策略

W0 建立保护清单，包含 Mac Brush `.6` 补丁及其校验值、Mac 引擎构建与打包脚本、来源索引、Tauri Mac 配置、Mac profile fixtures、CPU COLMAP 参数、Metal 探测条件和预算函数的输入输出。

Windows 引擎按以下顺序生成：

    Brush 1388f74 基础源码
      → 原字节的 metorigin-macos.6 公共集成补丁
      → 新增 metorigin-windows.1 平台增量补丁
      → x86_64-pc-windows-msvc 构建

Mac 继续只应用基础源码和原 `.6` 补丁。Windows 增量补丁针对已经应用 `.6` 的源码树生成，不能直接应用到原始提交。Windows 增量补丁、构建目录、版本身份和产物不进入 Mac 配方。构建记录包含两个补丁的哈希、应用顺序及最终源树身份；历史 Mac 产物和验收证据不重新标记为新结果。

### 3.2 公共接口和平台实现分开

公共层继续负责引擎身份、PLY、训练参数、请求与 ACK、缓存指纹和原子状态落盘。平台层分别负责 GPU 后端、预算、动态库环境、进程退出和窗口事件。

新增 `WindowsProfileRequest` 与 Windows profile 构造函数，保留 Mac wrapper 和既有输入输出。公共身份收集函数需要显式接收平台和 COLMAP 设置；现有 `read_engine_identities` 内部的 Mac 固定参数不能直接用于 Windows。

Mac 仍严格校验 ARM64、Metal、CPU SfM 和原有资源约束。Windows 新分支通过同等强度的独立检查；不通过放宽 Mac 校验获得兼容。

## 4 引擎构建与运行契约

### 4.1 Windows Brush 构建

新增 Windows 构建脚本，建议命名为 `scripts/windows/Build-BrushRuntime.ps1`。接受源码位置、输出目录、离线模式和验证模式；这些均为待实现接口。

脚本使用隔离 checkout，验证基础提交、冻结补丁和 Windows 增量补丁。应用 Rust 仍为 1.97.0；Brush 首轮沿用固定 1.95.0，单独记录 Cargo.lock、目标平台和依赖 feature 图。基础构建命令为 `cargo +1.95.0 build --locked --release -p brush-cli --target x86_64-pc-windows-msvc`，须在完成补丁和前置检查后执行。

构建输出至少包括 `brush-cli.exe`、版本和 help 输出、机器接口输出、二进制哈希、构建记录和所需许可文件。Windows 版本身份采用独立的 `1.0.0+metorigin-windows.1`；最终编号在 W1 冻结。发行依赖裁剪沿用 `.6` 的既有政策，并核查 Windows 目标的实际依赖树。

缓存键绑定源码提交、两个补丁哈希、Cargo.lock、Rust 版本、target 和 feature 选择。旧缓存只有键及文件完整性均通过时才复用。源码和旧引擎不被构建过程覆盖。

### 4.2 GPU 选择与真实计算探测

保留 `--capabilities-json` 和 `--probe-json` 的协议形式。Windows 能力信息使用规范 target `x86_64-pc-windows-msvc`，报告可用协议和功能；probe 报告实际选中的 backend、adapter 和计算结果。

锁定 CubeCL 的自动后端顺序是 Vulkan、DX12、GL，本地 Brush 的注释不能替代实际结果。`AUTO_GRAPHICS_BACKEND` 在相关依赖中仅用于其测试编译，不作为应用的生产选择接口。

Windows 增量补丁提供明确的后端及设备选择方式。W1 固定接口名称后，同一设备选择函数同时供 probe 和训练使用。首轮分别测试 DX12 和 Vulkan；只有通过实际渲染、反向传播和短训练的组合可以成为默认。GL 不纳入本轮支持范围。

必须保证：

- probe 与训练使用同一 backend 和设备选择；GPU 不可用时返回错误，不在训练中静默换设备或后端。
- 能力身份、版本、基础提交、二进制哈希和运行配置一致；探测前后校验文件未变化。
- Windows probe 沿用实际 8 高斯、32×32 渲染与反向传播检查，结果有限、loss 有限、梯度非零；创建 GPU device 或打印版本不算通过。
- 同一笔记本存在多个 adapter 时，记录可核对的设备身份；不得把 NVIDIA 枚举序号直接当作 WGPU 序号。不能稳定绑定时，应拒绝声称设备一致并补齐选择机制。
- `nvidia-smi` 用于设备观测及旧路径兼容，不替代新版计算证据，也不意味着 Brush 使用 CUDA。
- 缓存探测结果时绑定引擎、驱动、设备选择和系统信息；训练前复核关键身份与可用性。

### 4.3 检查点与实时预览

复用 `.6` 的 CLI token 来源、线程限制、官方 PLY serializer、迭代号与模型配对快照、完整写入和失败传播。原补丁的目录同步已受 Unix 条件保护；Windows 需要验证的是文件替换、占用和失败恢复语义。

检查点与 live 的测试覆盖：首次创建、覆盖已有目标、目标正被读取、目录不可写、磁盘写入失败、取消和强制终止、遗留临时文件，以及最新完整记录的恢复。必要的修复放入 Windows helper 或增量补丁，保持 Unix 原路径。

新 Windows 主 CLI 同时承担训练和协商后的 live，不调用 0.3 companion。旧引擎仍保留其 companion 路径。新协议未获支持时可查看完整 checkpoint；已启用 live 不能冒用未知能力。

验证同一训练快照、同一迭代的 live 与 checkpoint 属性一致，覆盖单位缩放、坐标、SH 和 Gaussian 数量。跨两次独立训练不要求 PLY 字节相同。旧 session、过期请求、重复 ACK、关闭预览和训练结束都不能持续生成失效快照。

### 4.4 Windows COLMAP

第一轮保留 4.1.0 CUDA 契约，优先验证现有锁定归档在目标机器上的特征提取与匹配。若该归档不满足目标 GPU 或依赖要求，再从固定 4.1 提交构建 Windows 包，并单独冻结依赖和 CUDA 构建参数。

本地 4.3 的 cameras 表已有多来源结构，打开旧库可能触发迁移。新版 Windows 必须在任何可能接触项目数据库的引擎命令之前拒绝不兼容版本；旧无 profile 路径也补相同的 4.1 版本保护。测试证明拒绝 4.3 前后数据库字节未变。

Windows 显式冻结 feature extraction、matching 和 global positioning 的 CPU/CUDA 设置，BA 仍采用 Ceres CPU。Mac 继续其固定 CPU 设置。首次范围以已验证的 CUDA 路径为主，CPU fallback 仅在有独立验证和明确新运行记录后启用。

对于 RTX 5080，单独确认实际 CUDA kernel 能执行及包内 DLL 完整性。仅有 CUDA 工具链、`-h` 成功或驱动可见都不满足此项。

## 5 主项目接入设计

### 5.1 按引擎契约选择训练路径

Tauri 预检先取得完整性和实际引擎身份，再选择兼容路径：

| 引擎与平台 | 运行证据 | 命令与 live |
| --- | --- | --- |
| Windows Brush 0.3 | 现有 NVIDIA 驱动证据及旧契约 | 旧参数和旧 companion |
| Windows 配套 Brush 1.0 | Windows target、实际 WGPU 计算证据、冻结 profile | 1.0 参数、资源限制、主 CLI live |
| Mac 配套 Brush 1.0 | 原有 ARM64、Metal 计算证据和 Mac profile | 原有 CPU/Metal 路径 |
| stock 1.0 或未知版本 | 缺配套机器协议或身份不符 | 拒绝训练，显示配套引擎修复方法 |

平台识别不再直接等价为选择 0.3。可以增量添加 Windows WGPU 证据分支，保留现有 Metal 分支，待两平台稳定后再评估名称整理。

项目预检、任务启动和 Brush stage 使用同一套能力判断及同一份冻结运行配置。训练前发现身份变化，应结束本次启动，不自动混用新引擎。

### 5.2 ExecutionProfile 与 Schema

本轮选定使用已有字段及 `metorigin_1`、`dx12`、`vulkan`、`compute_smoke` 枚举，增加明确的 Windows 1.0 条件分支；设备身份优先使用现有 `probe_result.device_id`。Mac 和 Windows legacy 的原有约束保持。

Windows 1.0 执行就绪条件至少包括：x86_64、配套 1.0 身份、受支持的实际 Windows backend、成功计算证据、明确训练资源限制、LOD=0、协商后的 live 和 warm-start 能力。未知或失败的探测记录可用于诊断，不授权执行。

上述设计按 v1 的现有字段组合扩展，新应用继续读取原 Mac 和旧 Windows fixtures。当前旧 reader 会拒绝 Windows1 组合，即使它仍标记为 v1；部分打开/恢复入口会读取并校验该文件，因此不能承诺已安装的旧 Mac 二进制可直接打开这种新项目。新 Windows 项目的跨平台打开或继续运行要求具备新合同的对应平台应用，导出的标准 PLY 可作为独立交换产物。不能借 additive 扩展改变任何旧字段含义。

若设备身份或资源治理必须新增不可兼容字段/语义，W0/W2 应先明确 v2 契约和双读方案，再实现；Mac 继续原 v1 输出。不得仅全局修改版本常量。`project.json` v1 不因本次独立运行记录升级而改变。

新增 fixtures 包含 Windows1 正例、错误 target、Metal-on-Windows、缺计算证据、probe 与 profile 不一致、未知能力、非法预算和未来版本。Rust 校验与 JSON Schema 同步，未知/损坏 profile 保留原文件并拒绝覆盖。

### 5.3 训练参数、缓存和旧项目

已有 `to_cli_args_for_profile`、PLY 校验、训练指纹和主 CLI live 选择逻辑作为复用点。Windows1 必须走带 profile 的命令构造，不能掉回旧 `--total-steps` 分支。

运行记录保存请求预设与实际生效参数。引擎身份、后端、预算、数据集或 CLI 改变时，继续执行现有阶段失效与归档规则。当前旧项目没有 profile 时会保守地从 COLMAP 特征阶段失效；首轮保留这一安全行为，并在开始前说明重算范围。

旧 PLY 可继续查看。0.3 到 1.0 的 warm start 使用隔离副本验证后才能开放；不承诺优化器连续，也不静默降低 max_splats 导致模型降采样。检查点超预算时保留原文件并返回调整建议。

### 5.4 Windows 资源预算

新增 Windows 预算计算与观测，实现与 Mac 平台函数分开。独显预算基于实际训练 adapter 的可用预算/显存观测，图片缓存和加载线程基于系统 RAM 与 CPU；总显存仅是上限信息。

W1/W4 分别测量设备初始化、数据加载、训练、live readback、旧新模型替换和 SuperSplat 往返的峰值。根据结果冻结保守的 resolution、max_splats、image cache、线程与预览频率，记录参数表和测试环境，不在本方案中臆定适用于所有 16 GB GPU 的数值。

未取得显存动态预算时明确标记未知，使用经过测试的保守档位；不得把未知填写为 0 或等同于全部可用。首轮不由显卡名称自动宣称某质量档位可运行。

Windows 预览策略实现 allow、pause、release 与恢复防抖。压力过大先停止新快照和模型替换，必要时释放查看器资源；checkpoint 频率和有效恢复数据不受预览降频影响。运行中的训练参数不随压力静默变化。

### 5.5 窗口、退出与进程清理

为 Windows 关窗和应用退出接入共享的未保存编辑保护、任务停止/暂停、状态落盘与子进程清理。关闭请求处理期间防止重复退出和新任务进入；保护失败时保留窗口和可诊断错误，避免无提示终止。

Mac 关窗隐藏、Dock 再显示和 Cmd+Q 保持当前平台语义。Windows 使用自身进程树机制；不复制 Unix 信号或进程组实现。

验证正常退出、训练中退出、取消、超时、强制终止应用后重开、引擎仍占用项目时的锁保护和文件被占用时的保存失败。主动杀进程仅作用于测试中确认身份的应用/引擎。睡眠恢复需单独记录，不以模拟事件代替真实系统行为。

## 6 引擎目录、开发启动和安装包

### 6.1 包目录与来源记录

建议新 Windows 包布局如下，逻辑 `brush` 通过 manifest 指向 CLI：

    engines/
      engine-manifest.json
      ffmpeg/bin/ffmpeg.exe
      ffmpeg/bin/ffprobe.exe
      colmap/bin/colmap.exe
      brush/bin/brush-cli.exe
      BUILD-INFO.json

实际 COLMAP DLL、许可证及其他必要文件继续纳入包清单。新包采用独立 pack ID；旧包可保留为显式回退，不能在同一 pack ID 下替换版本和文件。

更新 Windows 锁、准备、验证和完整安装包脚本，去掉新路径对 `brush_app.exe` 和旧 companion 的强制依赖。manifest v1 已有逻辑 executable 映射，不需要为了改文件名扩大 schema。结构使用 `deny_unknown_fields`，新增 provenance 优先放独立构建记录；确需改 schema 时同步版本与读取器。

新包校验必须包括全部清单哈希、target、版本、DLL 闭包、Brush 能力协议和来源记录。哈希校验与 GPU 实测分别报告，不能互相替代。

### 6.2 开发模式定位

开发模式的目标顺序为：用户显式 `METORIGIN_ENGINE_DIR` → 用户保存的可执行文件/目录 → 已验证的资源包或当前平台 prepared pack → 兼容 `.engines` 目录 → 开发用 PATH fallback。

本轮在 Windows 分支中将自动发现与显式环境覆盖分开，自动目录不再写入最高优先级环境变量。Mac 的原有定位顺序和 `.engines` 入口保持；若提取共享函数，需以原用例证明 Mac 行为一致。Windows 新增 `target/distribution/windows-x64/engines` 自动候选，并支持从不同工作目录启动。

显式目录不存在、选中 pack 损坏、平台不符或版本不兼容时，返回准确错误；不得悄悄回退成另一套系统引擎。只要候选声明为受管包，就必须走 manifest 和全部文件校验，包含由显式目录选中的包；当前 debug 凑齐 exe 后提前返回的路径不能作为新受管包的完整性证明。散装高级配置可保留，但实际四个引擎必须形成通过版本与运行契约检查的组合，并显示其真实来源。测试覆盖“候选不存在可继续寻找”和“选中包损坏必须停止”的区别。

发布模式继续优先验证包内资源、忽略开发环境变量，并保持既有高级配置与损坏资源处理契约。发布应用不在启动时下载或编译引擎。

### 6.3 Windows 一键开发入口

新增命令建议命名为 `pnpm dev:windows`，对应 Windows 专用脚本。流程为：检查工具链 → 校验引擎缓存 → 缺失时准备 → 验证完整包 → 启动 Tauri。Tauri 继续启动唯一的 Vite 服务。

首次准备明确显示下载/构建阶段、缓存和输出位置。离线模式缺材料应直接报错；中断可复用已校验下载，未完成 staging 不被识别为可用包。准备与发布使用锁和独立 staging，避免两个终端互相清空产物；全部校验成功后再切换当前包。

后续启动复用匹配的包和完整性缓存。前端单独预览 `pnpm dev` 保持轻量；Mac 入口不引入 Windows 引擎准备。当前已有 `pnpm tauri dev` 在配套包准备后也应能自动发现它。

## 7 文件调整清单

下表中的新增路径为计划名称，实施时应保持职责对应并同步本表。

| 区域 | 主要调整 |
| --- | --- |
| 新增 `integrations/brush-windows/` | Windows 增量补丁、固定来源、补丁哈希、构建和机器协议说明 |
| 新增 `scripts/windows/Build-BrushRuntime.ps1` | 固定源码与补丁构建、依赖记录、目标和产物校验 |
| 新增 Windows 引擎契约测试工具 | capabilities、GPU probe、短训练、live、恢复和持久化故障验证 |
| `crates/splat-engine-brush/src/runtime.rs` | Windows 实测证据、target/backend 检查、probe 与训练身份一致 |
| `crates/splat-engine-brush/src/adapter.rs` | 传递已验证设备选择，复用新版参数和主 CLI live |
| `crates/splat-domain/src/runtime.rs`、`schemas/` | Windows1 条件约束及成功/失败 fixtures、兼容读取 |
| `crates/splat-pipeline/src/runtime.rs` | Windows profile 和资源策略；参数化身份收集，保留 Mac wrapper |
| Tauri `commands/runtime.rs`、项目/流水线入口 | 预检、启动和训练统一路由与 profile 传递 |
| COLMAP adapter/execution | 所有执行路径的 4.1 版本保护，Windows 显式 CUDA 配置 |
| `splat-hardware` locator、manifest | Windows CLI 发现、prepared pack、环境覆盖优先级及完整性 |
| Tauri `lib.rs`、`lifecycle.rs`、system/resources | Windows 退出接线和资源观测/预览策略 |
| Windows lock、prepare、verify、installer、`package.json` | 新包来源、文件映射、缓存、一键开发入口和安装验证 |
| `.github/workflows/`、测试 fixtures | Windows1、Windows legacy、Mac 三条自动契约与实机门槛 |
| README、development、engine integration、project format | 已实现命令、兼容边界、有效参数和故障恢复说明 |

## 8 阶段任务与依赖

所有任务初始均为未完成。阶段门槛通过后才能推进依赖它的集成或默认切换。接口定义和不依赖真实引擎的测试可并行编写，不能据此提前声明运行通过。

| ID | 阶段与任务 | 依赖 | 完成条件 |
| --- | --- | --- | --- |
| WIN-01 | W0 固定源码、补丁和 Mac 保护清单 | 无 | 基线可重建，输入哈希和已有工作区变更分开记录 |
| WIN-02 | W0 冻结 Windows 机器协议、后端选择和 profile/schema 决策 | WIN-01 | 输入输出、兼容边界、错误场景和 fixtures 明确 |
| WIN-03 | W0 固定许可明确的照片/视频/负例素材与证据格式 | WIN-01 | 素材身份、哈希、相机/帧策略可复现 |
| WIN-04 | W1 Windows Brush 增量补丁和构建脚本 | WIN-02 | 固定源码构建成功，版本、目标、依赖和哈希通过 |
| WIN-05 | W1 实际 backend/device 探测与训练绑定 | WIN-04 | DX12/Vulkan 分别记录结果，选定可支持组合，禁止静默切换 |
| WIN-06 | W1 短训练、checkpoint、live 和 warm start | WIN-03、WIN-05 | 有效 PLY、迭代、请求/ACK和恢复均有真实证据 |
| WIN-07 | W1 Windows 文件占用、失败、取消与进程测试 | WIN-04 | 旧有效产物保留，异常不伪装成功，测试进程清理完成 |
| WIN-08 | W1 COLMAP 4.1 CUDA 验证和 4.3 拒绝门禁 | WIN-03 | 目标 GPU SfM 通过，拒绝错误版本不改变旧库 |
| WIN-09 | W2 Windows1 Rust 与 Schema 契约 | WIN-02 | 新正反例通过，旧 Mac/Windows fixtures 行为保持 |
| WIN-10 | W2 Windows profile、身份和预算接口 | WIN-09 | 预设和有效参数分离，Mac profile 输出回归一致 |
| WIN-11 | W2 预检、启动、stage 与主 CLI live 接通 | WIN-06、WIN-07、WIN-08、WIN-10 | 实际应用走新版命令，探测与训练引擎/设备一致 |
| WIN-12 | W2 旧项目、缓存失效与跨版本恢复保护 | WIN-11 | 旧项目可读，未知版本不覆盖，原结果可恢复 |
| WIN-13 | W3 新 Windows 包锁、清单、DLL 与来源记录 | WIN-06、WIN-07、WIN-08 | 完整包可独立验证，旧包身份不被复用 |
| WIN-14 | W3 定位优先级、prepared pack 和损坏资源拒绝 | WIN-13 | 多入口定位正确，界面配置不再被自动 env 遮挡 |
| WIN-15 | W3 一键开发、离线/中断恢复和并发准备 | WIN-14 | 首次与缓存启动通过，只有一个 Vite，无半包暴露 |
| WIN-16 | W4 Windows 预算测量和预览压力策略 | WIN-11 | 冻结首轮参数，压力下降后可恢复，无持续新帧积压 |
| WIN-17 | W4 关窗、退出、取消、超时和异常重开 | WIN-11 | 状态、项目锁、编辑保护和进程树行为符合契约 |
| WIN-18 | W5 汇总三条契约的 CI 和脚本测试 | WIN-12、WIN-15、WIN-16、WIN-17 | 测试随开发持续补充；完成时 Windows1/legacy/Mac、Schema、打包和定位检查全部通过 |
| WIN-19 | W5 Windows 照片/视频端到端及原生 UI | WIN-18 | 生成、live、查看、编辑、导出、恢复和退出逐项通过 |
| WIN-20 | W5 Mac 共享变更回归 | WIN-18、共享代码冻结 | 原配置、真实生成、live、编辑保存和退出无新增退化 |
| WIN-21 | W6 完整 Windows 安装与离线重定位 | WIN-13、WIN-19 | 脱离源码和开发 PATH 运行，包内依赖完整 |
| WIN-22 | W6 文档、默认切换和回退演练 | WIN-20、WIN-21 | 新 Windows 路径成为默认，旧包/项目副本回退可复现 |

推荐依赖顺序为 W0 → W1 → W2/W3 → W4 → W5 → W6。W1 的独立引擎验证优先，避免先改应用后才发现 GPU 或引擎文件操作不成立。

建议按上述职责拆分提交：基线与引擎；契约与应用；包与启动；资源与生命周期；回归与默认切换。每组提交均有本层验证和 Mac 影响说明。

## 9 验证矩阵和完成标准

### 9.1 自动测试

| 类别 | 必测边界 |
| --- | --- |
| 机器协议 | 错 target/backend、缺功能、失败/未知 probe、身份和哈希变化、不同 adapter |
| 参数 | 0.3 与 1.0 argv 分离、显式默认值、中文/空格路径、资源值边界、LOD=0 |
| 持久化 | 重复替换、占用目标、无写权限、部分输出、取消、失败保留旧文件 |
| Live | 同 session 正例、旧 session、过期请求、重复 ACK、关闭预览、进程结束 |
| 项目恢复 | 无 profile、原 Mac v1、Windows legacy、Windows1、未来/损坏记录、跨引擎变更 |
| 定位与打包 | 包内/显式/设置/prepared/兼容目录、不同 cwd、缺包、坏哈希、错平台、DLL缺失 |
| Mac 保护 | 原 profile/参数/预算结果、原补丁哈希、Mac脚本测试、原拒绝条件 |

使用现有 lint、typecheck、frontend tests/build、Rust fmt/Clippy/workspace tests、Schema fixtures 和 Windows/Mac Tauri 构建作为基础。已有 Spark/Three 生命周期、SuperSplat bridge/packaging 测试继续执行。新增测试覆盖协议与行为，不以文件名字符串检查代替执行验证。

### 9.2 Windows 实机

首轮使用许可明确的中小型照片集和有旋转信息的视频，固定素材哈希、参数、驱动、引擎版本和二进制身份。先独立 CLI，再应用全流程；两个层次分别保存结果。

| 数据集 | 首轮规模与用途 |
| --- | --- |
| 合成计算 probe | 8 高斯、32×32，验证实际 forward/backward |
| 固定规范化训练数据 | 约 40–80 张许可明确的图像；先 300 步 smoke，再 3,000 步训练，隔离 SfM 差异 |
| 原始照片与手机视频 | 照片同源素材；视频约 20–40 秒，显式约束抽帧到 100–150 帧，覆盖原始输入全流程 |
| 混合尺寸与 EXIF | 约 40 张受控图片，覆盖相机分组、方向和去畸变 |
| 中型场景 | 约 300 张图片，用于较长训练、显存/RAM 和 live 并发测量 |
| 负例与恢复副本 | 低纹理、低重叠、损坏输入及多检查点副本，原数据保持独立 |

规模是测试设计目标；W0 固定实际素材和参数后按该记录执行。Mac 已有素材只有在使用许可明确且本机可取得、哈希相符时复用。

必须覆盖：

1. 新照片、新视频、混合尺寸/EXIF、中文及空格路径。
2. 低纹理、低重叠、错误引擎、不可写目录和资源不足的可诊断失败。
3. 完整迭代、有效最终 PLY、结果清单与实际文件一致。
4. 实时更新、关闭/重开预览、切换项目、最终模型接替 live。
5. 暂停/恢复、显式检查点恢复、取消、训练中退出和异常重开。
6. Spark 与 SuperSplat 往返、编辑保存、未保存离开、PNG/JPEG/WebP 导出及取消。
7. 带真实模型重复至少六轮查看器往返，按相同状态和静置窗口比较 CPU/GPU 内存，记录清理后保留趋势。轮次通过本身不等于内存稳定。
8. 完整安装包在受限 PATH、移动安装/资源位置、离线环境中的启动与生成；干净机依赖检查单独记录。

首轮后端选择依据实际 compute probe、短训练、完整训练和稳定性，不以性能单项决定。跨 CLI/应用结果比较 schema、相机/尺度、有效 Gaussian 属性和固定视角；相同 GPU 数值训练不要求跨运行字节相同。质量与性能阈值在 W0 选定基线后、候选测量前记录，避免看结果再移动标准。

### 9.3 Mac 回归门槛

现有 Mac CI 和脚本测试必须保持通过。针对共享代码修改，在原有 Mac 验证环境使用相同引擎包和隔离项目副本，复测照片、视频、live、warm start、编辑/图像保存与正常退出，并核对原始项目和引擎未变化。

资源回归采用同状态、同素材、同轮次对照；保留文档中的既有增长发现，判断是否出现新增退化。不能把本轮 Windows 工作写成已经关闭原有 M3/M4 问题。

若 Mac 真机暂不可用，可完成 Windows 开发与自动测试，但 W5 的 Mac 原生项保持未完成，不能声明全方案完成或把新版切为已验收默认。

### 9.4 证据和状态

证据写入被 Git 忽略的专用目录，包含源码/补丁/引擎身份、命令参数、设备和驱动、输入哈希、输出校验、耗时、内存观察、退出与残留进程情况。源码中的验收摘要只记录必要环境和可复核结论，不提交私有素材、绝对个人路径和未脱敏日志。

每项验收记录通过、失败或未测；构建、单元测试、实际计算、原生交互和安装包分别报告。证据绑定实际候选，后续变更按受影响范围复测。

## 10 回退和风险处理

| 风险 | 处理与回退 |
| --- | --- |
| Windows 后端可初始化但训练失败 | 保留失败记录，显式换已测试后端重新 probe；未通过前不设默认 |
| 新 CLI 与探测设备不一致 | 启动失败并保留项目；修复选择传递后新建运行记录 |
| COLMAP 4.3 被误选 | 执行前版本拒绝，旧库不打开；切回配套 4.1 |
| 文件占用或替换失败 | 保留旧完整 checkpoint/输出，返回错误，重试需验证当前状态 |
| 旧 0.3 项目恢复不兼容 | 保留旧引擎和原项目副本，允许查看旧 PLY；新版重新训练或经验证 warm start |
| 新包准备中断 | 使用独立 staging，继续使用上一完整包，清理仅限本脚本已验证范围 |
| Mac 共享行为退化 | 回退相应共享改动，Windows 保持候选；Mac 原引擎和原产物可继续使用 |
| 无目标环境验收 | 明确保留未测项，限制支持范围和默认切换，不从其他平台推定通过 |

引擎回退以完整 pack ID 和对应应用构建为单位。新引擎已产生的训练尝试不能通过只替换 exe 假装旧引擎可继续；先恢复原项目副本或既有归档，再使用匹配的引擎。任何回退都保留原始素材和最后有效输出。

## 11 项目约束检查

本方案遵循 [constitution 1.1.0](../.specify/memory/constitution.md)：

| 约束 | 本方案落实方式 |
| --- | --- |
| 现有分层 | Tauri 编排能力、domain 定义契约、adapter 生成命令、统一 runner 执行 |
| 向后兼容 | 保留原项目和 profile 读取、旧 Windows 路径、版本化新语义与显式回退 |
| 行为测试 | 适配器、持久化、Schema、原生 GPU 和双平台回归分别设门槛 |
| 安全持久化 | 项目锁、临时文件、校验、原子替换、缓存失效与归档继续生效 |
| 可诊断错误 | 使用现有 AppError 模型；缺组件、错版本、GPU失败和资源不足分别反馈 |
| 本地数据保护 | 私有素材、引擎二进制、构建缓存和未脱敏证据不进入源码 |

本方案不增加云服务、遥测或新的项目数据库。新增原生依赖和任何持久化契约变化，在相应任务中记录设计理由、许可证、迁移与回退测试。

## 12 关键依据

- [macOS 高斯生成实施方案](macos-gaussian-generation-plan.zh-CN.md)：固定源码、双 CLI、旧 Windows 兼容边界与未关闭验收项。
- [Brush Mac 集成](../integrations/brush-macos/README.md)、[冻结补丁准备器](../scripts/macos/prepare-brush-source.py)：公共集成和精确补丁来源。
- [引擎接入](engine-integration.md)、[运行记录与项目格式](project-format.md)、[训练来源校验](validation/training-provenance.md)。
- [Windows 引擎锁](../packaging/windows-x64/engine-lock.json)、[Windows 打包](../packaging/windows-x64/README.md)、[Mac 固定 COLMAP 构建](../scripts/macos/build-colmap.sh)。
- [固定 Brush fork](https://github.com/MinKaiZhi/brush/tree/1388f74c6fe0236f68ee4915564bf00e9d2e3747)、[固定 COLMAP 4.1](https://github.com/colmap/colmap/tree/fa8e3b3ff591552855f8ad2806723c80f963f69c)。
- [锁定 CubeCL 自动后端选择](https://github.com/tracel-ai/cubecl/blob/467522442c7b68f02c7ff0c84b2e249e36d8da91/crates/cubecl-wgpu/src/graphics.rs)、[Rust 文件重命名语义](https://doc.rust-lang.org/std/fs/fn.rename.html)、[NVIDIA Blackwell 兼容指南](https://docs.nvidia.com/cuda/blackwell-compatibility-guide/index.html)。
