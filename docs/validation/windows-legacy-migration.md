# Windows legacy 迁移与回退验收

核心观测日期：2026-10-30；独立 GUI 应用准备及原生只读验收：2026-10-31。关联 [Windows 对齐实施记录](windows-alignment.md) 与 [WIN-22 方案](../windows-gaussian-alignment-plan.zh-CN.md)。本记录覆盖真实旧包、匹配基线应用、生产核心迁移、独立 PLY 导入实验、匹配旧核心的回退，以及旧 GUI 的 viewer / 只读 editor / 返回 viewer / 正常关闭。旧编辑修改和保存未测，Windows1 发布默认未切换，Mac 真机门槛不由这些 Windows 结果替代。

## 来源与隔离

全部本机证据、源码导出、依赖缓存和产物保存在 Git 忽略的 `target/windows-rollback-20261030-01/`。通过 `git archive` 导出冻结应用基线 `69a699044b498ef0f3748807571ed13b7fdbd042`，ZIP SHA-256 为 `f6855a959b2a9cb86d51b4b66c28364351deec0eecf4d39661187ebfc66f2963`。未建立新 worktree，未修改兄弟仓库。935 个原始输入逐文件记录哈希，并在构建、真实运行后回检一致。

旧包使用该导出源码原有 `Acquire-EngineArchives.ps1`、`Build-BrushLive.ps1`、`Prepare-EnginePack.ps1` 和锁文件。相同锁哈希的 FFmpeg 8.1.2、COLMAP 4.1 和 VC Runtime 缓存只读复制；官方 Brush 0.3.0 二进制及源码归档按原锁下载、核对。完整旧包的清单、校验和、实际 CLI 版本及复制到 portable 目录后的仅 Windows System PATH 检查均通过。

| 身份 | 值 |
| --- | --- |
| 旧包 ID | `0.1.0-internal.1` |
| 原始匹配旧应用 SHA-256 | `39079481ad058138191438d2003491bbf24b32b3acdb850c7d95c960ce93aa50` |
| stock Brush 0.3.0 SHA-256 | `37e46cbf808b9983dd15a5f9a25328dbe43e7e06d53c4f59fbeaeb10e3a5b34a` |
| 旧 live companion SHA-256 | `fb6b072c47c1d2d276cb896b57e0b081dadb2b0c10714613a15df413193cbeba` |
| 新候选包 ID | `0.1.0-internal.windows-alignment.1` |
| 新 Brush SHA-256 | `4398eeabd0cc4becaf5d82fb81b76dfd377b791b7bd7251b0e2b7ca8fe7e4001` |

原旧应用脚本从父仓库读取的 `HEAD + dirty` 字段不能单独建立来源。独立的 `source-input-inventory.json`、`app-provenance.json` 同时绑定源码 ZIP、935 个输入、Cargo/pnpm 锁、工具链、57 个实际前端产物和 exe。当前生产核心另以 `migration-source-inputs.json` 固定实际使用的 175 个 crates、presets、schemas 及工作区锁/工具链输入；它不把未提交代码归为只有 HEAD 的构建。

旧包保留基线的内部包发布状态。生成的依赖清单核对了 129 个原生载荷及 1690 份许可证文本，仍记录 110 项许可证文本缺口及既有分发审查事项。本次功能验收不将它改为公开分发已就绪。

## 旧基线真实项目

外置 `legacy-fixture` 仅链接导出的原基线 crates，未改上述 935 个输入。使用 James40 CC0 原照片创建独立项目，执行原有完整 12 阶段 Windows legacy 链路。照片与项目内照片在前后逐 SHA-256 一致。

| 项目 | 实际结果 |
| --- | --- |
| SfM | 40/40 注册，10633 个点，重投影误差 0.247253 px |
| 训练 | 原旧包，fast，960 px，SH0，3000 步，`resumed_from_iteration=0` |
| 产物 | 有效 Gaussian PLY，21788 顶点，6 个 500–3000 步真实检查点 |
| 旧 scene SHA-256 | `ec3e78d3c852c348dbb82eae13bef70ee14497ee9dbcb1f537c2c244098fd3be` |
| 完成清理 | 全部阶段完成，项目锁释放 |

成功后以 `Preserve-LegacyProject.ps1` 创建三份逐文件核对的项目副本，每份最初均为 210 个文件：

- `project-copies/baseline-preserved.splat-project`：保留基准。
- `project-copies/windows1-transition.splat-project`：唯一执行新引擎迁移的副本。
- `project-copies/rollback-baseline.splat-project`：使用匹配旧核心和旧包复验。

原始项目和 `baseline-preserved` 的全部 210 个文件在迁移及回退测试后保持不变。回退副本的项目状态、验证记录可以更新；其源照片、scene 和六个检查点均逐哈希保持不变。

## 生产升级：归档后从第 0 步开始

