# GPU 后端可靠性：M1 Pro 本机验收结果

本轮要求的 **M1 Pro / Metal GPU 验收链路 PASS**：候选构建、真实预检、3000 步训练、暂停/继续、明确 checkpoint 恢复、取消清理、原生编辑保存、导出、正常关闭/重开、两种诊断导出和隔离原生载荷均已实际完成。原用户状态已恢复。独立离线 Metal Toolchain 检查为 **FAIL（非本轮运行依赖）**；macOS 15、干净机器安装等未执行项保持 **NOT RUN**。下方原 GPU 验收记录截至 14:01；用户后续授权的 **Developer ID 签名、公证、DMG 票据与 Gatekeeper 校验已通过**，完整补充记录见文末。本结果不代表公开发布批准。

本报告的源码 HEAD、工作区状态及安装哈希均对应各阶段实际采集时间；后续仅整理并提交验收文档，不改变受测二进制身份。`artifacts/` 与 `.cache/` 下的 DMG、模型、原始日志和校验材料保留在执行机器，受 Git 忽略规则保护，未随本次文档提交入库；以下证据链接在该本机 checkout 中可用。

## 原 GPU 验收：身份与保护范围（截至 14:01）

- 仓库：<https://github.com/metorigin/MetOrigin-Splat>
- 分支：`codex/gpu-backend-resilience`
- 验收时实际 Git HEAD、远端 HEAD：`2121f91aa268aa1b4dd0db7fd7ef0f751bd5e857`
- 要求提交 `2121f91aa268aa1b4dd0db7fd7ef0f751bd5e857` 和实现基准 `908863b4db00b22d8245eb37576aef71ede0ee40` 的 ancestry 检查均退出 0。
- 日期：2026-11-10，时区 Asia/Shanghai（UTC+08:00）。开始阶段已保存身份记录时间为 **13:04:07**；核心测试开始 **13:10:36**、**13:18:53** 完成；原生重开渲染 **13:53:17**；项目诊断导出 **13:54:07**；**13:56** 正常退出并恢复原用户状态；**14:01** 完成最终证据复核并结束本轮验收，精确复核时间见 `E/final-review.json`。
- 原 checkout 为干净的 `main`，HEAD `fc7493afa87e463832e2f12b8c8dda81cab32d96`。受保护 fetch/switch/ff-only 后运行，没有 stash、reset、clean；未覆盖本地修改。
- 已检查仓库祖先目录、当前源码树及独立 Brush 树，没有适用的 `AGENTS.md`。已阅读本分支交接文档。
- 应用生产源码未修改。核心 receipt 的 tracked diff 为空、SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，未跟踪源码清单为空。本结果文档在核心测试后新增，不冒充原有验收输入。
- 新 fixture、Brush 源码/构建、pack、GUI 测试项目和隔离 `.app` 在 `.cache/metorigin/gpu-resilience/20261110-m1-pro/`；证据及核心 runner 发布的独立测试项目在 `artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/`（下称 **E**）。没有替换 `/Applications/MetOrigin Splat.app`。
- GUI 使用独立测试状态：原 Application Support、Caches、WebKit 目录先完整保存并记录逐文件哈希；隔离窗口初始显示 0 个本地项目。候选退出后，三目录已恢复，所有原文件 SHA-256 一致；测试状态完整保留于 `E/gui/test-state-{0,1,2}/`。原有项目未被打开或训练。

来源与保护证据：[source-provenance.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/source-provenance.json)、[identity.txt](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/identity.txt)、[GUI 隔离记录](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/isolation.json)、[原安装快照](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/isolated-payload/installed-app-before.json)。旧构建文件另保存在 `E/preserved-build/`。

## 硬件、版本和完整哈希

实际机器为 **MacBook Pro / MacBookPro18,3 / Apple M1 Pro**，10 核 CPU、16 核 GPU、**32 GiB 统一内存**；原生 `Darwin arm64`，macOS **27.0.1 (26A434)**，Metal 4。证据：[hardware.txt](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/hardware.txt)。本结果不是 macOS 15 实机验收；15.0 仅为构建部署下限。

| 工具/组件 | 本机实际版本 |
| --- | --- |
| Node / pnpm | 26.13.0 / 11.12.0 |
| Python | 3.9.6 |
| 应用 Rust | rustc 1.97.0 (`2d8144b78 2026-07-07`) |
| 独立 Brush Rust | rustc 1.95.0 (`59807616e 2026-04-14`)；cargo 1.95.0 (`f2d3ce0bd 2026-03-21`) |
| Xcode / macOS SDK | 27.2 (`27B52`) / 27.2 |
| 应用 | 0.1.0，`com.metorigin.splat`，arm64 |
| Brush | `1.0.0+metorigin-macos.6`；候选 profile `metorigin-macos.6-resilience`；含 `probe_diagnostics_v1` |
| COLMAP | 4.1.0，commit `fa8e3b3ff591552855f8ad2806723c80f963f69c`，CPU，无 CUDA |
| FFmpeg / FFprobe | 8.1.2 / 8.1.2 |

Rust 不在默认 PATH，但已安装于用户 `.rustup/toolchains/`；实际脚本使用进程级 `RUSTUP_TOOLCHAIN` 和显式 Cargo 缓存，没有修改共享 toolchain 文件。完整工具调用和退出码见 [machine-inventory.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/machine-inventory.json)。

