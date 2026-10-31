# Windows 对齐实施记录

初始记录：2026-10-30；更新：2026-10-31（Asia/Shanghai）。分支：`codex/windows-gaussian-alignment`。应用基线：`69a699044b498ef0f3748807571ed13b7fdbd042`。

本记录区分代码实现、自动测试和原生验收。目标仍为进行中；Windows1 保持候选，不提前切换发布默认。实施依据为[实施方案](../windows-gaussian-alignment-plan.zh-CN.md)。

普通安装启动缺陷已另行修复：新 877 输入候选的 Windows1 无需 backend/device 环境变量即可在原生向导完成真实 DX12 计算预检，「继续」可用。新应用 NSS 身份为 `57e582…a989`，详细边界见下文普通启动补验及[原生UI记录](windows-native-ui.md)。历史 `5386…` 启动依赖外部配置，不能继承本次结果。

随后已修复Windows预设被测试限额覆盖的问题。当前交付为879输入 `5283428e` 候选、NSS `320f8d50…f7505`：高质量保持30000步／SH2／2560px上限，原生预检与确认页一致。公开TUM已完成真实30000步生产运行，原harness后置尺寸断言失败与独立有效产物复核分开保留；详见下文预设质量修复，不能将用户工程的漂浮伪影或编辑器取景写成已修复。

## W0 输入与保护边界

开始前已有修改是方案、`docs/README.md` 索引和 `integrations/supersplat/LICENSE`；保留许可证修改，不将其视为本轮实现。未另建分支或 worktree。未发现适用的 `AGENTS.md`；遵守 constitution 1.1.0。

83 个 Mac 构建、打包、许可证政策、来源和配置输入的字节哈希固定在 `integrations/brush-windows/macos-protection.json`，通过 `python scripts/windows/Test-MacosProtection.py` 检查。原 Mac `.6` 补丁、Rust 1.95 配方和包身份不变。共享 Rust 行为由现有和新增测试保护；这些哈希不能证明 Mac 真机回归。

Windows Brush 使用同一 `1388f74c6fe0236f68ee4915564bf00e9d2e3747` 基线，先应用原 Mac `.6`，再应用 Windows 增量。兄弟仓库 main 不修改。COLMAP 固定 4.1；不能让本地 4.3 打开项目库。

## 冻结的候选接口

Windows1 沿用 execution-profile v1 已有枚举组合，Mac 和 Windows legacy 的意义及原有 fixtures 保留。旧应用 reader 可能拒绝新的 Windows1 组合；跨平台项目打开需使用理解此组合的新应用，标准 PLY 可独立交换。未知/未来 profile 拒绝并保留原文件。

Windows1 普通启动默认选择已验证的 DX12；用户无需设置环境变量或执行脚本。`METORIGIN_BRUSH_BACKEND=dx12|vulkan` 及设备 ID 仅保留为高级覆盖，无效覆盖返回独立的配置错误。应用仍向 Brush probe 和训练传递显式 backend，训练必须传 probe 返回的 `--graphics-device`，失败不会静默换后端。设备 ID 是 backend、vendor/device 数字和 adapter 名字的规范编码；重复且无法区分的 ID 拒绝执行。能力必须包含 `backend_device_selection`。probe 必须完成 8 高斯、32×32 forward/backward，不能以创建 device 或 NVIDIA 驱动检测代替。此默认后端修复不将候选引擎包切为正式发行默认；下述历史 `5386…` 构建仍要求外部启动配置，结果按原身份保留。

Windows 质量参数修复后，普通执行保留用户预设的迭代、SH和请求分辨率：快速3000／SH0／1280px，均衡7000／SH1／1920px，高质量30000／SH2／2560px；低分辨率素材不被上采样。旧 `5386…`、`57e582…` 及下文历史验收仍绑定当时3000／960px的限制，不能继承修复后的质量参数结果。短跑验收仅在独立测试入口显式覆盖并记录，不再改写生产预设。

资源配置与预设质量分开：最多300000高斯、256MiB图像缓存、两个线程、LOD=0仍显式记录；这些值不是16GB通用承诺。v1中的 `4 GiB` 保留为规划参考，既不是实测可用显存，也不是操作系统或WGPU强制分配上限。实际adapter动态可用预算仍未知，字段保持 `None`，不写0、不使用系统RAM或NVIDIA总显存冒充它。未知不等于预设已获内存可行性证明；已知资源检查不通过时拒绝，不降低迭代、SH或分辨率。已有中型核心运行及 `7348…` 应用六轮往返的离散资源观测不证明无泄漏，也不替代真实内存压力和睡眠恢复验收。Mac资源函数及Metal/CPU校验保持原语义。

## 素材与预先冻结的验收条件

复用已有 `scripts/macos/prepare-smoke-fixture.py` 的固定素材选择：James/Robson 火山弹 sample，Figshare article 9120020 v1，file 16636739，CC0-1.0；原归档 611535084 bytes，SHA-256 `b0d0995be5652d453fdb0d809a364ccd4a8a5040cae35fb6e748f0ff1783d2d1`。选 `IMG_1928.jpg`–`IMG_1967.jpg` 40 张，不改源文件，提取器记录每张 CRC 和 SHA-256。新下载必须通过全归档校验后才授权真实验收。

真实照片先固定顺序、相机策略和 960 px、SH0、300000 max_splats、LOD0 的 300 步 smoke；之后独立输出 3000 步训练。SfM 注册率至少 80%，模型/相机参数有限，checkpoint/final PLY 完整、Gaussian 属性有限、输入哈希未变；live 和 checkpoint 必须来自同一次训练同一迭代。不同 GPU 运行不要求字节一致。性能仅记录冷/热启动 wall time、RSS 和显存峰值，不事后设定成功阈值。

