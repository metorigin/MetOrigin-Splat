# GPU 后端可靠性验证记录

日期：2026-11-09，补充至 2026-11-10（Asia/Shanghai）。分支：`codex/gpu-backend-resilience`。
实现提交：`908863b4db00b22d8245eb37576aef71ede0ee40`，已推送到
`https://github.com/metorigin/MetOrigin-Splat` 的同名分支。Mac 请通过 Git 获取分支，
按 [M1 Pro 交接文档](gpu-resilience-m1-pro-handoff.md) 执行；此前 ZIP 仅作为历史工作树快照。
范围只包括本机 RTX 5080 Laptop 和用户将执行的 Mac M1 Pro；没有测试 RTX 2060 或其他硬件。
本记录不判断客户 DX12 故障根因。缺少 DLL 可复现泛化失败属于线索，不能证明客户安装或驱动损坏。
本记录中的 `target/` 和 `artifacts/` 是 Windows 本机证据路径，不随 Git 提交或推送；
Mac 应生成自己的实机证据，不能因本地没有这些 Windows 产物而跳过验收。

## 实现状态

| 项目 | 本分支实现 | 验收边界 |
| --- | --- | --- |
| 自动 / DX12 / Vulkan | Windows 默认自动；仅符合计算失败协议或已清理的纯计算超时才尝试独立 Vulkan 真计算；显式和冻结选择不回退；Mac 保持 Metal | 单元和独立进程契约测试覆盖双失败、取消、协议/身份/配置错误、新旧协议兼容 |
| 底层诊断 | stage、cause chain、adapter/driver/OS、完整 EXE/DLL hash、实际 DXC 加载路径/版本进本地日志，stdout 一行安全 JSON；无项目也能导出脱敏诊断；版本检查与计算验证分开 | Windows 新引擎已构建；Mac `.6-resilience` 来源及构建入口准备好，未原生构建验收 |
| 预检和训练绑定 | 创建事务保存成功预检 profile；启动/续训按冻结 backend/device 重检；预检、freeze、训练命令创建检查 EXE/依赖漂移；Mac 包内 dylib 也纳入哈希 | 不建立长期成功缓存；驱动/系统变化通过每次真实计算重验；不声称对系统 Metal 库做完整哈希绑定 |
| 完整性及原生验证 | Windows 三份固定补丁、Cargo.lock、完整 BUILD-INFO、固定 DXC 来源和 EXE/DLL 哈希交叉验证 | 本机完整原生核心流水线见下；隔离包及原生界面补充检查见下，M1 Pro 和新安装器验收未执行 |

Mac 原 `metorigin-macos.6.patch` 保持不变。新 `.6-resilience` 是独立候选 profile，
显式构建参数见 [M1 Pro 交接文档](gpu-resilience-m1-pro-handoff.md)。
两平台保留已有机器协议版本号，以补丁、源码差异、EXE 完整 hash 区分新构建；
新引擎能力额外声明 `probe_diagnostics_v1`，声明后严格校验失败 kind/stage。

## RTX 5080 实际证据

硬件为 NVIDIA GeForce RTX 5080 Laptop GPU，驱动 592.01。
最终候选位于 `target/gpu-backend-resilience-engine/`，不是用户安装目录。
EXE SHA-256：`04fa8ad6f1bf90c32d7dcf3c1344aa145ae049800782dea627e40d93bcdbd99d`。
`dxcompiler.dll`：`f79943b02f73b621421b58a569fd6ee120d0023fb6bfa23844ecad6b00d6a295`；
`dxil.dll`：`62736e99aa534a942873f92b881a71b2cb6ad62b8d7481ea7a8ad8e9888a8056`。
来源为锁定的 DXC v1.8.2502 归档，运行日志实际读取 DLL 版本 1.8.2502.8。

`scripts/shared/validate-gpu-resilience.mjs` 调用生产核心十二阶段，使用校验过的
James40 照片、新建中文空格目录及明确的 3000 步、SH0、960px 配置。
它完成真实 SfM、训练、取消/续训、中间 checkpoint 恢复、旧结果归档、完整 PLY
读取、项目重新打开、缓存检查、重新导出和哈希比对。它不是 8 Gaussian probe，
也不是预设画质评测或原生编辑器操作验收。

| 选择 | 实际 API | 结果 | 最终 Gaussian | 最终 PLY SHA-256 |
| --- | --- | --- | --- | --- |
| 自动，无 backend/device 环境覆盖 | DX12 | PASS，完整训练及恢复、导出、重开 | 92,818 | `6da93d5367ddc5971f0d1d1c1d7195673ca2ba96cc16dbe7e96ee005408d9897` |
| 显式 Vulkan | Vulkan | PASS，完整训练及恢复、导出、重开 | 87,311 | `5d606ec291b626ef94fa7db5fdfd59abd880d10552be2aa0a3d3e8cb66b4b019` |