| 对象 | SHA-256 |
| --- | --- |
| Brush 原始构建 `brush-cli`（核心测试） | `957e6972a5c55ef0b8cc700b5a3f05ec0307dffb2f249fb4e11012ed8be60651` |
| Brush 重定位/签名后 `brush`（pack 与 GUI） | `c603392865c52d5761c8af341e3cfaed39c062f2ba221f0c35313da9415f2590` |
| `.6-resilience` 累积补丁 | `7e9e81cc0203b61ffb0f606a81a4c84816fbed5179c1a14f0870a8ca1fd5007b` |
| 候选 Brush Cargo.lock | `cfd832e2208962070263cb4f17a3ad4ebba6b18d9bec3a80a5a9f4dfcfac4d7b` |
| COLMAP 开发引擎（核心测试） | `23fbd89c03f8972396748d558c552fc84fdfe915bd92009465417c686a70c6ee` |
| COLMAP 包内引擎（GUI） | `bfd28a4abfc6aad219fbe73e0cc065277604cfa5bdfe68d762c14164478c5443` |
| FFmpeg 开发引擎 / FFprobe 开发引擎 | `b6ca65238b5a4ce39650087cc471885534b8fb61ebba309c9fe748bbe4fb6f40` / `11c61497f8d8cc6294b7e87941f4e28dec6c17a28e4e996b13a1cf5014e963b6` |
| FFmpeg 包内引擎 / FFprobe 包内引擎 | `254cf3ef679ff627d027ef4537d3c8c9663c1764338b7ac64679c5f4b647e723` / `75fb210106cbd57d05a63a8c16c4fab25ed115beaa0fda0cb6fe179145b13f2b` |
| 新 `.app` 主 Mach-O | `69670884a84d80d8df97e80d407a818082cb8fffc272ab5f13ebab7fea0d2a9a` |
| 新 engine-manifest.json | `aa8386696f4a27a2e8e540cea8b7509c1342e7c26b952eabe4b997e92de664b7` |
| 隔离 `.app` bundle inventory | `aba62a7806d70358dd72e4cb84b1ce6155677b4fceb9b4c6284cb4f5769450ef` |
| release-status.json | `30803390e9bd1adbe6ed26faedb3df80683baaf02df15bd001229fe43c6bd775` |
| app-licenses/manifest.json | `917558d2fba429f00915f8083c0dd3712f8b58deea7de68a4139787d7670547b` |

Brush 独立源码 detached 于 `1388f74c6fe0236f68ee4915564bf00e9d2e3747`，补丁、二进制、Cargo.lock 与 build-info 相符。未叠加 Windows 补丁，未改写 build-info 中 `metal_training_validated=false`；实际本轮训练由独立 receipt 证明。原始和包内哈希不同是重定位/签名所致，保留了 `original-build-info.json` 与 `relocation-map.json` 追溯链。

证据：[Brush 构建核对](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/brush-build-verification.json)、[pack identities](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/packaging-inputs/pack-identities.json)、[隔离候选 identities 与动态库清单](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/isolated-payload/candidate-identities.json)。

## 原 GPU 验收逐项结果（截至 14:01）

`PASS` 表示该行范围实际完成；`FAIL` 表示该检查实际失败；`NOT RUN` 表示未完成执行或缺少最终证据。核心 API 测试和原生 GUI 操作分开记录。

| 验收项 | 状态 | 实际结果、证据或未完成原因 |
| --- | --- | --- |
| Git 分支、完整 HEAD、提交祖先与本地保护 | PASS | 目标/远端 HEAD 一致；起始干净；`E/source-provenance.json`。 |
| 本机 M1 Pro / arm64 身份 | PASS | M1 Pro、32 GiB、macOS 27.0.1；`E/hardware.txt`。 |
| Metal 诊断候选构建与来源校验 | PASS | Rust 1.95.0 原生构建退出 0；新增诊断能力；`E/build-brush.log`、`brush-build-verification.json`。 |
| 固定 James40 原图 | PASS | 全归档及 40 张照片校验通过；`E/fixture/`。 |
| Python 构建/补丁回归 | PASS | 24 tests，0 failure；`E/python-tests.log`。 |
| Rust 三 crate 单元回归 | PASS | 295 passed（116+158+21），0 failed，2 ignored；`E/rust-tests.log`。ignored 项不算执行。 |
| 生产核心真实 Metal 预检 | PASS | 实际 Apple M1 Pro / Metal compute smoke；`E/core/current/receipt.json`。 |
| 生产十二阶段、3000 步训练 | PASS | James40 40/40 注册；CPU COLMAP、Metal 3000 步、SH0、960px；同上。 |
| 核心 checkpoint 及显式恢复 | PASS | 从 500 恢复至 3000；旧完成结果归档保留；PLY warm start，优化器不恢复。 |
| 核心保存、模型校验、导出 | PASS | 完整 PLY 检查，92,527 Gaussians、5,182,015 字节；不是 GUI 编辑保存。 |
| 核心项目重开、缓存重开、重导出 | PASS | profile 保持 Metal；缓存重开明确跳过训练；重导出完整哈希一致。 |
| 损坏 Mach-O 被生产预检阻止 | PASS | 测试副本拒绝执行，E-5004；未进入流水线，无遗留测试进程；`E/negative/reviewed-results.json`。 |
| 无效 capabilities JSON 被阻止 | PASS | parser 返回 E-5004；未进入流水线，无遗留测试进程；同上。 |
| 新引擎 pack、重定位、动态依赖 | PASS | 3,100 files、123 Mach-O，全部 arm64，重定位执行通过；`E/packaging-inputs/verify-pack-relocate.log`。 |
| 本分支原生 `.app` 构建 | PASS | internal-alpha / app-only 退出 0；`E/app-build.log`。 |
| 隔离复制载荷完整性 | PASS | 同机实体复制；签名、主程序、完整 engine 文件与 manifest/来源一致；`E/isolated-payload/verified-isolated-app.json`。 |
| 原生窗口身份、设置页后端语义 | PASS | PID 23600 对应隔离 `.app`；只显示 Metal，无 Auto/DX12/Vulkan；版本检查与计算检查明确分开。 |
| 原生向导真实预检 | PASS | 40 张有效原图；显示 Apple M1 Pro / Metal Gaussian 渲染与反向传播通过；`E/gui/observations.md` 与诊断包。 |
| 无项目首次预检日志导出 | PASS | 在创建项目之前由原生设置导出 ZIP；7 entries、CRC 完整、首次 probe 日志齐全；`E/gui/diagnostics-no-project/inspection.json`。 |
| 原生向导训练至目标、实时预览 | PASS | 原生 3000 步、SH0、1280px 完成；暂停后从500续训；140,211 Gaussians。实时石块模型实际可见；`E/gui/monitor/first-completion/receipt.json`。 |
| 原生训练完成后切换最终模型 | PASS | 初次窗口被遮挡时保留旧帧；Raise 后最终渲染更新为13:35:25、警告消失，138,688点模型实际可见；重开后13:53:17再次渲染。保留初始观察，详见下文及 `E/gui/viewer-investigation/outcome-after-raise.json`。 |
| 原生正常暂停并继续 | PASS | 原生暂停保留500；PID24609退出。继续时PID24698从500→3000，真实重检，冻结API/设备/参数一致；仅run_id变化。`E/gui/monitor/`。 |
| 原生明确选择 checkpoint 恢复 | PASS | 原生选择2500→恢复→确认，旧完整结果与3000 checkpoint已归档；再次继续至3000完成，Metal与冻结参数保持。`E/gui/monitor/explicit-restore-2500-receipt.json`、`final-training/receipt.json`。 |
| 原生编辑器可识别修改并保存 | PASS | SuperSplat位置X由0改为0.05，显示“模型已保存”；138,688个顶点实际持久化平移，完整数值校验通过。`E/gui/edit-save/persistence-summary.json`、`vertex-correspondence.json`。 |
| 原生模型导出 | PASS | File→Export→PLY；7,766,890字节，与保存后的scene逐字节一致。`E/gui/editor-export.json`。 |
| 正常关闭、重新打开并显示已编辑模型 | PASS | Cmd-Q后原PID23600退出，新PID26326来自相同隔离app；项目中心重开后完整模型可见，保存模型及冻结profile哈希均未变。`E/gui/reopen.json`。 |
| 有项目诊断包导出与脱敏核查 | PASS | 原生导出29条目ZIP，CRC全通过，6次真实计算日志与包内Brush匹配；用户名及用户绝对根已脱敏。`E/gui/diagnostics-project/inspection.json`。 |
| 取消后子进程退出 | PASS | 原生取消2500恢复训练，PID25039已退出，5个有效checkpoint保留；`E/gui/monitor/cancelled-restored-run/`。 |
| 原用户状态恢复与原安装最终复核 | PASS | 三个原用户目录逐文件哈希一致；原安装已记录的5项身份/manifest/主程序哈希未变，旧冻结pack manifest未变。候选及本次子进程均退出。`E/gui/isolation.json`、`final-process-check.json`、`E/isolated-payload/preservation-after-gui.json`。 |
| 独立 Xcode MetalToolchain 可执行性 | FAIL | `xcrun metal --version` 报缺少 Metal Toolchain。此工具未被本次成功的 Rust/运行时 Metal 路径需要，不构成此次训练失败。 |
| macOS 15 实机 / 干净机器安装 / Developer ID 公证（原 GPU 阶段） | NOT RUN | 本机 macOS 27.0.1；截至 14:01 仅内部候选与同机隔离复制。后续授权的公证结果见文末补充验收；macOS 15 和干净机器安装仍未执行。 |
| 独立拍摄视频输入 / 其他 Mac 或 GPU | NOT RUN | 本轮使用固定James40照片，仅验收这台M1 Pro；照片流水线的帧阶段不算独立视频验收。 |