当前生产 crates 在 `windows1-transition` 上运行。真实 compute probe 固定 DX12 和实际 RTX 5080 Laptop GPU 规范 ID：

```text
dx12:000010de:00002c59:4e5649444941204765466f726365205254582035303830204c6170746f7020475055
```

冻结新 Windows1 profile：960 px、SH0、3000 步、300000 max_splats、256 MiB 图像缓存、两个线程、LOD0。4 GiB 是候选策略预算；adapter 动态可用预算保持未知，本次没有将它当作实测或强制显存上限。机器仍可能存在原生 viewer 上下文，记录的耗时不用于独立性能或显存峰值结论。

旧项目原来没有显式 profile。生产 orchestrator 实际执行了由 profile 变化要求的重建，而未沿用旧训练完成记录。运行中读到了真实 `pending-invalidation.json`，当时旧 scene 仍存在且哈希不变；完成后 journal 消除。新训练 fingerprint 与旧 fingerprint 不同，旧六个检查点、result 和 fingerprint 进入 `runtime/previous-training/`。

生产归档并未额外创建名为 `scene.ply` 的旧输出副本。旧 scene 与旧 final checkpoint 字节相同；验收证明归档 final checkpoint 仍具有上述 `ec3e78…` 哈希，可以精确恢复旧 scene。独立保留副本也保有原 scene。

实际新训练完成 3000 步，`resumed_from_iteration=0`，`optimizer_state_restored=false`，分辨率为冻结的 960。模型及相机/图像维度检查通过，最终有效 PLY 为 89009 顶点，SHA-256 `ae3c0c59c2ac432a3ab5a476969afdace05bd5f1ea5f5be292ceb0ca11c61d63`。旧 checkpoint 没有被写入新 fingerprint，旧优化器身份没有继承。

## 独立的显式旧 PLY warm start

此实验位于迁移副本的 `runtime/explicit-old-ply-warmstart-final/`，具有独立 dataset、profile、命令记录和输出。通过当前受检 BrushAdapter 和固定 DX12 device 执行；使用旧匹配 COLMAP 数据集保持旧模型与相机的坐标帧，完成的生产迁移结果保持独立。

显式复制旧第 1000 步 PLY 为 `init.ply`，12719 点、SH0，从 1000 训练至 1100，输出有效 PLY 为 13782 点。记录 `optimizer_state_restored=false`：输入只有几何 PLY，协商的引擎语义为 `ply_warm_start_optimizer_reset`，未输入任何优化器 checkpoint。

同一个真实旧 PLY 还验证了两个执行前拒绝路径：

- 将限制设为 12718 点，返回 `E-1402 / Checkpoint Exceeds the New Gaussian Limit`，源 PLY 不变，未写下采样模型。
- 保留 `init.ply` 而请求第 0 步 fresh attempt，返回 `E-1403`，防止静默导入。

实验前后的生产 profile、训练 fingerprint 和 scene 保持不变。现有生产 UI 未开放跨引擎 checkpoint 复用入口；本实验不能充当该 UI 功能已实现的证据，也不宣称跨模型质量或收敛等价。

## 匹配旧核心的回退验证

独立 `rollback-fixture` 链接同一份冻结基线 crates，使用原完整旧包，实际打开 `rollback-baseline` 副本，检查旧包身份、有效 PLY、六个 checkpoint、源照片和旧的无 profile 语义。

原基线的 `MediaValidation` 按设计重新执行；其余 11 个计算阶段实际缓存复用。旧 scene 与六个 checkpoint 哈希不变，锁释放，所有阶段结束。它证明匹配旧核心和完整旧包能够继续使用保留的旧项目副本；未把 Windows1 新训练 attempt 交给旧引擎解释。

## 外置 driver 修正与证据边界

所有 driver 均在 ignored 目录，源码、Cargo 锁及 exe 各自记录哈希。两个验收驱动问题保留了原始二进制、源码、日志和结果：

1. `driver-history/migration-initial/`：生产升级完成并通过断言后，实验命令记录因 `CommandSpec.env` 的 `OsString` JSON key 序列化失败。修正为明确字符串键，随后从已完成升级状态继续独立实验，没有重跑生产训练。
2. `driver-history/rollback-initial/`：初版错误要求全部 12 阶段均为 `Skipped`。按实际基线行为改为媒体重新验证、另外 11 阶段缓存，最小复验通过。早先失败结果仍保留。

主要证据均位于 `target/windows-rollback-20261030-01/`：