自动/DX12 证据：`artifacts/verification/windows-x64/gpu-backend-resilience/auto/`。
Vulkan 证据：`artifacts/verification/windows-x64/tests/gpu-resilience-vulkan/current/`。
两个项目均在第 1000 步取消并续训，完成后再显式恢复第 1000 步，重新训练到 3000 步。
最终导出与重新打开检查均通过；Vulkan 报告正常发布。测试总耗时分别约 359 秒和 345 秒，
包含输入校验及多次真实训练，不作为默认预设或 GPU 性能对比。
首次公共报告发布的目录 rename 返回 EPERM，训练测试已退出 0；原始 receipt、cargo.log
与完整项目没有丢失或修改。另复制报告到上述新目录并逐文件核对 hash，
`publication-recovery.json` 保留失败边界、原项目位置和 EXE/DLL 结束时的独立哈希复核。
没有据此把测试重新描述为失败，也没有隐瞒报告发布失败。

四个最终引擎原生负例（缺 DXC、损坏 DXIL、缺 backend 参数、指定设备不存在）
均 exit 1，stdout 恰好一行安全 JSON；stage 和完整原因链留在 stderr。
证据：`target/gpu-resilience-native-diagnostics/results.json`。
独立 CLI 缺 DLL 的 kind 为 backend_compute；应用层在启动前验证完整 DXC 哈希，
因此缺 DLL 会在依赖检查处阻止，不能通过自动回退掩盖。

既有安装载荷另做只读校验：146 个引擎清单文件的尺寸/SHA-256 通过，DXC 与固定来源一致。
记录为 `target/gpu-resilience-installed-integrity.json`。旧安装 Brush 的完整 hash 为
`d1ac8df81c6cf6d7446683add22f4e7ee4df05a094803bd4e5d9c9a527f5ba03`。
该项只证明原安装载荷完整，不冒充新候选的安装器验收。用户安装、客户安装和驱动均未修改。

## 自动回归与未执行项

后续审计补充：设置采用同目录唯一临时文件、同步并原子替换，消除并发预检暂时读不到
配置而误用默认自动选项的窗口；冻结项目预检也先验证配置。Windows `.1` 必须有
BUILD-INFO，schema、完整来源锁、顶层 binary hash、文件清单 hash 和实际 DLL 必须一致。
仅接受本分支完整来源锁或独立保留的既有 Windows `.1` 来源锁，不以部分字段放行。
`AlignmentPack.mjs` 已接受锁定的第三份 resilience 补丁，并拒绝未知增量。

最终边界审计也覆盖仍兼容的 Brush 0.3：该分支只允许有效的自动兼容配置，
拒绝显式 DX12/Vulkan、设备覆盖及无效配置，阻塞式驱动检查前后都检查取消。
结果明确标注“仅驱动检查，未验证 GPU 计算”；不能把旧版兼容结果冒充 Windows 1.x
的真实计算检查。相关 runtime 16 项通过，文案细化后 2 项针对测试再通过。

完整隔离候选包位于 `target/gpu-resilience-isolated-pack`；载荷、来源及实际运行时身份
验证通过，报告为 `artifacts/verification/windows-x64/gpu-resilience-native-20261109/pack-verification.json`。
engine manifest SHA-256：`2e3773d517abf255ca61b01318bd505686b4ecc9a833342b3629df7e7eff95c7`。
没有安装或覆盖用户现有应用。

原生界面补充验证使用独立 identifier `com.metorigin.splat.gpu-resilience-20261109`，
本机 debug Tauri EXE 加 production 前端，资源来自上述隔离包；它不是发布安装器。
已实际保存 Vulkan 设置，导入固定 40 张照片，并从新建项目向导执行真实计算预检，
界面显示 `NVIDIA GeForce RTX 5080 Laptop GPU · Vulkan · Gaussian 渲染与反向传播检查通过`。
UIA 观察记录与启动 EXE hash 位于 `target/gpu-resilience-native-ui/`。
最终验证应用 EXE SHA-256 为
`9dab90d720c58b3d46990a4c8865e144fb3ee5035d39669d85c67209c2713686`。
在独立副本中实际加载 87,311 个 Gaussian，进入 SuperSplat，把 Y 旋转从 0 改为 10，
保存后界面提示“模型已保存”；返回项目中心并重新打开，修改后的模型仍正常渲染。
测试副本为 `target/gpu-resilience-native-ui/projects/Vulkan 界面验证`，原训练证据未覆盖。
这项验证保存生成的 PLY，不冒充原生界面重新执行整条训练或独立“导出为”菜单测试。