## 核心实际运行细节

固定照片来源为 James/Robson CC0 数据集，重新下载 <https://ndownloader.figshare.com/files/16636739>，没有使用历史训练产物或合成图片。完整归档 **611,535,084 字节**，MD5 `a62826fd45a89551a548897cf6b62b01`，SHA-256 `b0d0995be5652d453fdb0d809a364ccd4a8a5040cae35fb6e748f0ff1783d2d1`。`whole_archive_verification=passed`；40 张原图逐项 CRC、大小、SHA-256 与仓库 manifest 匹配。测试前后原图哈希不变。

核心 runner 的 [receipt.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/core/current/receipt.json) 为 `PASS`，进程退出 0，无证据发布错误。runner SHA-256 为 `c0fa60a862987361418e2f68d8c27fc70fac33ae13cd523a62415583df8f38a4`。实际生产流程包括媒体验证、帧提取阶段、预处理、COLMAP 特征/匹配/建图/验证、训练准备、Brush 训练、模型验证、导出和预览 manifest；照片路径不会伪装成独立拍摄视频输入。

冻结配置：3000 步、SH0、960px、max_splats=300000、4 线程、image cache=256 MiB、Metal。40/40 图像注册。完整运行含恢复约 **485.78 秒**（Rust 测试总耗时 491.55 秒）。从中间 checkpoint **500** 重新计算至 **3000**，保存的 profile 保持 Metal；`optimizer_state_restored=false` 是 PLY warm start 的真实语义，不是优化器 checkpoint 恢复。

最终模型为 **92,527** Gaussians，**5,182,015** 字节；完整模型与重开后再次导出的 SHA-256 均为 `8e756e52a821b376ab3c4cfd7b84d08ea35edce9bacccc31f8e811b416b39159`。旧完成输出归档存在，项目重新打开成功；随后缓存重开跳过 Brush，不计为又一次 GPU 计算。底层项目与日志保存在 `E/core/current/debug/projects/M1 照片 中文 空格/`，摘要见 [core/summary.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/core/summary.json)。

原始 receipt 的 `native_ui_verified=false`、`installer_verified=false` 保持不变，其范围只是生产 Rust 核心。GUI 新测试项目 `M1 Pro 原生验收 20261110` 位于独立 `gui-projects/`，默认快速预设 **1280px** 与核心显式 **960px** 不同，须单独评估。

## 原生预检与无项目诊断导出

原生操作通过 macOS UI/accessibility 完成，没有浏览器 mock、脚本注入或直接代调应用命令。界面观察记录见 [gui/observations.md](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/observations.md)，对应原生截图保存在本次 Codex 对话工具记录中。

创建项目之前，于 13:18 进行 James40 真实预检；随后 13:19 在设置→诊断→导出脱敏诊断包。ZIP：`diagnostics-20261110-051948-01a1c3e5-ef06-7c02-aac4-fe9b29fe8902.zip`，4,857 字节，SHA-256 `b2a2b8faeae539fc08119b06cf2a2fdf5fa6a293557c3f36a93e87631113af1f`。原包原样复制至 `E/gui/diagnostics-no-project/`；7 个条目 CRC 全部通过，没有项目内容。