图片序列合成视频不能充当实拍视频验收。TUM 真实视频已固定并完成核心流水线测试；原 AVI 没有手机旋转元数据。另以该实际捕获视频作无重编码 stream-copy，加入受控 90° display-matrix 元数据，验证生产探测、方向归一化、独立像素 oracle 和完整重建；它覆盖真实旋转元数据处理，但不是新采集的手机视频。中型 307 帧、混合尺寸/EXIF、低纹理、低重叠和损坏输入的分项核心验收已通过，详见核心流水线记录。`7348…` 已有六轮原生查看器/编辑器往返证据；最终 `5386…` 重定位应用另完成真实TUM视频41帧的原生完整生成及强制退出后重开继续，两个应用身份的结果分别保留。所有故障和派生素材都使用隔离副本，原文件保留。

证据放入 Git 忽略的 `target/windows-alignment-evidence/` 及各引擎专用 target 目录。每次记录源码/补丁/二进制哈希、工具链、backend/device/驱动、输入清单、结构化 argv、开始结束、状态、输出验证、残留进程与取消结果。原生未测必须写“未测”，不得写“通过”。不提交原素材、二进制和完整本机路径日志。

## 任务状态

以下逐项状态是当前证据快照。“已实现”只说明代码具备相应路径；自动测试、真实 CLI/核心流水线、Tauri 原生交互和安装验收分别列出。进行中的采样、编译日志及既有历史结果不会自动成为当前候选的通过结论。

| 任务 | 实现 | 自动验证 | 原生/真实引擎验收 |
| --- | --- | --- | --- |
| WIN-01 | 已固定基线和 Mac 保护清单 | 83 个哈希通过 | 不适用 |
| WIN-02 | 已冻结 Windows backend/device 机器协议及 v1 Windows1 组合 | Rust/Schema 正反例、旧 Mac/legacy 契约通过 | DX12/Vulkan 实际 probe 与绑定训练通过；发布默认未切换 |
| WIN-03 | 固定 CC0 照片、CC-BY 真实视频与阈值；受控 EXIF/旋转/负例派生器已加入 | 原归档、源哈希、方向1–8和独立像素 oracle 通过 | 照片、实际视频、中型307帧、混合40和受控90°实际视频完整核心链通过；非新采集手机视频 |
| WIN-04 | Windows 增量补丁、隔离构建、DXC 和来源锁已实现 | 固定源码 release 构建、14 文件闭包、9 项构建/缓存测试通过 | 最终 Brush 实际启动通过；完整依赖/DXC 分发审查未完成 |
| WIN-05 | probe 与训练共用显式 backend/device 选择；无静默后端切换 | 错设备、重复身份、target/证据拒绝及绑定测试通过 | DX12/Vulkan 各 300 步、DX12 3000 步通过；只覆盖当前测试机 |
| WIN-06 | 主 CLI checkpoint/live、请求 ACK、模型 warm start 已接通 | 协议、有效 PLY、预算拒绝、线程/参数与恢复测试通过 | 两后端 CLI 短训练和 DX12 长训练通过；照片/视频核心恢复通过 |
| WIN-07 | NTFS 失败保护、取消及 Windows Job Object 已实现 | 部分写、读者占用、替换、原子记录与进程清理测试通过 | 真实目录 DACL 拒写保留旧 PLY；CLI 强制停止/恢复、最终 `5386…` 原生应用强制退出后的已知Job引擎清理与重开继续通过 |
| WIN-08 | 所有 COLMAP 路径有 4.1 门禁；CUDA 特征/匹配、CPU GP/BA 明确冻结 | 错版本拒绝、旧数据库字节不变测试通过 | RTX 5080 上实际 CUDA SfM 通过；无 CUDA GP 成功的声明 |
| WIN-09 | Windows1 Rust/Schema 条件分支与兼容读取已实现 | 29 个 Schema 正反例及 Rust 原 Mac/legacy/future fixtures 通过 | 新 Windows1 profile 已用于真实核心运行 |
| WIN-10 | Windows profile、分平台身份和候选资源策略已实现 | Windows 边界、Mac wrapper 拒绝跨 target、原预算/身份测试通过 | 核心运行记录保存请求与有效参数；动态 adapter 预算仍未知 |
| WIN-11 | 统一预检、启动、stage 复测与主 CLI live 已实现 | 路由、版本、能力、参数、身份变化和 stage 契约通过 | 核心照片/视频通过；`7348…` 原生照片十二阶段及正常关窗后继续通过；最终 `5386…` 重定位原生视频41/41、十二阶段通过 |
| WIN-12 | 旧 profile 保留、缓存失效、归档及显式恢复保护已实现 | 无 profile、Mac/legacy、损坏/未来记录、设备变更和归档保护通过 | Windows1 取消/恢复/检查点/缓存通过；`5386…` 强制退出后从1000继续到3000、优化器重置；legacy新attempt与独立旧PLY warm start分开，不宣称0.3→1连续优化器恢复 |
| WIN-13 | 独立候选锁、manifest、DLL 与来源记录已实现 | 16 项包/来源/身份/安装保护测试及完整哈希、版本/协议通过 | 完整包离线准备、实际版本启动及来源独立复核通过；分发许可门槛仍未通过 |
| WIN-14 | Windows prepared pack、显式设置优先级、损坏包拒绝已实现 | 显式 env/目录、缺清单、完整 exe 组合、发布优先级及旧 Mac 定位回归通过 | 最终安装/中文空格重定位资源和静态运行通过；`5386…` 以受限PATH、无效开发提示完成原生视频生成，机器网络仍开启 |
| WIN-15 | `dev:windows` 和缓存/离线入口已实现 | `-Offline -CheckOnly`、缓存复用、中断/并发及无半包暴露测试通过 | 实际专用入口启动 Tauri、唯一 Vite 监听、prepared pack 定位及正常关窗后两者退出均通过 |
| WIN-16 | Windows 系统 RAM 预览压力策略及三次健康观测恢复防抖已实现 | allow/pause/release、未知观测、在途帧拒绝及 Mac 单次恢复兼容通过 | 中型307帧、`7348…` 六轮离散资源采样，以及最终 `5386…` 两个独立session的预览off停发布/on恢复新帧已有记录；不证明无泄漏或动态预算，真实压力/睡眠待验收 |
| WIN-17 | Windows 安全退出接线、禁止新任务及 Job Object 后代所有权已实现 | 44 项进程测试、6 项生命周期测试；晚到编辑会话、最终保存失败/重试和项目锁保护通过 | `7348…` 正常关窗暂停/解锁/重开及未保存保护通过；`5386…` 强制退出重开继续、直接UI暂停/继续通过；直接取消按钮数次遭遇完成后的过期确认，未验收为成功，真实睡眠保留待验收 |
| WIN-18 | CI 加入 Windows1/legacy/Mac 契约、Schema 和 Windows 脚本/来源清单检查 | 历史724/442及启动修复733保留；质量参数修复后742 Rust通过/22忽略、450前端、Clippy/fmt、Schema29、包16及Mac83通过；原失败日志保留 | Mac CI/原生门槛未验证，不能标全矩阵通过 |
| WIN-19 | 共用生成、预览、编辑/导出及恢复入口已接入 | 核心照片/视频及既有查看器/桥接测试有分层结果 | `7348…` 照片137369点、六轮、编辑保存和三格式导出/取消通过；`5386…` 视频34472点、强杀恢复32545点，另中型副本直接暂停/继续及预览off/on通过；直接取消与live跨项目仍未完成原生验收 |
| WIN-20 | Mac 配方冻结、共享兼容保护已实现 | 83 个输入、原 profile/参数/预算拒绝条件已有自动证据；Mac CI 待验收 | 未取得 macOS 真机回归，未完成；不关闭历史 M3/M4 未通过项 |
| WIN-21 | 独立候选 portable/NSIS 构建及来源冻结路径已实现 | 最终874来源/451工具前后不变、16测试、12产物校验和NSIS CRC通过；历史portable来源边界保留 | 最终安装exit0、158资源闭合、重定位原生视频完整生成及强制退出重开恢复通过；网络开启，clean VM/完整断网依赖门槛未验收 |
| WIN-22 | 文档、候选标识及完整旧包/匹配应用/项目副本边界已更新；默认未切换 | 原旧包来源与缓存校验通过，生产迁移和独立warm start分开记录 | 匹配旧核心/旧包回退及独立旧GUI查看、只读编辑器往返、正常退出通过，原scene/checkpoint保持；WIN-20/21和默认切换门槛保留 |