无项目诊断导出在原生操作中发现并修复两个问题：环境/资源包发现的引擎目录未完全
脱敏（包含多层 JSON/debug 转义）；Codex MSIX 路径虚拟化使 Explorer 无法打开文本路径。
现在导出覆盖实际引擎目录，保留完整哈希；规范化输出物理路径后在后台打开目录，
避免目录打开影响成功导出。修复后原生导出和 Explorer 定位均通过，ZIP 8 个条目 CRC
通过，没有已知原始/转义私密路径，成功 Vulkan 预检阶段、设备、驱动及 EXE/DXC/BUILD-INFO
哈希均保留。ZIP SHA-256 为
`51ad21c154a841585df065a86db67a37b6705f8536d9806e313c1d6b9af57037`，
证据见 `target/gpu-resilience-native-ui/diagnostic-archive-verification.json`。
该成功日志不证明失败 cause 或 DX12 编译器加载，后二者使用各自已有原生证据。

后续历史日志回归进一步复现并修复了切换引擎后旧目录漏脱敏的问题。导出从同一缓存内
最多 128 个近期 JSON 回执提取历史引擎目录，每个回执上限 256 KiB，仅作字符串处理，
不访问回执所指向的目录；覆盖回执已在 64 个导出条目之外、原始日志和多层转义 stderr，
完整哈希与原因链保留。此回归修复前失败、修复后通过，system 测试 14 项通过。
缺失或超出发现范围的回执所对应的任意历史路径，不承诺自动识别；本地原始日志仍完整保留。
这项与旧版兼容修补属于原生 UI 验证后的定向回归，不改写此前应用 hash 及 ZIP 实测记录。

- 最终 Rust 核心：Brush 112 passed / 1 ignored，pipeline 150 passed，project 21 passed。
  记录：`target/gpu-resilience-final-core.log`。
- Tauri 命令回归：132 passed；相关前端四个文件 51 passed；TypeScript 与修改文件 ESLint 通过。
- Windows build + Mac source preparation：24 项 Python 测试通过。
- 原始 commit 实际应用全部 Windows 补丁，combined diff 和 Cargo.lock 哈希匹配；
  最终引擎 `build_brush_runtime.py --verify --offline` 通过；119 项 Mac 来源保护校验通过。
- `cargo fmt --all -- --check`、`git diff --check`、新增 JS 语法检查和 Mac 构建脚本 Bash 语法检查通过。
- 后续定向复核 28 项通过：Brush runtime 14、pipeline runtime 5、Tauri runtime 5、
  设置与诊断 4；Windows 校验脚本补充 3 项通过；AlignmentPack 7 项通过、1 项因
  受限进程可见性跳过，另以完整隔离包的实际构建和校验补足。
- 原生诊断导出修复后的 system 回归 13 项通过；最终 debug 原生应用重新构建通过，
  修复后实际 ZIP 与目录打开再次验证，最终格式检查通过。
- 提交前再次通过 Rust 格式检查及 119 项 Mac 来源保护校验。暂存源码的空白检查通过；
  哈希锁定的 `.patch` 保留 Git 补丁格式所需的空白上下文，旧来源锁保留原 CRLF 字节，
  不为消除外层 diff 的空白提示而修改来源文件。

系统 TEMP 的文件删除/原子替换在受限测试环境有 PermissionDenied；改为工作区隔离 TEMP 后
文件回归通过。两个跨进程锁测试还需要正常进程可见性，在允许本机进程检查后重跑通过，
最终整套核心回归亦通过。没有为这些测试放宽生产代码。

**未执行**：实际 Mac M1 Pro 本分支构建/Metal/训练/原生 GUI/包验收；Mac build recipe
模拟测试在 Windows 因缺 `/bin/bash` 不能运行，交由 Mac 执行；新 Windows 安装器安装
验收未在本轮执行。历史核心报告准确保留 `native_ui_verified=false`、
`installer_verified=false`。M1 Pro 结果需按交接文档由用户设备回传，正式目标保持未完成。

## 完成审计边界

原任务第 4 项要求核对安装载荷的 EXE/DXC 完整哈希与来源、统一 probe/training 依赖
加载策略，并在指定硬件执行完整训练及结果回归。上述隔离载荷、实际引擎与训练证据
覆盖 Windows 部分；不把未执行的新 NSIS 安装额外解释为本次必须新增的发布交付。
原生界面补充证据已归档到
`artifacts/verification/windows-x64/gpu-resilience-native-20261109/native-ui/receipt.json`，
其中逐项区分实际界面操作与未执行的界面训练/独立导出菜单，不修改历史核心 receipt。

当前仍需用户的实际 M1 Pro 按交接文档验证并回传结果。本机开发、RTX 5080 结果和
准备好的 Mac 材料都不能证明 Metal 已通过；收到并检查实机证据之前，不标记完整目标完成。