包中首次 05:18:34Z 原生 probe 的引擎哈希与隔离 `.app` 中 Brush 一致，实际设备 Apple M1 Pro、backend Metal、退出 0；包含 configuration、initialization、tensor allocation、forward、forward readback、backward、gradient readback、compute validation、synchronization。`forward_finite=true`、`gradient_finite=true`、`gradient_l1=0.03635027748532593`。4 份 runtime 文件未截断、未遗漏；导出 stdout 与原 probe 原文一致。

敏感绝对根目录扫描未发现 `/Users/minkai`、`/Users/`、`/private/var/folders`、`/var/folders`、`/Volumes/`。路径字段使用 `[REDACTED_PATH]` / `[LOCAL_PATH]`，stderr 用户根使用 `<USER_HOME>`；其后仍保留测试仓库/app bundle 的路径后缀，因此仅声称用户名/根目录已脱敏，不声称移除了每一个路径组成部分。保留的 `/usr/bin/sw_vers`、`/usr/bin/uname` 为系统命令路径。核查见 [inspection.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/diagnostics-no-project/inspection.json)。

## 原生训练、编辑、导出与重开闭环

原生快速预设实际为 **3000步、SH0、1280px、max_splats=1500000、6线程、image cache=1GiB、Metal / Apple M1 Pro**。40/40照片注册，41,601稀疏点，重投影误差0.312px。13:24真实训练实时预览中可以看到石块模型。原生暂停后保留500步checkpoint，Brush PID24609退出；原生继续时重新执行计算预检，PID24698以 `--start-iter 500` 续训，完成3000步。

首次完成后，通过原生恢复点管理器明确选择 **2500** 并确认恢复。原完整PLY及3000步checkpoint已归档，归档哈希与原值一致。继续时PID25039以 `--start-iter 2500` 启动；点击取消并确认后进程退出，保留5个有效checkpoint。再次原生继续时真实重检通过，PID25195从2500训练至3000，13:35:23退出0，最终保留6个有效checkpoint。恢复始终为 `ply_warm_start_optimizer_reset`、`optimizer_state_restored=false`；API、设备和参数未变，每次新运行只更新run_id。

| GUI模型节点 | 顶点数 / 字节 | SHA-256 |
| --- | --- | --- |
| 首次完成（500→3000）及其归档 | 140,211 / 7,852,319 | `9ea0d88664465862b697af5113ba76f680c90d6d29a8aed03f3837a0be1521e4` |
| 最终恢复完成（2500→3000），编辑前 | 138,688 / 7,767,031 | `ce46eff9008b4665551afb0c8247b33b68741b2a3686e9833a283f83a5e976bb` |
| 编辑保存、原生导出和重开后的实际模型 | 138,688 / 7,766,890 | `32349b288ff540ca47fc64c7ca53fdb253d7e8945887725ea7b1a29264f945c4` |

**查看器复核**：初次完成时出现“所选模型尚未显示 · 保留上一帧”，保留13:28:14预览。调查日志记录窗口自13:28:15被遮挡；源码对隐藏document推迟静态模型加载。将原生窗口Raise后，最终训练完成时显示 **“高斯渲染13:35:25更新”**，警告消失，实际模型可见。因此可见窗口查看器验收记PASS；原异常观察、初步判定和日志全部保留，不认定为已证实的GPU缺陷。13:35–13:36日志没有显式visibility转换行，Raise后成功结论依据本轮原生AX/截图与最终训练receipt，未虚构日志确认。见 [后续查看器结果](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/viewer-investigation/outcome-after-raise.json)。

在原生SuperSplat编辑器中将位置 **X从0改为0.05**、回车并点击应用“保存”，观察到 **“模型已保存。”**。编辑前后PLY均保留。按其余13个属性逐顶点唯一匹配138,688个顶点，实际文件坐标X平移均值为 **−0.050000002229**，与−0.05的最大误差 `4.768371582308806e-08`；符号对应编辑器导入时Z旋转180°。Y/Z及其他属性逐位不变，全部1,941,632个浮点值有限，载荷长度精确。序列化重排了顶点和属性，使用逐顶点匹配而非简单按行比较。编辑器只更新scene.ply，训练阶段output/manifest.json仍保留编辑前字节数；本轮依据实际PLY校验，不把旧manifest当作编辑结果。

通过编辑器 **File→Export→PLY** 导出 `gpu-resilience-edited-20261110.ply`（SH0）。原生WebKit保存到Downloads；macOS TCC拒绝shell直接读取该目录，随后通过Finder把本次生成文件移至独立 `gui-exports/`，未更改系统权限。导出文件与项目scene及保留副本逐字节一致。原生Cmd-Q后旧PID23600退出；随后CUA读窗口时显示“正在启动”（可能触发自动重启），再显式选择同一候选app路径，项目中心点击测试项目。新PID26326对应同一隔离可执行文件，**13:53:17**出现新高斯渲染画面，无旧帧警告；设置页显示 **Metal · Apple M1 Pro**。已编辑模型哈希及冻结profile哈希 `779d2585b2e735d30854c8e05c7927477f8d1acc58eafc625eda12e7171321ea` 保持不变。这是已完成项目缓存重开，不计为又一次GPU训练。

证据：[明确恢复](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/monitor/explicit-restore-2500-receipt.json)、[最终训练](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/monitor/final-training/receipt.json)、[编辑保存](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/edit-save/persistence-summary.json)、[逐顶点比较](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/edit-save/vertex-correspondence.json)、[原生导出](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/editor-export.json)、[重开](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/reopen.json)。

## 有项目诊断与最终保护核查

重开后原生设置→诊断→导出脱敏诊断包，Finder实际选中新ZIP。文件 `diagnostics-20261110-055407-01a1c405-5924-7801-9ec9-534f364abefe.zip` 为 **26,770字节**，SHA-256 **`605d30a7a0e0aa667968ae699abc89321279ab9e3c2aa9598324ac85d4f9cd51`**。原包原样复制到 `E/gui/diagnostics-project/`，29条目CRC全部通过、源/复制哈希一致；包含12阶段completed的项目摘要、149条事件、24份完整runtime文件，未遗漏/截断。