素材、CLI、核心流水线、包、原生交互及迁移回退的详细记录分别见 [Brush 集成](../../integrations/brush-windows/README.md)、[COLMAP 验证](windows-colmap.md)、[核心流水线](windows-core-pipeline.md)、[候选包验证](windows-engine-pack.md)、[原生 UI 验证](windows-native-ui.md)及[legacy 迁移与回退](windows-legacy-migration.md)。

## 已取得的证据

- Mac 83 个冻结输入不仅与工作区哈希一致，也与 `69a6990` 的 Git blob 字节一致，避免 Windows 换行转换造成跨平台假失败。原 `.6` 哈希不变。
- 公共真实视频已取得：[TUM RGB-D desk](https://cvg.cit.tum.de/data/datasets/rgbd-dataset/download)，[CC BY 4.0 许可](https://cvg.cit.tum.de/data/datasets/rgbd-dataset#license)，作者 Sturm、Engelhard、Endres、Burgard、Cremers（IROS 2012）。完整公开 RGB AVI 为 6,141,142 bytes，SHA-256 `3faa0fa667fa95d28ecf0d231c3383ddef8695f391f07d48f484af39de43a854`。相机轨迹与素材锁见 `test-fixtures/windows-alignment/sources.json`。这是实际采集的视频，不是照片序列合成视频；它不覆盖手机旋转元数据。
- Windows COLMAP 4.1 官方 CUDA 归档哈希通过，特征提取/匹配确实使用 GPU。首轮发现请求 CUDA GP 后 Ceres 无 CUDA/cuDSS 而回退；保留原失败适配证据。第二轮明确 GP=CPU、BA=Ceres CPU，40/40 注册、36,515 点、平均重投影误差 0.514089 px，源照片未变。详见 [COLMAP 验证](windows-colmap.md)，本机证据 `target/windows-colmap/smoke-cuda-cpu-gp-02/evidence.json`。
- 最终 Brush 版本 `1.0.0+metorigin-windows.1`，二进制 SHA-256 `4398eeabd0cc4becaf5d82fb81b76dfd377b791b7bd7251b0e2b7ca8fe7e4001`。DX12/Vulkan 各 300 步、DX12 3000 步 CLI 契约通过，含计算 probe、设备绑定、warm start、live 请求/ACK、过期请求、失败保留和强制终止恢复。DX12 曾因 FXC 缺 subgroup 失败，最终候选固定 DXC DLL 并在计算前拒绝缺 subgroup 的设备；不能把“设备创建成功”写成支持。
- 独立引擎的 29 个原生 Rust 测试和 Clippy 通过；Windows 构建缓存/源状态测试 9 项通过。完整来源、14 文件产物闭包、两个补丁的应用顺序和 DXC 原始许可见 `integrations/brush-windows/README.md`。DXC/完整依赖的分发审查仍是门槛。
- 最终 Brush 真实目录 DACL 故障测试通过：独立确认禁止创建文件后，实际引擎导出退出 1，旧的 36515 高斯 PLY 仍完整且字节不变；原 DACL/owner/group 在 `finally` 中恢复并验证写权限，所有受管测试子进程退出。本机证据 `target/windows-brush/acl-3f8eed12-900d-4850-8e0d-822476ebc68d/evidence.json`。
- Windows Job Object 在孩子首次执行前建立所有权，取消、超时及正常 leader 先退出都验证后代已停止；强制结束应用测试同时覆盖异步引擎和同步 probe，并证明无关进程继续运行。44 项进程测试通过。新增最终退出门禁/锁中毒测试后，6 项生命周期测试及 desktop Clippy 通过；晚到编辑会话和最终保存失败/重试也有现有回归覆盖。这些进程/状态测试不替代真实编辑器和关窗交互。
- 生产核心流水线以真实引擎完成原始照片和实采视频重建：James40 注册 40/40，最终 81228 高斯，消费 314 个有效 live 帧；TUM 实测 20.433333 秒视频抽取 102 帧、注册 102/102，最终 85558 高斯，消费 264 个有效 live 帧。两者均验证取消后的检查点保留、模型 warm start、显式检查点恢复、最终产物和缓存复用，源哈希未变。详见 [核心流水线记录](windows-core-pipeline.md)，不将其记为 Tauri 原生 UI 通过。
- 候选包通过离线准备、完整 manifest/哈希、实际版本/机器协议及中文/空格路径重定位后的受限 PATH 校验。最终 NSIS 固定 874 项源码/资源/配置和 451 项独立 bundler 输入，构建前后均未变；16 项包/来源/身份/原生安装保护测试通过，12 个产物文件校验和闭合、NSIS 声明长度和 CRC32 `b4871712` 通过。安装器 SHA-256 为 `66123ce212ca58a0932d1a1500a490c39da042800a4fa8563eca2b74d396b382`。详见 [候选包记录](windows-engine-pack.md)。
- 最终 NSIS 实际安装至新的中文/空格目录，保留进程句柄观察退出码 **0**；实际应用 SHA 为 `53865e80ce7a026fab30da0ce2a4199e809c9a71e97c6882c402c545147dc594`，精确符合原始 EXE 经 Tauri `UNK→NSS` 标记转换的预期载荷。158 个实际引擎/许可证资源及文件集合均与冻结清单一致，candidate 专属卸载注册指向新目录；旧 `7348…` 应用和正式应用 KnownFolder 设置/最近项目保持不变。安装与完整重定位副本各五条实际版本/静态能力命令在 system-only PATH 下通过。这些静态命令未运行 GPU，网络也未禁用，不能替代 clean VM 或安装后完整原生离线生成。证据见 `target/windows-install-validation/final-install.json`、`final-relocation-integrity.json` 及 `final-{installed,relocated}-runtime-system-path.json`。
- 独立只读复核重新采样 874 项源码/资源/配置、451 项工具、生成的 NSIS 输入、12 个产物和 158 个实际安装资源，所有 SHA 及实际安装身份一致；历史遗漏的 71 个仓库直接输入、四个主题字体输入和新增 helper 均已纳入。receipt 为 `target/windows-alignment-evidence/final-874-independent-review.json`，摘要为 `9d247ca8d264bfc3262533bbe657c0c906952ce184b851d7d044edfed5f3d7e3`。
- 随后实际运行 `pnpm dev:windows -Backend dx12 -Offline`，由 Tauri 的 `beforeDevCommand` 启动唯一 Vite 进程及 1420 监听；原生应用设置页显示 prepared alignment pack 中的 FFmpeg 8.1.2 vendor token、COLMAP 4.1.0 和 Brush Windows1，均为已验证。正常窗口关闭后，开发应用和监听均退出。开发 exe SHA-256 为 `bb769894ad6d45a35722a1025ade94587f6a0c754a2a8243604a3aac302c7c21`；过程遇到测试/hook 文件变更的正常热重启，Vite 始终只有一个。证据为 `target/windows-alignment-evidence/dev-launch-native-evidence.json` 和相邻日志；此开发构建不冒充最终强来源 release。早期仅设置 APPDATA/LOCALAPPDATA 不能证明 Tauri KnownFolder 配置目录隔离，开发验收未打开或编辑项目；最终安装验收以独立 candidate identifier、实际 KnownFolder 清单和正式配置前后哈希为边界，WebView 使用显式测试数据目录。
- 早期 `f0891a…` 应用在原生界面打开完整 81,228 高斯模型，并在独立中文/空格路径项目副本中进入 SuperSplat、将平移 X 改为 0.05；窗口关闭显示未保存保护，选择继续编辑后内容保留，保存后模型仍有限且点数不变，返回查看器并正常退出。副本结果 SHA-256 为 `5e7e6f34813e3debce6e710bf7dd8bfae9e381485c10d6baba1e9278cdb3bfc8`，原验收模型哈希未变。证据为 `target/windows-native-ui/edited-model-evidence.json`。该结果只绑定早期 exe，不替代最终来源绑定候选的六轮往返、导出和异常恢复验收。
- 实际安装的 `7348bb36d1a792249faf60e5916478e360a943573d75b2cb4779974d9ccc5407` 通过原生向导新建 James40 项目。重建运行中正常关窗后，项目/mapping 为 paused、锁释放，已知应用/引擎后代退出；重新打开并继续后，40/40 注册、3000 步、十二阶段完成，产物为 137369 个有限 Gaussian，生成 scene SHA 为 `ce675cf4f54135569c3346cd4b46e49693a11c7357e02dfde2780488ce676a56`，六个 checkpoint 完整。它使用安装资源和受限 PATH，已有机器 WebView2/运行库仍在，不是 clean VM 验收。
- 同一 `7348…` 实例完成六轮查看器/编辑器往返，十二份 UIA 均为137369点；离散 RSS/private、per-PID/LUID GPU counter 和全局 NVIDIA 观测分别记录。进程身份稳定，返回 viewer 后 GPU counter 降低，但采样时点、加载早期样本和 CPU 编译并发均保留，不作无泄漏或动态可分配预算结论。模型被只读共享句柄占用时，实际保存失败且旧模型完整；关窗的未保存保护可选择继续编辑，释放句柄后重试保存成功，仍为137369点且全部数值有限。错误中出现的内部异常名及 OS 文本如实保留，未修饰为理想文案。
- 同一已保存的 `7348…` 编辑模型实际导出 PNG、JPEG、WebP，独立全量解码均为1800×1415且图像非恒定；PNG/WebP具有alpha，JPEG为RGB、无alpha，质量90仅记录实际请求，不从元数据反推。PNG/WebP不声称逐像素完全一致。随后实际取消系统保存流程，没有新增第四份文件，已有导出、模型、原图与raw副本哈希保持。上述原生生成、六轮、受阻保存/重试与导出证据详见 [Windows 原生 UI 验证](windows-native-ui.md)，仅绑定 `7348…`，不改记为最终 `5386…` 通过。
- 最终 `5386…` 应用连同完整资源重定位至中文/空格目录后，通过原生向导完成真实TUM desk视频生成。原生fast本轮自动选择2 fps、41帧，区别于核心harness的5 fps/102帧；实际41/41注册、1833稀疏点、重投影误差0.794784 px，3000步初次生成34472个有限Gaussian，scene与checkpoint3000同SHA `b97184c897b4ff693cbf0589cc3b3bb0e5fda71c33bb231ff368d90a98820455`，六个checkpoint完整、十二阶段完成、无锁。源视频/项目副本、重定位四引擎、DX12 probe/device及训练日志经独立核对；启动PATH只有系统目录、开发引擎提示无效，机器网络保持开启，不记为断网验收。receipt为 `target/windows-native-final/final-video-completed-independent-validation.json`；同名“running”资源样本实际在完成之后，不记为训练/live峰值。
- 同一最终视频项目实际显式恢复500后，第二轮 `crash-final-02` 在新鲜完整checkpoint1000出现时，仅通过持有的进程句柄强制结束精确应用PID26152；已知Job引擎退出，完整checkpoint/模型保全。强杀后的磁盘仍为running/BrushTraining并留锁，未手改状态；新实例PID49060原生打开后自动reconcile为paused，显示1000步/4366点并点击继续。最终达到3000步/32545点、全部十二阶段完成、六个完整有限checkpoint且无锁；scene与checkpoint3000同SHA `532e33b12a45163373268eef5317e888a3463635347bb56799f02f8c8e5cb562`，`resumed_from_iteration=1000`、`optimizer_state_restored=false`。这是PLY几何warm start，未恢复优化器。首轮helper在kill前序列化失败、生产训练未被终止的记录保留，不冒充强杀通过；即时仍有旧WebView后代，后续按PID/创建身份确认旧进程消失，不宣称瞬间全部退出。真实项目归档、保全副本、500/1000 checkpoint及原/复制源均保持；详见 [原生UI记录](windows-native-ui.md) 和 `target/windows-native-final/final-video-post-crash-resume-independent-validation.json`。
- 最终 `5386…` 又在307帧中型场景的精确副本上直接通过任务暂停和继续：同期59个样本为paused、session停止、锁释放，四个合法检查点保留；从2000继续到3000完成133607点。另两个独立session分别证明预览off时停止发布、下一session由off恢复live后出现新revision，完成模型接替live。恢复试验最后完成145461点；多次直接取消确认晚于训练Done，保护拒绝，没有把UI滞后或“正在执行”画面算为取消成功。跨项目live往返也未形成有效通过记录。详见 [原生UI记录](windows-native-ui.md)；所有补充只操作隔离副本。
- legacy 真实旧包和匹配基线核心完成独立 James40 项目，再逐文件保全三份项目副本。当前生产核心在唯一迁移副本上归档六个旧 checkpoint、result记录与fingerprint；未额外归档名为scene.ply的旧输出，旧scene字节由相同final checkpoint及保留副本保全。新 Windows1 attempt 确实从第0步开始：3000步、89009点，`resumed_from_iteration=0`、`optimizer_state_restored=false`。独立旧 PLY warm start 从1000至1100步、12719→13782点，明确重置优化器；超点数限制和有init却请求fresh的负例分别拒绝，生产迁移结果保持不变。匹配旧核心与完整旧包在回退副本上实际重验媒体、复用其余11个计算阶段缓存，旧scene/六个checkpoint及保留副本保持。随后使用原935输入、57前端产物，仅覆盖三个应用名称/identifier字段构建独立 `111a1c…` Legacy Validation：原生viewer、SuperSplat只读往返均显示原21788点模型，正常关窗后精确应用身份和专属WebView匹配均退出。47项源/scene/checkpoint、原始与保留项目各210文件、935/57输入保持；正式KnownFolder的两份基准文件保持absent，独立legacy最近项目目录已实际观察。详见 [legacy 迁移与回退](windows-legacy-migration.md) 及 `legacy-native-final-verification.json`；旧编辑修改/保存仍未测，不从只读往返推定。
- 主应用已记录 Node 26.0.0 / pnpm 11.12.0 的 lint、typecheck、构建和 441 个前端测试；execution-profile 29 个 Schema 正反例通过。Rust 全工作区在当时源码通过 711 项自动测试。后续共享修改有单独回归结果，包括 Mac wrapper 拒绝跨 target、Windows 定位、27 项预览测试（含恢复防抖）、6 项资源策略测试和上述生命周期/进程测试。分阶段总数不代表随后源码已自动继承全套通过；最终门禁仍须绑定冻结源码汇总。真实引擎测试保持默认忽略并单独记录。
- 最终候选源码冻结后，`cargo test --workspace --locked` 汇总 724 通过、0 失败、20 忽略（含显式调用的真实引擎和进程助手入口）；fmt、全部 target/feature 的 Clippy（warnings denied）、lint、typecheck、Schema29及 Mac83 哈希通过。前端初次与安装压缩并发运行时，已有 HomePage 55项目列表用例触发5秒超时，441通过/1超时；保持用例和阈值不变，以 `vitest run --maxWorkers=2 --minWorkers=2` 重跑全部442项通过。两份日志均保留，不隐藏初次超时。证据为 `target/windows-alignment-evidence/*source-bound*`；这不将符号链接或真实 Mac 环境限制变成已通过。
- Windows Tauri `build --debug --no-bundle`、历史 portable release 和最终强来源 NSIS 均已构建成功；不同应用身份的原生结果按下节分别保留。最终 `5386…` 重定位应用已有原生视频完整生成、显式检查点恢复、实际强制退出、重开reconcile与继续生成的分项证据；匹配旧GUI只读回退也已单独验证。真实睡眠和内存压力仍未验收。
- 现有 Spark/Three 测试 99/103 通过，4 项因本机不允许创建符号链接而失败。SuperSplat 包/来源测试在原生权限下 65/72 通过，7 项同因符号链接 `EPERM`；bridge 3 项通过。未改变这些安全测试以隐藏环境失败。Mac 脚本在 Windows 下含 Unix shell/路径相关失败，因此 Mac CI 与原生检查仍未验收。

物理内存实测为 33,752,997,888 bytes；GPU 为 RTX 5080 Laptop、驱动 592.01、16,303 MiB 总显存。后者仅是观测信息，不代表所选 WGPU adapter 的动态可分配预算。

## 候选与来源证据边界

Brush 最终二进制与源码、按序应用的两个补丁、Cargo.lock、Rust 1.95.0、目标、DXC DLL/原始许可及 14 个文件的完整哈希相绑定；其记录与独立候选 pack 校验是两层证据。Windows Brush 使用 DX12/Vulkan WGPU；COLMAP 的 CUDA 证据不能充当 Brush 后端证据。

各次应用按精确二进制身份保留来源与原生证据，不用相近文件名或同一 HEAD 互相继承：

| 应用身份 | 来源范围 | 已有原生证据 |
| --- | --- | --- |
| 早期 `f0891a…` portable | 只有 HEAD/dirty 与二进制/引擎哈希，不能唯一绑定未提交应用源码 | 早期查看/编辑/未保存保护/保存/正常退出，保持历史范围 |
| 历史安装 `7348…`，原始 EXE `07d66…` | 797项来源清单，审查发现71个仓库直接输入及4个主题字体输入遗漏；间接锁定不等于完整直接收录 | 本记录照片137369点、运行中正常关窗后继续、六轮、受阻保存/重试、PNG/JPEG/WebP与取消 |
| 最终安装/重定位 `5386…`，原始 EXE `d64d74…` | 874项来源/资源/配置及451项工具，构建前后校验和独立复核通过 | 安装、重定位TUM视频41/41与初次34472点完整生成；实际强制退出后重开从1000继续至3000、32545点；六轮编辑/导出仍归7348 |
| 普通启动修复候选 NSS `57e582…`，原始 EXE `632129…` | 新877项来源及451项工具，构建前后不变；新stamp不覆盖874历史包 | 独立复制NSS载荷及159项资源，未设backend/device变量的TUM新建预检通过、GPU计算就绪及继续可用；本轮未安装或完整训练 |
| 最终预设修复候选 NSS `320f8d50…` | 879项来源摘要e8f7…及451项工具构建前后不变；86fb→528仅一个测试harness输入变化 | 新NSS实际高质量预检与确认均30000／SH2／2560；公开TUM生产30k完成独立产物复核，原harness退出101保留；未实际安装 |

最终来源摘要为 `08eb5d854019def159a3988aa3b48c353405b8b4ac873cc05b78fa46f9b52ee0`，bundler 摘要为 `f125b697dc4b07df950ae05b8e6c068bdf411a05a2ae9e7fed84a605aefbc463`。Tauri 2.11.4 在 NSIS 打包中临时将唯一 `UNK` 标记改成 `NSS`，之后恢复原始 EXE；来源输出的raw哈希、预期载荷哈希和实际安装观测分开记录。新旧NSS应用另有24字节PE时间戳/RSDS GUID差异的结构化证明，仍保留不同二进制验收身份。历史缺项与失败记录未被重标或删除。

收尾阶段再次执行来源清单 `verify`，874项仍为上述摘要、状态为 `unchanged`；随后独立重读最终目录的12项产物，全部与 `SHA256SUMS.txt` 匹配，记录为 `target/windows-alignment-evidence/final-artifact-closeout-verification.json`。之后的补充工作只操作 ignored 测试副本、证据及验收文档，没有重新编译或修改候选源码/载荷。

最终正常关窗后，独立原生CIM确认最后应用PID48332、专属WebView及测试路径引擎无残留；正式KnownFolder的settings/recent仍保持基准absent。原中型1015文件和原视频224文件及目录集合逐哈希未变，已保存照片模型 `8deb…59cef` 保持。中型副本145461点scene与六个检查点完整有限、无锁，五份真实恢复归档中的29份PLY全部有限且既有归档文件不变。证据为 `target/windows-native-final/controls-final-closeout-independent-validation.json`。三个观察器分段由 `ui-controls-observers-final-index.json` 索引；第二段缺少自写summary，退出时刻/原因未观测，不补造“正常结束”，第三段按专用stop正常退出。单项目采样不用于推定跨项目UI通过。

中型运行已取得完整 `acceptance-evidence.json`，307/307 注册、最终135837高斯；续跑393个资源样本中 Brush RSS峰值570855424字节、private峰值848265216字节，平均采样间隔1.85秒，短启动峰值可能漏采。原中断及14:37:29Z附近旧查看器恢复/保存的并发区间保留。全局 NVIDIA 显存包含其他上下文，不归因于 Brush；查看器重叠与采样中断单独标注。用户确认目前无 Mac，优先完成 Windows；WIN-20 保持未完成，WIN-22 不切为已验收默认。

真实内存压力和系统睡眠/唤醒仍未验收；用户已明确将睡眠唤醒保留待验收，不再询问或主动执行。最终 `5386…` 视频和强制退出恢复、匹配旧GUI只读回退已有各自独立证据，不能替代压力或睡眠结果。clean VM/完整断网依赖和公开分发许可证审查也仍未验收；用户当前暂时无Mac只是验收顺序调整，不免除WIN-20，不授权WIN-22切默认。补充的直接UI暂停/继续与独立session预览off/on已有证据；直接取消按钮和训练live期间跨项目往返仍未取得有效原生通过记录，完成后的过期确认只证明安全拒绝，不能记为取消成功。

## 普通启动修复与补验

历史 `5386…` 在没有 backend 覆盖时，会在真实计算 probe 前以E-5004拒绝预检，随后被桌面层泛化为GPU不可用。用户安装后直接运行应当可用，要求用户执行启动脚本不是正确产品流程。本次将 Windows1 缺省后端设为DX12，环境变量只保留为高级覆盖；无效覆盖返回E-5005，真实计算和设备绑定仍是强制门禁。桌面失败诊断保留技术原因，UI使用分阶段的安全中文与错误码。

新源码全工作区原生测试733通过、0失败、21忽略，包含新增3个配置边界与6个诊断测试。初次沙盒运行有两个既有项目锁进程身份测试失败，保留 `target/windows-startup-fix/workspace-tests.log`；同源码在原生权限下全部通过，日志为 `workspace-tests-native.log`，没有更改实现或放宽断言。引擎107个测试、相关Clippy、fmt、包16项和Mac83哈希均通过。独立代码复核及新877来源桥接保存在 `independent-code-review.json`。

真实无覆盖函数验收为 `target/windows-default-runtime-validation/20261030T182534683Z-c96e32b1/`，随后新的 `57e582…` NSS载荷在原生窗口完成同样普通启动预检。两次均实际返回DX12和同一规范RTX5080设备，8高斯、32×32 forward/backward有限且梯度为正。原生界面GPU项就绪，「继续」可用；没有创建项目或训练，不把它写成新版完整生成或实际安装通过。测试应用已正常关闭，用户原有PID4976及 `5386…` 安装文件保持原身份。详细证据见 `target/windows-startup-fix/native-default-launch-b0a9edf1/` 和[原生UI记录](windows-native-ui.md)。本次不重标旧照片／视频验收，也不改变Mac、睡眠、clean VM及分发审查待验状态。

修复安装包已生成于 `artifacts/windows/alignment-candidate/0.1.0-internal.windows-alignment.1/20261030T182838204Z-b0a9edf1/`。安装器447,730,786字节，SHA-256 `daeb24969beb4cf4783296973a327bd3e18510d077278eefefc69de1e77443ab`；12项产物校验和、NSIS声明长度和CRC32 `ad80233a`通过。来源877项摘要 `af1adea96d6651c689c16ea7f2b85fe290f393be4be162038f8d786dd13bf158` 与451项bundler摘要 `f125b697dc4b07df950ae05b8e6c068bdf411a05a2ae9e7fed84a605aefbc463` 构建前后不变。构建后raw EXE为 `632129dba13f1fd10fb8a6f97b22028e82433f9469f3d5be1ba2db275cc2df0d`；按唯一3字节Tauri标记推导的NSS载荷精确等于已执行原生普通预检的 `57e582…`。这不是新版实际安装的观测；为保留用户当前窗口，本轮没有覆盖D盘安装、修改安装注册表或关闭该实例。旧874包及其证据保持原样。

## 预设质量参数修复

用户的无人机工程选择quality，但历史 `57e582…` 将其覆盖为3000步／SH1／960px；这并非显存不足检测后的自动降级，也不是训练提前中断。Windows1现已移除固定迭代、SH和分辨率上限，保留预设请求；测试harness中的短跑覆盖仍显式单独记录。资源缓存、max_splats及线程设置与画质参数分开，未知动态预算仍为未知，不从一次小素材成功推出2560px场景通用可行性。

桌面预检新增所检查的 `preset` 标识。前端的选中卡片、参数详情及确认页共用结构化 `effective_training`；未选卡明确标成预设请求。预检缺失、返回预设不符或正在切换时，不显示旧实际参数／GPU就绪，前进和创建均禁用。Mac的受限实际值会与原请求明确并列，其执行策略未改。新建、启动和恢复仍各自执行真实计算与设备绑定，不能因UI显示参数而绕过运行门禁。

旧项目每次启动重新冻结profile。新的effective参数触发训练准备及训练指纹失效，旧3000步完成记录不会被当作30000步完成；仅打开工程不会自动训练或改写模型。另修复FrameExtraction缓存只用旧计划自验证的问题：视频按当前有效FPS、数量、尺寸、滤镜、旋转及输出模式比较；图片按当前选样、尺寸、相机映射及有效重建长边比较。同一有效抽帧计划及仅训练分辨率变化仍可复用重建帧；不把这个改动写成新增源字节身份校验。

本轮前端450项通过，Windows三个预设到真实Brush参数的生产构建路径、6项抽帧stage及4项下游持久失效测试通过，fmt／Clippy／Schema29／包16／Mac83通过。首次完整原生工作区739通过、0失败、22忽略；日志 `target/windows-preset-fix/workspace-tests-native.log` 保留。后续只修正一个验收测试文件，不重复未改变的生产训练。

验收断言修正后最终原生工作区742通过、0失败、22忽略，32组结果，日志为 `workspace-tests-corrected-validator-native.log`，SHA `c95cd6cd2224665394a5373a3e6c988c4b8ab4509f892de64598a1b68c5c1bf3`。这不是重新执行并通过那个真实30000步ignored test；新增三项是尺寸验证的非GPU回归。

公开TUM视频在全新 `target/windows-quality-validation/20261030T193912130Z-4e7597a3/` 工程以普通quality参数完成全部12阶段；82/82注册，固定引擎4398、默认DX12、无backend/device覆盖。训练实际30000步、SH2、最大长边2560px，result与完成指纹一致；最终scene与checkpoint30000均为300000个完整有限SH2高斯，同SHA `2bd14634097639cc6836584b5736e39eef44cea1ddc903d821340d9a257eb5a9`。素材为640×480，去畸变后82张训练图为622×466，与实际相机模型一一匹配，不是2560px像素负载或视觉质量指标的验收。

新增harness的首轮后置断言错误地要求去畸变图仍为640×480，在生产流水线完成后退出101。原脚本失败、原 `quality-acceptance-evidence.json` 的 `running` 状态及其SHA全部保留，不能将该ignored test改记为通过。独立只读复核检查304个工程文件、相机维度、PLY所有标量、完成manifest、两个生产指纹及11项源／4引擎／原与复制视频前后哈希，确认生产结果有效；记录为 `target/windows-preset-fix/independent-quality-output-review.json`，摘要 `f4bf013fec09f3d0c5b5c8c95d65eb2d6e805b3c928e733b0c692bd1f796bd2b`。随后测试改为正尺寸且不放大，并保留相机尺寸强校验；3项非GPU回归覆盖正常裁边、原尺寸及零尺寸／放大拒绝。未来harness在pipeline成功后先记录 `validating_outputs`，避免断言失败被误看作仍在训练。

新879来源候选 `86fb1737` 的NSS `80dbb96f…93a1f` 已在独立目录核对159资源并执行原生向导：快速实际3000／SH0／1280，高质量预检及确认均为实际30000／SH2／2560，未点击创建。测试应用PID34584已正常关闭；用户PID49052及原安装 `57e582…` 保持，原无人机scene在19:48:33Z仍为 `ce3f7fdfc3bf6e4dbca1e2d156d19ff02aed795b9e315254b2e40a6102f1f03b`。原生证据与独立复核见 `target/windows-preset-fix/native-quality-launch-86fb1737/`、`independent-native-ui-review.json`。这次没有修复该无人机模型的漂浮伪影或编辑器取景，不把公开数据参数链路成功记成用户工程视觉效果已修复。

修正harness后最终候选为 `artifacts/windows/alignment-candidate/0.1.0-internal.windows-alignment.1/20261030T195903345Z-5283428e/`。安装器447733683字节，SHA `9841982eb474f15e880d67e38e0dfbee4eefd5e4febb66175895c6009ea39dd7`；12产物校验和、NSIS长度及CRC32 `1d1f00bd`通过。879来源摘要 `e8f7b57c8b428b5bc9eb148f0312098d75c215c07c354518617c880da6597e13`、451工具摘要 `f125b697dc4b07df950ae05b8e6c068bdf411a05a2ae9e7fed84a605aefbc463` 前后不变。与86fb比较仅测试harness一项来源变化，其余878项、57份前端产物和451工具相同；EXE仍因24字节PE元数据不同保留新身份。

最终NSS `320f8d50f701b06c944cd122fa59f30503d07aebbfd512e9c582271e722f7505` 已独立重新执行原生高质量预检与确认，均显示实际30000／SH2／2560；不是沿用旧80db的UI标签。最终159资源全量核验，PID12680正常关闭且20:07:35Z无相关残留，用户原安装及无人机scene仍保持上述身份。新原生证据及独立复核为 `native-quality-launch-5283428e/`、`independent-final-native-ui-review.json`。打包闭合见 `harness-corrected-pack-closeout.json`；根代理另重读12产物并桥接742／450、最终source／NSS／UI及真实30k独立产物／原harness失败边界，记录 `target/windows-preset-fix/final-closeout.json`。未实际安装新NSIS，不改变Mac、真实睡眠、clean VM或公开分发许可门槛。

## 回退与项目约束

引擎回退以完整 pack ID、对应应用和原项目副本为单位，不能仅替换 exe。新版训练与旧版优化器不连续；超预算 checkpoint 保留并报错。Mac 原引擎和配方保持可用。遵守既有分层、原子持久化、AppError 和本地数据保护；本轮不增加云服务、遥测或项目数据库。