| 文件 | 范围 |
| --- | --- |
| `core-migration-rollback-summary.json` | 最终分项状态与证据哈希索引 |
| `source-input-inventory.json`、`app-provenance.json` | 原 935 输入、构建、旧 app 的强来源 |
| `verify-old-pack-native.log`、`verify-old-pack-relocated-system-path.log` | 旧完整包清单、哈希及实际 CLI 版本 |
| `legacy-pipeline-evidence.json`、`legacy-run-context.json` | 旧完整链路和并存 viewer 边界 |
| `preserved-project-copies.json` | 三份初始副本的 210 文件清单 |
| `migration-source-inputs.json`、`windows1-upgrade-evidence.json` | 当前核心来源及实际安全新 attempt |
| `migration-invalidation-observed.json` | 重建中的 journal 与旧 scene 实际观察 |
| `explicit-old-ply-warmstart-evidence.json` | 独立导入、限制拒绝及产物保全 |
| `rollback-cache-final-evidence.json` | 匹配旧核心的最终回退验证 |
| `migration-final-driver-provenance.json`、`rollback-final-driver-provenance.json` | 最终驱动来源；早先版本在 history 中 |
| `legacy-native-final-verification.json` | 后续原生旧 GUI 的独立只读核验、文件保全和实际 KnownFolder 记录 |

`core-migration-rollback-summary.json` 是 GUI 开始前的核心验收快照；后续原生结果由独立 receipt 记录，旧历史文件不改写为已包含 GUI 验收。

## 独立 Legacy Validation 应用与原生只读验收

为后续原生 GUI 验收，使用原 935 个输入及已验证前端产物，额外生成仅含三个覆盖键的配置：`identifier=com.metorigin.splat.legacy-validation`，`productName` 与 `mainBinaryName` 均为 `MetOrigin Splat Legacy Validation`。覆盖文件位于 `legacy-validation/tauri.overlay.json`，原源码配置不改；构建复用隔离 release 缓存，通过该版本 Tauri 原生支持的 `TAURI_CONFIG` JSON merge 编译。

独立命名应用构建及来源核对通过，产物为 `legacy-validation/MetOrigin Splat Legacy Validation.exe`，SHA-256 `111a1c0c6944d4d223727735b92bfb93832cc148d33e865b7514630ab267f4c8`。实际 PE 的 ProductName / FileDescription 为独立名称，exe 中已观察到独立 identifier；935 个原始输入和 57 个前端产物构建后仍逐哈希一致。`legacy-validation/provenance.json` 绑定生成配置、原源码清单、前端产物和新 exe。旧完整包随它放在 `resources/`，该新位置的仅 System PATH 清单/哈希和五类实际 CLI 版本检查通过，不替换正式应用或默认包。

构建阶段未启动 GUI。随后 root 实际启动了这一精确 exe：PID 49860，创建时间 `2026-10-30T16:30:25.2208502Z`。在旧完整包旁、仅 System PATH 环境中打开 `rollback-baseline` 副本，原生 viewer 显示 James 模型、21788 点、100% 注册率、0.247 px 和六个检查点；进入 SuperSplat 后实际显示同一个 21788 点场景，无编辑、无保存地返回 viewer，再通过原生标题栏正常关闭。

原生交互证据在 `target/windows-native-final/`：`legacy-launch.json` 及 `uia-legacy-viewer-loaded.json`、`uia-legacy-editor-loaded.json`、`uia-legacy-viewer-returned.json`。三份 UIA 均绑定上述 exe SHA-256 和 PID。独立核验器不操作 GUI，也不重跑训练。

关闭后的 `legacy-native-final-verification.json` 和 `target/windows-native-final/normal-close-process-final-snapshot.json` 给出：

- 原生 unsandboxed CIM 成功读取 409 个进程，精确启动身份已退出；当前父子关系及专属 exe / WebView profile 查询没有存活匹配。它没有把沙盒空结果当作退出证明，也没有虚构关闭前未采样的后代 PID 清单。
- 935 个原始源码输入和 57 个已验证前端产物逐哈希不变；原始项目及 `baseline-preserved` 各 210 个文件全部不变。
- 回退项目的初始 210 个文件仍全部存在。40 张源照片、scene 和六个检查点共 47 项，与核心回退结束 receipt 所证明的身份一致，scene 保持 `ec3e78…`。只有 `project.json` 与最初副本不同；核心媒体验证此前已经允许更新状态，不能把它与最初副本的差别直接归为 GUI 修改，也未宣称其元数据有独立的 GUI 前后全字节快照。
- 实际 Roaming KnownFolder 下观察到 `com.metorigin.splat.legacy-validation/recent-projects.json`，独立命名空间已物化。与 `formal-knownfolder-after-final-video.json` 基准相比，正式 `com.metorigin.splat` 的 `settings.json` 和 `recent-projects.json` 均仍为 absent。范围限于基准中这两个文件，不扩大为整个 AppData 未变的声明。

隔离证据来自实际 identifier 目录与正式文件回检，不依赖 `APPDATA` / `LOCALAPPDATA` 环境变量代替 Windows KnownFolder。通过范围是旧项目打开、viewer、只读 editor 往返及正常关闭；旧编辑修改、旧编辑保存和该旧应用的其他生命周期故障路径仍未测。