包内6次应用级真实计算记录覆盖首次预检至最后续训（13:18:34–13:33:36），均退出0，forward/gradient有限且gradient非零；实际引擎哈希均为包内候选 `c603392865c52d5761c8af341e3cfaed39c062f2ba221f0c35313da9415f2590`，stdout与原文一致。system记录PID26326、Metal / Apple M1 Pro及1280px/3000/SH0。项目阶段另有4次compute记录，不能与应用级6次混作同一计数。用户名、原项目名称、用户绝对根目录扫描无命中，project summary的id/name已脱敏；`<USER_HOME>`后的仓库/app路径后缀及事件关联UUID仍保留。证据：[有项目诊断检查](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/diagnostics-project/inspection.json)。

13:56通过Cmd-Q正常退出候选，CUA应用列表确认不再运行，随后进程清单确认候选及本次Brush子进程全部退出。执行 `python3 E/gui-isolation.py restore`（E替换为实际证据根），三目录恢复且原文件SHA-256全部一致；隔离状态移至 `E/gui/test-state-0/`（Application Support）、`test-state-1/`（Caches）、`test-state-2/`（WebKit）。此前证据中指向临时Library运行日志的路径是执行时路径，现可在这些归档目录找到对应内容。

原安装主程序SHA-256仍为 `955e0b410d4d7f22fde6d0a89ce5181bbd36f0e8c08ca30fb89655f95924893d`；原安装记录的全部5项身份/manifest/可执行文件哈希未变，旧冻结pack manifest仍为 `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`。候选完整载荷复验再次退出0，应用、bundle inventory与3,100个引擎文件全部匹配。标准构建输出和latest指针已更新为此次构建，原独立构建二进制与旧latest报告另保留于 `E/preserved-build/`，没有替换现有安装。

证据：[退出进程核查](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/final-process-check.json)、[用户状态恢复](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/isolation.json)、[原安装与旧pack核对](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/isolated-payload/preservation-after-gui.json)、[候选复验](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/isolated-payload/verified-isolated-app-after-gui.json)、[最终仓库/fixture/报告复核](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/final-review.json)。

## 实际命令与证据入口

以下是已经执行的命令文件，内含本机绝对路径和进程环境；均从应用仓库根运行。路径固定于此次证据，重跑时应另建新的输出目录，避免覆盖。

| 步骤 | 实际命令/脚本 | 结果证据 |
| --- | --- | --- |
| 源码获取与 ancestry | `git fetch origin codex/gpu-backend-resilience`；`git switch --track -c codex/gpu-backend-resilience origin/codex/gpu-backend-resilience`；`git merge --ff-only ...`；两次 `git merge-base --is-ancestor` | [source-provenance.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/source-provenance.json) |
| 独立 Brush clone/build | `git clone --no-checkout https://github.com/MinKaiZhi/brush <独立目录>`；detach 固定 commit；[build-brush-command.sh](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/build-brush-command.sh) | `E/brush-clone.log`、`build-brush.log`、`build-brush.exit=0` |
| 补丁、能力核对 | `python3 scripts/macos/prepare-brush-source.py <独立源码> --profile metorigin-macos.6-resilience --verify`；候选 `--capabilities-json` | `E/brush-source-verify.txt`、`brush-capabilities.json` |
| Fixture 获取/检查 | 固定 URL `curl -fL --connect-timeout 20 --max-time 900 --retry 2 ...`；`python3 scripts/macos/prepare-smoke-fixture.py --archive .../james-download/images.zip --output .../james40` | [fixture-acquisition.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/fixture/fixture-acquisition.json)、[hash-verification.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/fixture/hash-verification.json) |
| Python 回归 | `python3 -m unittest scripts/macos/test_prepare_brush_source.py scripts/macos/test_build_brush.py` | `E/python-tests.log`、退出 0 |
| Rust 回归 | [rust-tests-command.sh](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/rust-tests-command.sh)：`cargo test --locked -p splat-engine-brush -p splat-pipeline -p splat-project --lib` | `E/rust-tests.log`、退出 0 |
| 核心验收 | [core-command.sh](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/core-command.sh)：四引擎/原图显式环境变量；`node scripts/shared/validate-gpu-resilience.mjs metal --report-dir .../core` | `E/core-console.log`、`core/current/receipt.json`、退出 0 |
| 依赖/前端/许可证准备 | `pnpm install --frozen-lockfile`；各验证器完整命令见 [preflight-summary.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/packaging-inputs/preflight-summary.json) | `E/packaging-inputs/*` |
| Pack 与重定位 | [pack-command.sh](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/packaging-inputs/pack-command.sh)：显式 Brush artifact/source/evidence、COLMAP/FFmpeg 来源；`verify-pack.py ... --relocate` | `E/packaging-inputs/pack-engines.log`、`verify-pack-relocate.log` |
| 应用构建 | [app-build-command.sh](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/app-build-command.sh)：`build-macos-app.sh --internal-alpha --app-only --engine-pack-root .../macos-pack` | `E/app-build.log`、退出 0 |
| 隔离复制及验证 | `/usr/bin/ditto`；[verify-command.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/isolated-payload/verify-command.json) | `E/isolated-payload/verified-isolated-app.json` |
| 负向拒绝边界 | [negative/command.sh](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/negative/command.sh)；各 `command.json` | [reviewed-results.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/negative/reviewed-results.json) |
| 原生操作序列 | CUA原生启动、预检、创建、暂停/继续、checkpoint恢复、取消、编辑保存、File→Export→PLY、Cmd-Q、项目中心重开、设置诊断导出 | [gui/observations.md](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui/observations.md)；对应本轮对话AX与截图 |
| 保存/导出/重开核查 | Python `hashlib.sha256`、完整PLY解析与13属性逐顶点匹配；`ps -axo pid=,ppid=,command=` | `E/gui/edit-save/`、`editor-export.json`、`reopen.json`、`final-process-check.json` |
| 诊断核查 | Python `zipfile.ZipFile.testzip()`、逐条目原文/哈希/敏感根扫描 | `E/gui/diagnostics-no-project/inspection.json`、`diagnostics-project/inspection.json` |
| 用户状态恢复 | `python3 artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/gui-isolation.py restore` | `E/gui/isolation.json`：`status=restored`，三项`restored_hashes_match=true` |
| 最终证据复核 | `python3 artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/final-review.py` | `E/final-review.json`：40张fixture未变、323个原用户文件恢复、原安装与旧pack哈希未变、本地证据链接有效、仅新增本报告 |

## 失败原因链、限制及后续缺项

1. **负向用例的预期失败**：两个 deliberately invalid engine 副本使原正向 Rust harness 退出 **101 / FAIL**，这是预检阻止的证据，并非 Metal 候选失败。损坏 Mach-O 的子进程实际退出 126、`cannot execute binary file`，生产层返回 E-5004；无效 JSON 子进程退出 0，但生产 parser 返回 E-5004。原负向汇总器曾期待 `Exec format error/os error 8` 文字而错误标记损坏用例；保留原日志/汇总，另以 `reviewed-results.json` 记录拒绝行为 **PASS**。没有重写原始结果，没有触发真实计算或流水线。
2. **非阻断工具缺项**：`xcrun metal --version` 报 `cannot execute tool 'metal' due to missing Metal Toolchain`，其提示安装命令为 `xcodebuild -downloadComponent MetalToolchain`。本轮不修改系统安装；候选 Rust 构建及实际 Metal forward/backward、3000 步均已成功，故缺少独立离线编译工具不等于 GPU 运行时不可用。
3. **依赖获取初次失败已解决**：sandbox 内固定归档下载因 `127.0.0.1:7890` 代理连接失败（curl 7）；授权的同 URL 下载成功，完整归档及逐图校验通过。日志分别保留 `fixture/download.log`、`download-escalated.log`。
4. **公开发布门禁未满足**：复用的应用许可证材料校验适用于 internal-alpha，但 `release_ready=false`。具体缺项为 `pkg:npm/react-remove-scroll-bar@2.3.8` 未找到原文 license/notice，仍需人工核对，见 `artifacts/licenses/macos-arm64/current/release-readiness.json`。未修写旧 manifest 或把此问题计作 GPU 失败。原 GPU 阶段未执行公证；后续公证通过不改变此许可证缺项，也不代表公开发布或干净机器安装通过。
5. **查看器初始现象已复核**：窗口遮挡期间保留上一帧；Raise后的实际最终渲染及重开渲染均成功。原始失败观察和后续PASS证据并列保留，不将未经复现的隐藏窗口现象提升为已确认GPU故障。
6. **本轮无未完成的必需验收步骤**：原生操作、诊断与收尾均完成；生产源码未修改，原 GPU 阶段最终复核时 Git 状态仅新增本结果文档，受测 HEAD 为要求提交。若以后要求公开发布，需要补齐上述license/notice并另做相应发布门禁；若要求macOS15或干净机器结论，必须另行实测。

所有通过结论来自本轮实际 M1 Pro 执行。Windows、旧 `macos-m1.md` 或既有训练结果均未用于替代本机验收；独立视频、其他硬件、macOS 15 和干净机器均保持未执行。

## Developer ID 签名与 Apple 公证补充验收

本阶段在原 GPU 验收完成后，经用户另行授权执行。原验收约于 2026-11-10 14:01（Asia/Shanghai，UTC+08:00）结束时，Developer ID 签名及公证的历史状态仍为 **NOT RUN**；以下追加结果不改变此前执行范围。

仓库：<https://github.com/metorigin/MetOrigin-Splat>；分支：`codex/gpu-backend-resilience`；本阶段受测完整 HEAD：`2121f91aa268aa1b4dd0db7fd7ef0f751bd5e857`。本补充阶段 14:49 开始，15:47:31 观察到 Apple **Accepted**，15:48:20 完成最终 DMG 验证，15:51:06 完成本地交付登记和 latest 核对，15:54:49 完成独立公证覆盖审计。所有时间为 2026-11-10、UTC+08:00。

签名、公证 DMG 容器、票据、本机 Gatekeeper 及最终载荷验证为 **PASS**。已签名 Brush 的真实 Metal smoke 为 **PASS**；已签名字节再次 3000 步训练和完整 GUI 验收为 **NOT RUN**。原 GPU 全流程证据仍绑定此前内部 ad-hoc 候选。公开发布许可证门禁仍有缺口，本结果不构成公开发布就绪或 clean-machine 验收。

### 路径、版本与身份

以下证据缩写均以仓库根目录 `/Users/minkai/work_space/MetOrigin/MetOrigin-Splat`（ROOT）为基准：

| 缩写 | ROOT 下的实际路径 |
| --- | --- |
| E | `artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro` |
| CONTROL | `artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921` |
| RUN | `artifacts/verification/macos-arm64/build.TdUd9m`（完整原始构建记录，保留） |
| DELIVERY | `artifacts/verification/macos-arm64/dmg.notarized-20261110-faf3kmlg`（独立实体报告副本） |

应用 `CFBundleShortVersionString=0.1.0`、`CFBundleVersion=0.1.0`、`CFBundleIdentifier=com.metorigin.splat`，声明最低系统 `15.0`，架构 `arm64`；该最低声明不代表 macOS 15 实测。Brush `1.0.0+metorigin-macos.6`，目标 `aarch64-apple-darwin`，能力含 `probe_diagnostics_v1`，固定来源 `1388f74c6fe0236f68ee4915564bf00e9d2e3747`。

签名证书：`Developer ID Application: zhi zhonghao (LZD4H9936U)`；Team ID：`LZD4H9936U`；证书 SHA-1：`802D89E22786B9E333571DC08635950131F4A1CD`；Keychain profile：`metorigin-notary`。应用与四个可执行引擎启用 Hardened Runtime；dylib 和 DMG 未设置该标志不计为失败。

已签名应用独立保留于 `ROOT/.cache/metorigin/gpu-resilience/20261110-m1-pro/signed-payload-20261110-144921/MetOrigin Splat.app`；签名阶段没有将它安装到 `/Applications`。

### 逐项结果

| 项目 | 结果 | 实测范围、失败原因与证据 |
| --- | --- | --- |
| 首次签名构建输入检查 | FAIL | 原候选 `engines/.DS_Store` 未在 manifest 声明，签名前退出 1。原文件未删；`CONTROL/build-submit-command.sh`、`build-submit.log`、`build-submit.exit` 保留。 |
| 独立签名输入副本及第二次构建 | PASS | 仅在新副本排除 5 个 `.DS_Store`；原 3100 个声明文件及 manifest 一致。第二次脚本退出 0；`CONTROL/signing-input-copy.json`、`build-submit-attempt2.log`、`review-notary-preflight.json`。 |
| 引擎签名、来源、包完整性 | PASS | 123 个 Mach-O 已签名；来源保留并复核，签名包 3121 个声明文件匹配；`RUN/signed-engine-pack/engine-signing.json`、`signed-engine-relocation/`。 |
| 已签名应用与隔离副本 | PASS | 签名身份、arm64、自包含依赖、应用及 bundle inventory 一致；`RUN/verified-app.json`、`verified-isolated-signed-app.json`、`runtime-engine-locator.log`、`runtime-application-preflight.log`。 |
| 已签名 Brush 的实际 Metal 预检 | PASS | 14:57:03–14:57:10；Apple M1 Pro / Metal，有限 forward/非零有限梯度，退出 0；前后 Brush 与 manifest 哈希未变。`CONTROL/signed-metal-probe/receipt.json`。 |
| Apple 上传与公证接受 | PASS | 14:59:24 开始，15:01:20 上传成功，15:47:31 观察到 `Accepted`；同一提交 `bfd4894f-f072-440b-9e95-5bee5067ccf1`。`RUN/notary-dmg/submission.json`、`info-latest.json`、`apple-log.json`、`result.json`。 |
| DMG staple 与票据验证 | PASS | 15:47:34 staple、15:47:35 validate 均退出 0；`RUN/notary-dmg/commands.jsonl`、`result.json`。 |
| 最终 DMG、本机 Gatekeeper | PASS | `verify-app.py --require-notarized-container` 退出 0；只读挂载后应用字节及签名匹配；DMG `spctl --type open` 退出 0，`source=Notarized Developer ID`。`RUN/final.json`、`CONTROL/verify-notarized-dmg.log`。 |
| 独立 Apple ticket 覆盖审计 | PASS | 126/126 ticket 路径及 CDHash 匹配：123 引擎 Mach-O、app bundle、应用主程序与 DMG；相同字节在授权沙箱外逐项 strict codesign 均退出 0。`CONTROL/review-final-notarization.json`、`review-final-code-tickets.json`。 |
| 独立交付记录与 latest | PASS | DELIVERY inventory、登记记录、最终 DMG hash 与 latest 独立核对一致；`CONTROL/publication.json`、`DELIVERY/retention-run.json`、`delivery-evidence-provenance.json`。仅为本地登记，没有对外发布。 |
| 原 RUN 直接登记 | FAIL | COLMAP `colmap.INFO` 日志符号链接触发 `Linked package contents cannot be automatically pruned.`；原 RUN 和链接均保留，另建实体报告副本完成登记。`CONTROL/register-without-pruning.log`。 |
| 保留策略 dry-run | FAIL | DELIVERY 登记已写入后，历史 `build.zvw9R6` frozen-app 树缺失触发 `Package report contents changed; no cleanup performed.`，命令退出 1；独立核对确认本次登记有效。`CONTROL/register-delivery-without-pruning.log`、`publication.json`。未执行 pruning。 |
| 现有安装、旧包和验收载荷保留 | PASS | 15:50:10–15:50:15 最终复核；具体范围见后文和 `CONTROL/preservation-final-20261110-155010.json`。 |
| 应用自身单独 staple / execute assessment | NOT RUN | 本阶段验证 DMG 容器；`final.json` 保留应用自身 `stapled_ticket_validated=false`、`gatekeeper_assessment_performed=false`，不能与 DMG PASS 混淆。 |
| 签名字节再次 3000 步训练、完整原生 GUI 流程 | NOT RUN | 只补做 signed Brush compute smoke；未重复训练、编辑保存、导出、重开、诊断导出 GUI 全流程。 |
| clean-machine / macOS 15 本机验收、对外发布 | NOT RUN | 无对应实际执行证据。 |
| 公开发布许可证门禁 | FAIL | 794 个许可证证据文件已核对，仍有 1 项 `missing-license-texts` 人工审查缺口，`application_public_release_ready=false`；`RUN/final.json`。 |

### 真实命令与计算结果

签名构建完整命令及输出见[第二次构建命令](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/build-submit-attempt2-command.sh)：先 source `E/app-env.sh`、unset `CARGO_TARGET_DIR`，执行 `bash scripts/macos/build-macos-app.sh --internal-alpha --engine-pack-root ROOT/.cache/metorigin/gpu-resilience/20261110-m1-pro/macos-pack-signing-input-20261110-144921 --signing-identity 802D89E22786B9E333571DC08635950131F4A1CD --team-id LZD4H9936U --notary-profile metorigin-notary --notary-submit-only`。此处 ROOT/E 仅为报告缩写，链接中的脚本包含完整实际路径。

完整实际 argv、时间、退出码和输出保存在[公证命令记录](../../artifacts/verification/macos-arm64/build.TdUd9m/notary-dmg/commands.jsonl)、[收尾命令记录](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/completion-commands.jsonl)、[交付登记命令](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/register-delivery-command.json)。执行过 `xcrun notarytool submit/info/log`、`xcrun stapler staple`、`xcrun stapler validate`；最终验证另实际执行 `xcrun stapler validate -v` 和 `/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=4`，目标均为下表 DMG。

GPU 实际命令为 `ROOT/artifacts/verification/macos-arm64/build.TdUd9m/signed-engine-pack/engines/brush/bin/brush --probe-json`，没有添加猜测的后端参数。还执行 `codesign -d --verbose=4`、`codesign --verify --strict --verbose=2`、`lipo -archs`、`otool -L`、`--capabilities-json`；[完整命令及 PID](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/signed-metal-probe/commands.json)。测试临时文件和 CubeCL cache 均隔离在 `CONTROL/signed-metal-probe/`。

计算结果：`Apple M1 Pro` / `metal`，8 Gaussians、32×32，`forward_finite=true`、`gradient_finite=true`、`gradient_l1=0.03635027725249529`、`loss=0.10156942903995514`；退出 0。能力及结果见[签名后 smoke receipt](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/signed-metal-probe/receipt.json)。

### 最终字节身份

DMG：`/Users/minkai/work_space/MetOrigin/MetOrigin-Splat/artifacts/packages/macos-arm64/MetOrigin-Splat-release-21da5aff33c5-build.TdUd9m.dmg`。上传前 `664582377` bytes；staple 后最终 `664586650` bytes。提交 ID 与 Apple 日志绑定提交前 hash；票据使容器字节变化，内部应用身份未变。

| 对象 | SHA-256 |
| --- | --- |
| 原内部候选 manifest / release status | `aa8386696f4a27a2e8e540cea8b7509c1342e7c26b952eabe4b997e92de664b7` / `30803390e9bd1adbe6ed26faedb3df80683baaf02df15bd001229fe43c6bd775` |
| 原内部候选 Brush | `c603392865c52d5761c8af341e3cfaed39c062f2ba221f0c35313da9415f2590` |
| 已签名 manifest / release status | `21da5aff33c55cd612fd43275c88c8c3323f9bd4ae3f348bd5783ceadeba5b89` / `c8540f035612383f005547d376f33fac211986eec2fc6fa95133e6d9640821b6` |
| 已签名 Brush | `3eaade4edc16ac4184493999d3949ce0b93aa69e5bae52f05abf59b0d7db2cd9` |
| 已签名应用 Mach-O / bundle inventory | `750abb0a2fb3c32c6172bdd3827c3ca72a09e641d9721bf5c16dd074b57000d4` / `fe4da30e2a0e748b5d2376b1c5a2ce00019c3d74278acb55d23cfce252c15a7c` |
| 应用许可证 manifest | `917558d2fba429f00915f8083c0dd3712f8b58deea7de68a4139787d7670547b` |
| 提交 DMG（staple 前） | `604f9a3a1d8a756c5cd56a1a4ed6e31cd6070dc1066fb2f7d2f03ffed4438776` |
| 最终 DMG（staple 后） | `2e5beb2f71be15cac342993fc37656f8ebfc4e603caf251049961b3784842b7b` |
| Apple 接受日志 | `0980be9d91b6537918ecddc8b70624b6160a71ee58560463ea99149a59fcb52c` |

### Apple 警告与范围

Apple 日志为 `Accepted`、statusCode 0，但有 **5 项 warning**：Cargo 来源材料内以下测试归档不能解包。Apple 原文说明其中若包含可执行文件，这些可执行文件不会被公证；因此不能宣称这些归档内容均获公证。警告原始路径、原文及 ticket 内容保存在 [apple-log.json](../../artifacts/verification/macos-arm64/build.TdUd9m/notary-dmg/apple-log.json)，未删除或隐去。

| Cargo 来源包 | Apple 指出的测试材料相对路径 |
| --- | --- |
| `async_zip-0.0.18` | `tests/test_inputs/sample_data.zstd.zip` |
| `async_zip-0.0.18` | `src/tests/read/locator/empty-with-max-comment.zip` |
| `async_zip-0.0.18` | `src/tests/read/locator/empty.zip` |
| `async_zip-0.0.18` | `src/tests/read/locator/empty-buffer-boundary.zip` |
| `flate2-1.1.9` | `tests/corrupt-gz-file.bin` |

独立[最终覆盖审计](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/review-final-notarization.json)及[逐项票据记录](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/review-final-code-tickets.json)核对全部 126 个 ticket 路径/CDHash，覆盖实际 123 个引擎 Mach-O、应用 bundle/主程序及 DMG；3121 个引擎声明文件、5210 项应用 inventory、delivery/index/marker/latest 与当前字节均匹配。警告材料另经本地检查：3 个 ZIP 为零 entry 空包；Zstd ZIP 含 3 个目录和 4 个 `0644` ASCII 文件，解压内容与同 crate 的 stored ZIP 样本逐字节相同；损坏 GZip 在本地按预期解压失败，对应源码测试明确期望 `InvalidInput`。这些是来源测试夹具检查，不声称其嵌套内容已获 Apple 公证。

最初沙箱内 codesign 观察为 **FAIL**：证书 Authority 不可用，strict verify 返回 1；文件 SHA-256 和 CDHash 均匹配。随后经授权在沙箱外对相同字节完成只读复核，126 项 Developer ID/Team 均显示且 strict verify 均退出 0。两次观察和执行环境差异保存在 [review-final-execution-context.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/review-final-execution-context.json)；没有为此重签名或改动包。

### 保留结果与登记恢复

原验收后、签名基线采集前，`/Applications/MetOrigin Splat.app` 已变为今日内部候选；具体安装变更执行者未验证。本次签名没有修改它。14:51:39 采集的签名阶段安装基线、14:53:32 比较及最终 15:50:10–15:50:15 复核的 5 项身份文件均一致。历史 GPU 验收前安装与当前版本仍有 3/5 项差异，相关原始比较保留，未将其改写为全程安装未变。

最终保留复核 **PASS**：3 个既有 DMG、旧冻结包 2999 个声明文件、原候选包 3100 个声明文件、已验收隔离应用完整 inventory 均未变；该阶段复核时 Git tracked/staged diff 均为空，HEAD 同上，仅未跟踪主结果文档。旧 DMG 完整路径/hash、全部检查和历史基线见[最终保留证据](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/preservation-final-20261110-155010.json)及 `CONTROL/preservation-during-signing.json`。原包 `.DS_Store` 仍保留，严格文件集合检查仍 FAIL；保留 PASS 仅说明既有字节及声明载荷未改。

原 RUN 因 COLMAP 日志符号链接未能直接登记，完整保留；只将校验过的实体报告副本放入 DELIVERY。历史保留策略 dry-run 警告发生在新登记写入后，后续独立核对新登记、inventory、DMG 及 latest 均通过。三个既有 DMG 未变，`automatic_pruning_executed=false`。本地交付状态及范围以[publication.json](../../artifacts/verification/macos-arm64/gpu-resilience-20261110-m1-pro/notarization-20261110-144921/publication.json)为准；公证不能消除许可证人工审查缺口，也不替代签名后完整训练和 GUI 重测。
