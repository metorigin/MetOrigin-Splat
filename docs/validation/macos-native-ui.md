# macOS 原生桌面验收记录

最新进展（2026-10-28）：当前 Release 候选仍为 `a2146f95`／`build.OX71fC`。生产修复与先前六轮复测后，同一包又完成预先限定的六轮 VM 分类诊断。13 张原图／AX 独立审查通过，六次均显示 614,263 高斯及可辨鞋／地毯；正常 ⌘Q 后八个精确实例均为 ESRCH，439 个测试副本文件不变。490 样本压力均 normal，系统 swap used 全程 1460.38M；WebContent 增长主要落在 WebKit Malloc／Untagged 分类，尚未建立分配归属或泄漏结论。**M3 内存与完整 M4 仍未通过**。详见[新诊断收尾](../../target/macos-m4/native-orbit-category-20261028/native/closeout.json)与[资源分类及边界](macos-m3-resources.md#2026-10-28-unchanged-release-vm-category-diagnostic)。上一轮 460 样本的压力／swap 未知状态保留，不由新数据补写。真实睡眠继续暂留。

本记录是当前 Apple M1 Pro / 32 GB / macOS 27.0.1 的原生验证证据，各节分别注明开发构建或 Release 候选，不代表 macOS 15、16 GB 机器、干净机或 Windows 回归已通过。

最新分类诊断的[操作记录](../../target/macos-m4/native-orbit-category-20261028/native/root-native-observation.json)限定为同一授权 Objectron 副本的 Spark／项目中心往返，未进入编辑器、保存或生成。末次 Home 自然窗口为 160.395 秒／80 样本，类别工具在相应截图之后单列执行。[画面审查](../../target/macos-m4/native-orbit-category-20261028/native/independent-native-visual-review.json)144 项通过，[退出与完整性审查](../../target/macos-m4/native-orbit-category-20261028/native/independent-exit-integrity-review.json)39 项通过；应用 OS 退出码未知，采样器退出 0。这些限定结果不代替原生混合编辑器、压力／context-loss、Dock、离线 Finder 或目标环境验收。

当前候选已修复此前 debug 诊断定位的监听器清理机制，但未取得 M3 内存或完整 M4 通过。旧 `ee0f0bea`／`6a5c7be6` 的原生保留发现按原构建保留，不由模块测试豁免。此前 `0f85289e` 的三格式图像保存、点噪修复复核及取消结果仍绑定其原构建，见[限定原生验收](#2026-10-280f85-稳定图像捕获与限定原生验收)。旧 `6095` 的画质失败保留为历史事实；当前仍是内部 Alpha，`m3_memory_accepted=false`、`m4_accepted=false`、`public_release_ready=false`。

此前 `0f85289e` 的六次预览／编辑器往返 UI 与退出验证已完成，但新增 WebKit 归属采样发现同状态内存增长，内存稳定性未通过，见[资源专项记录](macos-m3-resources.md#2026-10-28-six-viewer-cycles-and-explicit-webkit-attribution)。这不撤销该构建图片导出的限定结果，也不构成完整 M3/M4 通过。

## 2026-10-27：检查点查看与 SuperSplat

使用真实 Tauri `.app` 的 WKWebView，通过原生文件夹对话框打开 M1 照片生成工程（中文及空格路径）。没有用浏览器预览替代原生操作。

- 应用可执行文件 SHA-256：`69f34a5e342e96b11c29ba6aa6368166dfe0b4985478e2900769f61c10f6abfc`。
- 输入为 [M1 验证记录](macos-m1.md) 中的 40 张 CC0 照片工程，300 步、SH0；质量仅是链路 smoke。
- 原生结果面板显示 14,599 个高斯，实际画面可见；整体视角切换、拖动旋转均改变画面。
- 创建独立工程副本，改变项目 ID 和名称后进行编辑；原始工程生成的 `scene.ply` 保持原 SHA-256。
- 内嵌 SuperSplat 3.0.1 加载全部 14,599 个高斯。位置 X 设为 0.1，⌘Z 恢复 0，⌘⇧Z 恢复 0.1。
- 点击保存显示“模型已保存”。返回结果页后重新加载成功。
- 保存后逐个检查完整 float32 payload：所有数值有限，顶点数不变，文件内容改变。编辑器坐标换回 PLY 后 X 均值变化约 -0.1，Y/Z 不变。

原始文件 SHA-256：`e7c5387a5461b679f9364273b7cede4ef01a582e7ef328fb4efc8e64905ae275`。
编辑副本 SHA-256：`d0e94acce8c92d8e17316794e15ef7f5a4fd275680bd2d4e64ea5b9501db820e`。

本地证据在忽略目录 `target/macos-m3/native-ui/`：`checkpoint-initial.png`、`checkpoint-overview.png`、`checkpoint-orbit.png`、`editor-saved.png`、`editor-save-evidence.json`。截图只用于原生显示证据；没有据此宣称训练质量或内存档位验收。

## 2026-10-27：原生向导到完整生成

在同一台开发机，使用应用向导创建独立的中文路径工程，导入固定 CC0 40 张照片。应用可执行文件 SHA-256 为 `f3aabba27b8011bbd4ca65d231900d6553f257126862bda135c11b0b7f576626`，Brush 为 `1.0.0+metorigin-macos.5`。该构建包含初版实时预览与内存保护，但早于最终退出 supervisor 和压力恢复唤醒修复。

- 原生预检通过真实 Metal 前向／反向计算，并识别按需实时预览协议。
- 采用 fast 档实际参数：3,000 步、SH0、1,280 像素、6 线程、1 GiB 图像缓存、150 万高斯上限。
- 全部 12 个阶段完成，40/40 图像注册，35,355 个稀疏点，重投影误差 0.312 px。
- 最终生成 155,469 个高斯，checkpoint 大小 8,706,768 字节；训练阶段记录耗时 157,955 ms。最终 PLY 通过生产流水线的完整校验及发布。
- 界面在训练期间显示内存保护释放预览，训练继续完成；本次没有取得原生 live 帧渲染成功证据。完成后旧构建仍显示释放提示，因此不能把这次运行作为预览恢复验收。
- 完成后 ⌘Q 正常退出。训练期间暂停、恢复、退出仍须在最终构建复测。

本地工程为 `target/macos-m3/native-ui/M3 原生实时与恢复.splat-project`，保留 `project.json`、冻结 profile、训练结果及事件日志。截图与 AX 文本为 `native-run-complete-pressure.{png,ax.txt}`；进程资源记录见 [M3 资源验证](macos-m3-resources.md)。这是 debug 构建，且同机存在其他开发任务，不是正式性能基准。

## 2026-10-27：修正内存观测后的实时预览、暂停和恢复

应用可执行文件 SHA-256：`2f51d56def6da6021981a0909df5289cb717510691a2826aa10478ab42c1070f`。引擎仍为 `.5`；此构建包含进程 supervisor 与原生 headroom 修复，早于下述 AppKit 退出及显式检查点恢复修复。

- 重新打开完成工程后，原生 WKWebView 正常显示 155,469 个高斯，见 `headroom-fixed-final.png`。
- 实际训练显示连续 live 帧：1,000 步时 63,575 个高斯，1,227 步时 78,089 个高斯；会话 `01a17ba4-1394-7d72-bd8c-8ae47f95f68a` 的 ACK 与 revision 持续前进。截图及 AX 见 `native-live.{png,ax.txt}`。
- 点击暂停约一秒内完成；持久状态为 `paused`，`.lock` 已释放，未残留 Brush/COLMAP 进程，见 `native-paused.png`。
- 点击继续后日志明确加载 `init.ply`，从 1,000 步、63,575 个高斯 warm start；优化器状态重新初始化。原生帧随后推进至 1,069、1,146 等步，见 `native-resumed.png`。

本次也发现两个失败，均不能计作通过：

1. 从已经完成的工程显式选择 500 步检查点时，旧 completion 标记未撤销，导致从零训练。修复以有版本的持久恢复意图保存所选检查点及原始 fingerprint，归档后续检查点并撤销完成证明；中断后可恢复。最终构建的原生复测另记。
2. 训练中按 ⌘Q 后应用退出，但 Brush 子进程成为孤儿继续执行，工程仍为 `running`。原生菜单由 AppKit `terminate:` 处理，绕过了仅依赖 Tauri `ExitRequested` 的门禁。新增 delegate 的 `applicationShouldTerminate:` 接入统一暂停、落盘和进程组清理。失败现场在 `quit-failure/`；旧 Brush 随后自然结束，没有将其认作安全退出成功。修复后的真实退出需再次验证。

此前完整生成结果保留在 `completed-native-run-backup/`，故失败复现与恢复测试不替代或覆盖原完整生成证据。

## 2026-10-27：原生恢复与安全退出复测

应用可执行文件 SHA-256：`acdbd139323f755ae82ef904cc04a0353c088526606d11a40ed546ef8f866003`，开发链接仍为 Brush `.5`。此构建包含 AppKit 退出回调、原子项目锁、遗留活动状态恢复及进程清理失败的重试所有权。此前工作区门禁为 666 通过、12 个环境专用测试忽略，fmt/Clippy 通过。

- 通过正常项目入口打开上次 ⌘Q 失败的现场：无活跃旧持有者后持久化为 `paused`，两处 current_stage 均清空，`.lock` 释放；`.lock.guard` 按设计保留。见 `stale-recovered.{json,png,ax.txt}`。
- 使用完整生成备份的独立副本，原生选择 500 步。仅保留选中 checkpoint，后续 5 个文件归档；fingerprint 保持原值、completion 清空、恢复意图正常移除。日志明确 `Resuming geometry from iteration 500`；真实 live 从 514 步继续推进。见 `native-restore-500.json`、`restored-500-live.{png,ax.txt}`。
- 训练中于 05:29:17.356 UTC 按 ⌘Q，进程日志在 05:29:17.494 记录结束，05:29:17.512 记录安全停止；两秒采样在请求后 1.959 秒已观察不到应用。随后独立进程检查没有应用、Brush 或 COLMAP，项目已暂停、锁释放，500/1000/1500 checkpoint 保留。见 `native-cmdq-{observation,result}.json`、`cmdq-brush_training.log`。
- 重开应用后成功从 1,500 步 warm start；切换至其他工程后再返回，运行工程可只读打开并恢复实时帧。见 `after-cmdq-resumed.{png,ax.txt}`。Dock 自动化入口发生工具超时，因此没有取得 Dock Quit 的独立验收证据；不能将该超时解释为应用故障或通过。

最终恢复训练完成后又发现下游缓存缺陷：新 checkpoint 为 149,219 个高斯、8,356,768 字节，而 `output/scene.ply` 仍为先前 155,469 个高斯、8,706,768 字节，SHA-256 为原 `d4279d26b4ca48b3043287989c835c0d2859a68d32b252e5105ef0723c55d4ea`。这不是正确完成的导出。恢复事务现将旧训练结果、校验报告、发布 PLY 和 manifest 一并保存在恢复归档，撤销有效目录里的旧缓存；另修正默认预览对完成状态的跟随。回归覆盖归档冲突/重试及实际下游三个 stage 重新生成，新构建仍须复测最终 PLY 与新 checkpoint 一致。此处的 ⌘Q 与 warm-start 通过不掩盖导出失败。

## 2026-10-27：恢复后的最终导出一致性通过

应用可执行文件 SHA-256：`8f02d365958d26e627a834de2945ef2fa7bbd9725bcd0edad1448baebd136a6b`，开发引擎仍为 Brush `.5`。此版本前的工作区验证为 Rust 668 通过／12 个环境专用测试忽略，前端 176 通过，fmt、Clippy、TypeScript 和 ESLint 均通过。

使用新的完整生成独立副本，从原生 Checkpoint 管理器恢复至 2,500 步。旧 3,000 步文件、训练结果、校验报告、scene.ply 和 manifest 均归档，原始缓存路径不存在；旧输出 SHA `d4279d26b4ca48b3043287989c835c0d2859a68d32b252e5105ef0723c55d4ea` 在归档中保留。

继续后实测从 2,500 步 warm start，完成 3,000 步；ModelValidation、Export 和 PreviewGeneration 三个阶段均实际执行为 `completed`。新 checkpoint 和最终 `output/scene.ply` 同为 8,567,496 字节、152,982 个高斯，两者 SHA-256 完全一致：`d39b11b54b3487282744895e451238239526196aef4bb0a3825cdf1d89ee6e54`。manifest 记录相同顶点数、文件大小及 resumed_from_iteration=2500；项目完成、锁释放。

原生界面自动切换为最终高斯渲染，质量卡片与画面同显 152,982 个高斯，不再留在训练实时视图。证据为 `restore-export-archive-evidence.json`、`restore-export-final-evidence.json` 和 `restore-export-final.{png,ax.txt}`。此前有旧导出缓存缺陷的 release DMG 已标记为未通过最终功能验收，不能以它替代修正版的应用包验证。

## 2026-10-27：未保存编辑时取消与丢弃退出

在上述 SHA-256 为 `8f02d365958d26e627a834de2945ef2fa7bbd9725bcd0edad1448baebd136a6b` 的 debug 构建中，用内嵌 SuperSplat 打开 152,982 个高斯的最终结果，将位置 X 从 0 改为 0.1，保持未保存。按 ⌘Q 后显示离开编辑确认；选择“继续编辑”返回编辑器，位置 X 仍为 0.1。再次 ⌘Q 并选择“丢弃并离开”后，独立应用清单显示 `isRunning=false`。检查退出没有调用会重开应用的 AX 观察接口。

退出后磁盘 `output/scene.ply` 的 SHA-256 仍为 `d39b11b54b3487282744895e451238239526196aef4bb0a3825cdf1d89ee6e54`，测试变换未写入原模型。证据为 `editor-quit-prompt.{png,ax.txt}`、`editor-quit-cancel.ax.txt`、`editor-quit-original-hash.json` 和 `editor-quit-result.json`。这验证了原生未保存编辑的取消/丢弃退出分支；编辑器正常保存的证据见前文。

## 2026-10-27：Release 候选首次原生预检失败

完整构建脚本生成的候选主程序 SHA-256 为 `f7eb82fd1221b22e98e8021a66767c50a99b6007e36b2e933f7446233ddf8549`。物理复制至 `target/macos-m4/原生 发布验证/MetOrigin Splat.app` 后，完整 bundle 清单与签名校验通过，清单 SHA 为 `c02029fc34e2867c29d827d3ad6ce5b380b0d13636aab5294adcc337aecb0ae2`。

原生向导成功识别 Mip-NeRF 360 room 的 311 张独立原图，0 张损坏、0 个忽略文件。但运行时预检拒绝 `colmap/lib/libgcc_s.1.1.dylib`，报告不是 arm64 Mach-O 动态库，导致内置引擎均不可用；Metal 计算与训练尚未开始。该文件实际为只有一个 arm64 slice 的 fat 容器，内部是 `MH_DYLIB`；打包脚本支持该容器，而 Rust 运行时校验此前只支持 thin Mach-O。这是运行时兼容缺陷，不能计作中型负载或最终包功能通过。

证据保留在 `target/macos-m4/release-311-balanced/preflight-dylib-rejection.{json,png,ax.txt}` 和 `resources-01-summary.json`。修正候选需重新走实际引擎定位、构建和原生预检。

## 2026-10-27：大小写敏感卷启动与版本预检缺陷

包含 fat 容器修复的候选主程序 SHA-256 为 `2968a3a986d71e5c8f647b38e6e4fee6b69cc7e2a5eb5910e584e99683cb3ee3`。其物理副本位于独立 APFS 大小写敏感稀疏磁盘映像的 `应用 中文 空格 🧪/MetOrigin Splat.app` 中，复制后的完整 bundle 清单 SHA `b6a0598455dfc4222819cf5f28d6622701275b8cd39ed7cb88eeb24fbcb07445` 与签名均通过。该映像只模拟卷条件，不是外接物理盘；准备记录在 `target/macos-m4/path-matrix/case-sensitive-20261027T062450Z-9f8c52a8/preparation-result.json`，实际 `a`/`A` 文件各自读写且 inode 不同。

应用正常启动、导入 311 张原图，并通过内置 Brush `.6` 在 Apple M1 Pro 上的真实 Metal Gaussian 渲染和反向传播检查。随后版本预检阻断了创建：桌面 FFprobe 检查跳过 `n8.1.2`，误读后面的编译器 `21.0.0`；Brush 清单和实际均为 `brush-cli 1.0.0+metorigin-macos.6`，但通用版本匹配器错误拒绝完整字符串。不能据此认定引擎版本真的不同，也不能将 probe 通过计作完整训练成功。

原生证据为 `target/macos-m4/release-311-balanced/preflight-version-rejection.{json,png,ax.txt}`。`resources-02-summary.json` 明确记录此次有真实 GPU probe，但 SfM 和 311 图训练尚未开始。选择 ⌘Q 后应用清单确认已退出。后续修正版须复用 FFmpeg adapter 的正式版本解析，并验证 Brush 构建标识，再重新进行最终包验收。

两项修复随后通过真实嵌入包回归：同一个应用生产预检主体先在旧实现上失败，再在修正后通过；发布模式定位、禁用完整性缓存、2,999 个文件校验、三引擎 adapter 检测、版本比较和 `PendingWork` 清空均有记录。FFprobe 正确识别为 8.1.2，Brush 完整 `.6` 标识相等通过，三个诊断字段均为 null。此验证没有启动原生窗口或 GPU，不能替代后续原生工程流程。证据为 `target/macos-m4/runtime-app-version-20261027.dLXFpv/summary.json`；相关 10 项应用测试、5 项 FFmpeg adapter 测试、32 项硬件测试、fmt 和定向 Clippy 通过。完整打包脚本已增加真实应用预检门禁。

## 2026-10-27：311 图 Release 原生负载进行中

应用主程序 SHA-256 为 `8656d4e02678cd6d2f30fb92a2c19a26a5ef38ada8af93cb3f93b9b0bb9d03a3`，包含上述校验修复，以及根据新路径实测耗时为 macOS COLMAP help 设置的 45 秒单次启动期限。该候选完整构建、真实定位器与应用版本预检、签名和 DMG 比对通过。运行副本的完整清单 SHA 为 `6bebd19a3f770c3f60ce1af796bac26da3e3e05b16159f735a69dc4541baf188`，从大小写敏感映像内的 `应用 版本与启动修复 🧪/MetOrigin Splat.app` 启动。

原生向导导入全部 311 张 room 原图，选择均衡预设，在同卷 `工程 中文 空格 🧪/M4 房间 Café 311 🧪.splat-project` 创建新工程。项目 ID 为 `01a17c42-0cbd-75b0-bb61-6d041b54bfe9`，run ID 为 `01a17c42-215a-72a3-ab8e-a20b5ffabd91`。冻结 profile 为 7,000 步、SH1、训练长边 1920 px、1 GiB 图像缓存、150 万高斯上限、6 线程、LOD0；物理内存 32 GiB，16 GiB 是训练策略预算，不是测试机内存或分配硬上限。原图逐张哈希与 fixture 相同，总计 971,803,336 字节。COLMAP 实际特征提取输入仍为 3114×2075，不能将训练长边当作 SfM 输入尺寸。

截至该记录，素材准备完成，特征提取于 07:28:37–07:34:18 UTC 完成 311/311 图并正常退出，匹配正在进行，训练及最终输出尚未完成。特征提取出现正常/偏高压力切换；原生资源面板显示实际参数、独立 RSS、未知 Metal 工作集和“已暂停新预览帧”的策略提示。本阶段尚无 live 模型，因此该提示不证明训练中完整的压力释放/恢复循环。资源与素材身份见 `target/macos-m4/release-311-balanced/resources-03.jsonl`、`project-03-provenance.json` 和 `feature-resource-panel.{png,ax.txt}`。

后台匹配期间打开旧 M1 照片工程，14,599 个高斯正常渲染；返回后匹配继续、锁保持。关闭主窗口再激活应用后，应用 PID 21300 和 COLMAP PID 22827 均未改变，工程仍运行；没有把重新启动应用误认为窗口恢复。证据为 `background-switch-*`、`window-hidden-app-info.json` 和 `window-hide-reactivate.json`。激活使用 CUA 的明确 bundle 路径，不是 Dock 点击，也不是 Dock Quit 验收。

本轮发现两项显示缺陷：COLMAP 4.1 的逐图/分块日志未被旧 parser 识别，阶段内进度不更新；切回尚未生成 sparse 结果的运行工程时，前端提前请求结果并显示读取失败。对应修复与测试正在源码中准备，运行的 `8656d4e0` bundle 保持不变，负载结果必须继续绑定该构建。当前记录不能计为最终包所有原生关卡通过。

## 2026-10-27：311 图打包版本实时预览与 ⌘Q 恢复

上述 `8656d4e0` 候选的首个 global mapper 方案成功注册 311/311 图，得到 136,436 个点、1,257,911 个观测，平均重投影误差 0.679604 px；没有进入 fallback。去畸变正常退出，逐图 JPEG 重编码后，训练准备于 08:02:26 UTC 完成。训练使用全部 311 个视角、0 个评估视角，因此本次不提供 PSNR/SSIM。原生 WKWebView 在训练中持续显示房间模型，初始 live 会话为 `01a17c61-d736-7392-a2fe-3ac36c40727a`，见 `training-live-initial.{png,ax.txt,json}`。

08:05:23.574 UTC 在训练中按 ⌘Q。独立 250 ms 进程观察于 08:05:24.074 首次同时观察不到应用 PID 21300 和 Brush PID 26095（请求后约 0.500 秒，属于采样上界）。独立应用清单亦显示已退出，项目为 `paused`，根级及 pipeline 的 current_stage 均为空，`.lock` 已释放，live session 为 `running=false`。1,000 步 checkpoint 为 203,422 个高斯、18,715,541 字节，SHA-256 `2651ac000b9caf50aa3d3e23cbc19998a8bd05112be28634f480f2656cfec005`；退出前生产 CheckpointScanner 已将其列为有效恢复点。证据为 `cmdq-{request,result,process-observation,app-stopped}`、`cmdq-project-paused.json` 和 `cmdq-brush_training.log`。

重新启动同一应用副本后，PID 为 26672。原生“继续”创建新 run `01a17c67-f56f-7bb1-a324-de82cf1a68e8`；执行 profile 与原记录仅 run ID 不同。事件明确记录从 1,000 步恢复几何、优化器重新初始化，Brush 加载 `init.ply`，首次 refine 为 1,001 步。新 live 会话 `01a17c68-0ca9-7cf3-baad-cc1488c76ea7` 的帧继续推进，原生截图显示 1,402 步、250,370 个高斯。见 `execution-profile-04-resumed.json`、`resumed-live-metadata.json` 和 `resumed-live.{png,ax.txt}`。资源记录分成退出前 03 和重开后 04 两段，不能视作同一个持续存活的应用进程。

训练中切换到旧 M1 完成工程时，旧工程显示自身 14,599 个高斯，房间工程的 live 请求变为 `off`、revision 停在 30，而训练继续到 2,201 步。返回后同一训练会话恢复请求，revision 推进至 44、2,861 步。随后关闭主窗口，应用仍存活，live 请求再次 `off`；重新激活窗口后，应用 PID 26672 和 Brush PID 26857 均未改变，live 推进至 revision 62、3,421 步。此次激活仍使用明确 bundle 路径，不能替代 Dock 点击/退出的专项验收。证据为 `live-switch-*`、`live-hidden-*` 和 `live-reactivated-metadata.json`。

08:17:43 UTC 资源采样首次出现训练中的 `warning`。原生画面保留 3,988 步模型并显示“内存压力升高 · 预览暂停 · 训练继续”，request 为 `off`，训练继续保存 4,000 和 5,000 步检查点。08:23:12 压力短暂回到 normal 后，未操作 UI，日志重新发布 5,251–5,299 步的 live 帧；随后截图确实显示已更新至 5,287 步。08:23:32 又回到 warning，新快照再次暂停。因此截图 `training-pressure-repeat-warning` 捕获的是第二次 warning，不能误称截到了正常状态。该过程验证实际训练期间的暂停新帧/自动恢复循环；未出现 critical，也没有据此声称验证了释放 GPU 模型的分支。证据为 `training-pressure-warning.*`、`training-pressure-repeat-warning.*`、`training-pressure-cycle-01.json` 与 `resources-04.jsonl`。

08:32:35 UTC 工程完成，全部 12 个阶段结束，ModelValidation、Export 和 PreviewGeneration 均实际执行成功，锁释放、live session 停止。最终 checkpoint 与 `output/scene.ply` 同为 737,307 个高斯、SH1、67,832,961 字节，SHA-256 一致：`3d96938cbe61664ba8c0b76d11b633599194357b86aed60fa25a0bfb42c210e2`。独立全 PLY 浮点有限值、属性/步长/长度校验通过，manifest、训练结果及 completion 中的文件哈希一致；训练结果记录总目标 7,000、resumed_from_iteration=1000、优化器未恢复。`duration_ms=1381894` 只表示恢复后的 Brush 进程段，不能当作首次导入至完成总耗时。最终原图复核确认外部 fixture 和项目 source 的各 311 张照片均与固定 manifest 哈希一致。

原生完成过渡期间暴露了显示语义问题：08:33:08 的画面仍保留 6,094 步、703,793 个高斯的旧实时帧，但标签已是“高斯渲染”。没有点击按钮或切换工程，随后自动加载的最终模型显示 737,307 个高斯且无 step 标记，界面更新时间为 08:34:37 UTC；08:35:23 的 AX 与随后截图确认完成。因此这是等待最终加载时旧帧标签不准确，不能记录为永久加载失败，也没有证据将等待耗时归因于某个内存上限。当前最终模型的原生显示已得到证据，过渡标签修复须在新候选复测。分别保留 `final-stale-preview.*`、`final-render.*` 和 `final-native-render.json`。

上述文件均位于忽略目录 `target/macos-m4/release-311-balanced/`，独立校验为 `final-result.json`，关键元数据、日志及最终 PLY 已另存 `completed-artifacts/`，不依赖映像继续挂载。本轮另发现 CPU 百分比每次重新建立 sysinfo 基线，通常显示累计平均而非相邻轮询区间值；截图中的 CPU 数字不作为实时负载证据。内存压力、swap 与独立 RSS 观测不使用该 CPU 字段。修正采样方式、COLMAP 进度、稀疏预览和最终加载标签后仍需重新验证和打包；本次负载通过不自动绑定到后续候选。

## 2026-10-27：显示修正版候选的只读目录预检缺陷

候选主程序 SHA-256 为 `006cfe46d2d319f414be08d24d56f3a95a2909742b113c736c1cb4d93d6ea7ac`，完整 bundle 清单 SHA 为 `c5841dfc086a780056d0d61f58e55bb2d449ee743969f8251ec47bc4769c7271`。完整构建和只读 DMG 内嵌清单/签名校验通过后，将应用物理复制至原大小写敏感 APFS 测试映像的中文、空格和 emoji 路径；副本清单及签名一致，进程 PID 40181 的可执行路径也独立确认。

⌘N 打开原生向导，固定 James40 工程视频被正确识别为 20 秒、960×640、2 fps、40 个源帧。快速预设与 FFmpeg/FFprobe、COLMAP、Brush `.6` 版本及真实 Metal 计算预检均通过。该工程视频由照片编码，不是实拍短视频验收。

选择专用空目录 `只读目的地 🧪` 后，界面错误显示“新目录可用”，且创建按钮可用。独立文件系统检查确认目录为 0555，所有者及调用者 UID 均为 501，`os.access(W_OK)=false`，实际独占新建探针返回 errno 13。点击“仅创建项目”后应用安全拒绝，显示 `UI-PROJECT-CREATE`；目录仍为空，源视频 SHA-256 不变，没有启动生成流水线。随后 ⌘Q，独立应用清单确认已退出。

问题在预检只查询磁盘空间，没有验证写入能力；创建时拒绝不能弥补此前误报。证据位于 `target/macos-m4/final-native-video-20261027/` 的 `readonly-preflight-accepted.*`、`readonly-filesystem-evidence.json`、`readonly-create-rejected.*`、`readonly-result.json` 及 `readonly-app-stopped.json`。后续修复须重新打包并复测；本候选的离线核心成功另见 [M1 记录](macos-m1.md)，不能据此标记原生视频全流程通过。

## 2026-10-27：bb13 只读目录、工程视频与最终渲染

完整构建候选主程序 SHA-256 为 `bb13a6ee182b825216b05e7f98fe121f33a3fc319e34e2b3ef25d7e275300ded`，bundle 清单为 `5a0c637181b53257a55849a65a0ddcc059b7f02744ef6c852fbfbbc5cb8fb664`。打包及门禁见 [引擎包记录](macos-engine-pack.md)。原生应用运行于大小写敏感 APFS 映像内的中文、空格和 emoji 路径；这是本机模拟卷，不是物理外接盘。

同一个 0555 空目录现在被明确判为“项目目标目录不可写”，两个创建按钮均禁用。改选可写目录后预检恢复、允许创建，源视频和只读目录内容不变；测试后目录权限恢复为 0700。证据为 `target/macos-m4/final-native-video-readonlyfix-20261027/readonly-result.json`、`readonly-preflight-rejected.*` 和 `readonly-fixture-cleanup.json`。上一候选目录内误写的同名截图来自旧应用，已在新收据中明确排除。

原生向导创建新项目 `01a17cc0-8c53-7f21-a1bd-0037943b04b7`，run 为 `01a17cc0-98f4-7ee0-a958-21ca198810c8`。输入 James40 工程视频 SHA-256 为 `b5959e9d02dd4b7680e6735f68a73cd45cc0ea86770a1ac71c549c7b6e9cdf75`，20 秒、960×640、2 fps、40 源帧；它由照片编码，不能替代真实拍摄 100–200 抽帧短视频验收。保持原生快速预设：3,000 步、SH0、训练长边 1,280、COLMAP 长边 2,560、6 线程、1 GiB cache、最多 150 万高斯。

40/40 帧注册，13,204 稀疏点，重投影误差 0.230927 px；12 个阶段完成、锁释放、live session 停止。最终 checkpoint 与 scene.ply 均为 81,368 个高斯、4,557,109 字节，SHA-256 `9f61ea25b93abdb6f681de84c8a249cd5f6f9783863684f3d65ce5241e8939e8`；全 PLY、manifest、result 及 completion 一致，原素材哈希不变。六个检查点为 0500 至 3000。Brush 进程计时 130,155 ms，项目创建至完成 177.641 秒，两者统计范围不同。原生实时截图显示真实模型；完成后显示 81,368 高斯且无 iteration 标记。

审计为该目录 `final-result.json`，27 份关键文件保存在 `completed-artifacts/`。原生截图/AX 为 `training-live.*`、`completed-native.*`。特征提取和匹配仅约 4.5 秒、2 秒，本轮未截到它们运行中的原生进度；也未截到 sparse 尚未发布时的占位状态，不能据日志和自动回归宣称这些原生瞬间已验证。稀疏产物发布后的点云、40 个相机和 13,204 点已在下述恢复副本中确认。资源分段见 [资源记录](macos-m3-resources.md)。

## 2026-10-27：bb13 已完成工程恢复、编辑与 Unicode 路径

从上述已冻结基线建立完整副本，仅改变 project ID/name。原生选择 2,500 步并先停在 paused：保留 0500–2500，旧 3000 和四个发布文件全部归档且哈希与副本原件一致；有效目录内旧 result、validation、scene 和 manifest 消失，后三个 stage 为 pending，原 fingerprint 保留而 completion 清空。核查后点击继续，新 run 为 `01a17cca-6802-7c92-a17c-11479cae1100`，明确从 2500 warm start 至 3000，优化器重新初始化。

最终 79,786 高斯、4,468,517 字节，checkpoint、scene、validation、manifest 和 completion 一致，SHA-256 `7d9370e4a9cbb900bd20571d55e9c2cca9f2da599ba8fe62586bcf6bafda8397`；四个训练/下游阶段均有 fresh started/completed 事件，139 个上游文件哈希未变，锁释放。Brush 进程计时 24,402 ms。原生“打开 PLY”显示新模型及正确数量；本次没有捕获恢复训练中途的 live 帧。证据位于 `target/macos-m4/final-native-restore-bb13-20261027/`，包括 `selection-result.json`、`restore-final-result.json`、32 份 `completed-restored-artifacts/` 和 `restored-final-render.*`。

恢复暂停时另发现预览有效性缺陷：虽然旧输出已经正确归档、“打开 PLY”禁用，页面仍保留旧 81,368 高斯 GPU 模型并标作“高斯渲染”，“跟随当前阶段”也未切走。选择稀疏阶段后可正常显示点云；继续后的新导出数据审计通过。这是 UI 旧状态残留，不能用最终产物正确掩盖。`paused-after-restore.ax.txt` 保留复现证据；修复及新包原生复测进行中。

编辑使用另一个独立副本，原始生成工程保持不变。SuperSplat 3.0.1 加载 81,368 个高斯，将 X 从 0 改为 0.1，⌘Z 回到 0、⌘⇧Z 回到 0.1；保存显示成功，返回结果页和再次进入编辑器均正常加载。完整逐点审计处理导出重排后确认 81,368 个顶点、SH0、14 个属性和全部有限浮点值；X 平移约 −0.1（编辑器坐标转换），最大误差 9.54×10⁻⁸，其余 13 属性逐位不变。保存后 PLY 为 4,556,969 字节，SHA-256 `eb0dcef77bccd63559c2a1d6e3b5bbc8a68776daeb42cad62dafa5f3732694f6`。大小减少 140 字节来自移除的四条 Brush 头部注释，不能声称所有元数据原样保留。

重开编辑器后另设 X=0.2，未保存时 ⌘Q 触发确认；“继续编辑”保留 0.2，再次退出选择“丢弃并离开”，独立应用清单确认 stopped，磁盘 PLY 仍为保存后的同一哈希。证据位于 `target/macos-m4/final-native-editor-bb13-20261027/` 的 `editor-save-audit.json`、冻结前后 PLY、顶点映射、AX、`quit-app-inventory.json` 与 `quit-result.json`。生成 manifest 属于编辑前的训练产物身份，编辑后的 scene 单独记录。

最后在原生打开面板输入 `Café` 的 NFD 路径，系统正确解析为既有 NFC `Café` 工程；两路径同 device/inode，当前应用正常显示历史 311 图结果的 737,307 高斯。输出仍为旧候选的 SHA `3d96938cbe61664ba8c0b76d11b633599194357b86aed60fa25a0bfb42c210e2`。这里只验证新版读取/显示和路径解析，没有在 bb13 重新训练 311 图。证据为 `target/macos-m4/path-matrix/nfc-nfd-native-result.json`、`nfd-path-entered.ax.txt`、`nfd-open-initial.ax.txt` 和 `nfd-open-render.*`。

## 2026-10-27：6784 恢复后失效预览修复通过

候选主程序 SHA-256 `6784872d00056769cb4bd0c0f9e672b6c70ca46642b18e68120c568f08063919`，bundle 清单 SHA `9d84ed389860eb28eba662e71756f87c90e27d19d64857238172e43d891b4ec3`。只修改项目详情页及其测试：自动跟随在 paused/current_stage=null 时选择暂停训练阶段；固定导出或已移走检查点在确证缺失后卸载旧 viewer；正常最终模型尚未发布时保留当前训练 viewer。五个新增场景先复现问题后通过，完整前端 195 项、typecheck/lint/build/diff 通过，现有延迟最终加载测试保持通过。Rust、schema、引擎和核心数据处理未改；打包通过独立指纹绑定既有门禁。

从已冻结 bb13 视频基线复制新工程 `667e13db-83fd-4989-86af-4427d516e782`，仅改变 ID/name；没有将复制工程的创建时间伪装成新生成时间。新 app 物理复制到大小写敏感映像内的新路径，完整清单及签名一致；独立进程检查确认唯一运行的测试 app 为该副本 PID 55609。打开完成工程先显示 81,368 高斯，手动固定“导出”，再恢复至 2,500 步。

原生暂停页面现在显示“预览尚未生成”，旧高斯画面、数量及 viewer 均已消失，“打开 PLY”禁用。随后点击“跟随当前阶段”，显示 70,280 高斯及“训练未运行 · 保留最近画面”；完整 PLY 检查证实它是保留的 2,500 步 checkpoint，SHA `cc55f86e7228c25908c9bfa7669d57447f9383a29fae265f5f1f3d49b0a4df1f`。暂停态独立审计再次确认旧 3000 和四个发布文件归档、0500–2500 保留、下游 pending、无锁。

点击继续产生新 run `01a17cea-9ed9-7bb1-a1c8-0185c3b43c07`，原生捕获 2,726 步、74,886 高斯实时帧；没有继续操作预览，完成后自动显示 79,741 高斯、无 step 标记。新最终 PLY 为 4,465,997 字节、SH0，SHA `25a71896679dc0aff25538122f786fba9222e4e30fbb057f9a942fbe2a3f2ee9`；checkpoint、scene、validation、manifest、completion 一致，12 阶段完成、锁释放、live session 停止。139 个上游数据文件未变，旧归档完整。Brush 进程计时 38,334 ms，恢复几何不恢复优化器。

证据位于 `target/macos-m4/native-preview-invalidation-20261027/`：`native-ui-result.json`、`selection-result.json`、`restore-final-result.json`、`audit-execution-receipt.json`，以及 `pinned-export-invalidated.*`、`following-checkpoint.*`、`resumed-running.*`、`restored-final-render.*`；32 个完成文件另存 `completed-restored-artifacts/`。本轮证明固定失效源清除、点击跟随后显示所选恢复点、真实 warm start 和自动最终显示；没有观察未点击跟随的恢复瞬间自动选择或短暂旧帧加载标签转换，它们保留自动回归证据。没有重新执行初始解码/SfM，也没有在此候选重复整个编辑/NFD 验收；较早结果仍绑定其实际构建。

本轮结束后应用正常退出，独立应用清单确认 stopped；只读进程检查未见测试卷内进程，卷内五个工程均 completed 且无 `.lock`。10:37:13 UTC 仅卸载本任务的大小写敏感映像挂载点，退出码 0，原 sparseimage 保留。关键审计、日志与 PLY 已保存在映像外；`owned-mount-cleanup.json` 记录精确所有权与清理结果。再次读取完整工程或挂载路径中的历史 app 需重新挂载该映像，不能把当前不可见目录误当成产物删除。

## 2026-10-27：6784 Finder 启动与实拍方向缺陷

同一 `6784872d` 候选在 Finder 中选择 `.app` 后以 ⌘O 打开，独立进程核对确认 PID 58004 的实际可执行路径与 SHA-256；原生首页正常显示。证据为 `target/macos-m4/native-finder-20261027/result.json`、`launch-process.json` 和 `native-home.*`。此项仅验证当前开发主机的 Finder 启动，没有在该次启动禁网或运行完整流水线，也不是干净主机验收。

实拍素材来自 Google Objectron 官方 `shoe/batch-1/0/video.MOV`，原始录像长 23.796667 秒、714 帧、H.264、无音轨，54,499,118 字节，SHA-256 `30d0f636a458183aae5ca36a36343c99ed6254d4ebabf3df020376b070ff163f`。来源、官方 C-UDA-1.0 许可、下载头、元数据与哈希存于 `target/macos-m4/real-video-20261027/fixture-manifest.json`；仅作本地计算验证，没有发布素材。它是手机绕拍静态鞋子和地毯的真实视频，没有拼接、减速或重复帧。编码尺寸 1920×1440，display matrix 角度 −90°，显示尺寸为 1440×1920。

原生向导在 `sandbox-exec` 的 `(deny network*)` 下成功完成素材分析、真实 Metal 计算预检和工程创建。项目 `01a17d05-dae3-7662-bd32-eb7c18c51d72` 创建后正常退出，确认全部 stage pending 且无锁，再显式覆盖 `frame_fps=5`、`max_frames=150` 并重开；快速预设训练仍为 3000 步/SH0，不能将此运行写成完全未改的快速抽帧默认值。限制只施加于直接启动的应用及其子进程，系统网络未改；正向 loopback 和直接/后代拒绝控制通过。XPC WebKit 服务归属未建立，不能把通用 `sandbox_check` 结果当作它们完全禁网的证明，也不能把此次启动称为 Finder 离线组合验收。

本次实际生成 119 帧，但 `frames.json` 显示 rotation=−90、rotation_correction=null、filter=`fps=5`，JPEG 为 1920×1440，方向修正被遗漏。原生特征提取进度已观察到 44/119，尚未生成 sparse 时显示正常占位；随后在 79/119 附近安全暂停，未进入训练。应用正常退出，已观察子进程全部结束、锁释放。251 个项目文件完整冻结于 `target/macos-m4/native-offline-run-20261027/paused-project-frozen/`，审计为 `rotation-defect.json` 与 `partial-run-summary.json`。50 次资源样本均 normal；COLMAP 独立 RSS 峰值约 4.65 GiB，不与应用 RSS 相加，系统 swap 不归因于应用。

这是有效的失败证据，不能计为真实视频完整生成或原生离线验收通过。修复需正确解释 FFprobe 的带符号显示角度，并在恢复时识别已有错误帧缓存、重新执行依赖阶段；新包及复测结果另记。

## 2026-10-27：cfba 实拍方向恢复、完整产物与自动最终预览

修正候选主程序 SHA-256 为 `cfba918efdb73a09e48a905dde03b465e14e82f73041850aa49a9a7ac60863af`，bundle 清单 SHA 为 `77cb1ce0af1ce8cd5cec612dbce169e78f2d2a632946ba7869acc0d9dc96bd11`。本轮在同一 Apple M1 Pro／32 GiB／macOS 27.0.1 开发主机，以 `sandbox-exec` 直接启动该包内可执行文件，PID 65724；没有将此次启动写成 Finder 启动或干净主机验收。

原生打开并 Continue 上述暂停项目 `01a17d05-dae3-7662-bd32-eb7c18c51d72`，本轮 run 为 `01a17d1c-3265-7d61-8ae4-dccdaeaea702`。这不是重新创建项目：`MediaValidation` 保留 11:03:15.483537 UTC 的旧完成记录；旧错误帧缓存失效后，11:26:02 UTC 从 `FrameExtraction` 起重新执行其余 11 个阶段，于 11:36:53 UTC 完成，最终 12 个状态均为 completed。原来的显式 5 fps／最多 150 帧设置保留，训练仍为 fast、3,000 步、SH0、长边 1,280、6 线程、1 GiB 图像缓存及 150 万高斯上限；不能称作未经调整的快速抽帧默认值。

独立数据审计确认 119 个旧错误帧全部替换，JPEG 及清单均为 1440×1920，保留 raw rotation=−90，纠正为 `transpose=clock,fps=5`。第 0、59、118 帧与原始 MOV 由 FFmpeg 自动旋转生成的独立参考 RGB 像素完全相同，JPEG SHA 也一致；其余帧核对尺寸头、文件清单、大小及哈希。原视频、项目设置和 251 文件冻结故障副本保持不变。原生素材预览曾显示 broken thumbnails，`upright-native-frames.*` 的文件名不代表通过；本轮不能据磁盘方向正确宣称原生缩略图成功，也未在此运行中确定缩略图失败原因。

SfM 首个 `video-sequential15-global` 候选注册 119/119 帧，99,649 个稀疏点、628,426 个观测，重投影误差 0.804982 px。训练去畸变图像实际为 959×1280，与其 PINHOLE 相机一致；没有把原始帧尺寸或理想 960×1280 当作实际输出。训练从 iteration 0 开始，完成 3,000 步；最终 checkpoint 与 scene.ply 同为 651,384 个高斯、36,478,003 字节，SHA-256 `96d53e36f14fd99949c47d0f53123ae5688f82af3bba244a215d12cec3c1e50a`。全体 9,119,376 个浮点属性有限，checkpoint、result、completion、validation 与 manifest 绑定一致，失效/恢复 journal 清空。审计 1,317 项检查通过，647 份读取证据在审计前后不变；Brush 进程计时 339,974 ms，与抽帧至流水线完成的 651.332 秒范围不同。

原生 `training-live.*` 显示 751 step／165,492 高斯的真实实时画面。完成后的 `final-native.*` 仍显示 2,133 step／461,130 高斯，并明确标注“内存压力升高 · 预览暂停”；该截图是保留的旧 live 帧，不是最终模型。随后无需点击按钮或切换项目，界面自动显示 651,384 高斯及“高斯渲染”，无 step 标记，`final-autorecovered.png` 可见鞋子和地毯，模型更新时间为本地 19:39:41。资源样本于 11:39:40.406999 UTC 首次观察到 warning 回到 normal；这支持本轮压力暂停后的自动最终预览恢复，不能归类为永久卡死。`final-autorecovered.ax.txt` 只保存差量，最终数量以截图及原生操作记录为证。没有观察 critical 压力或强制释放循环。

网络范围仍限于直接应用及有父子关系证据的进程：四项 loopback 正负对照通过，892 次进程观察中 8 个身份的 1,420 条 owned 记录均有 inbound/outbound `sandbox_check=(1,1)`；另列的 11 个 WebKit XPC PID 未建立归属，不能据通用检查值推定其继承隔离。系统网络未改变，不宣称操作系统完全离线。完成后于 11:40:57 UTC 正常 ⌘Q，退出码 0、`remaining_known=[]`；资源采样器通过 stop file 退出 0，阶段观察器也退出 0。

本地证据集中于 `target/macos-m4/native-rotation-recovered-20261027/`：[运行汇总](../../target/macos-m4/native-rotation-recovered-20261027/run-summary.json)、[资源汇总](../../target/macos-m4/native-rotation-recovered-20261027/resource-summary.json)、[独立数据审计](../../target/macos-m4/native-rotation-recovered-20261027/audit-20261027T113938Z-89b36b3a/audit-summary.json)，以及上述截图、原始 JSONL 和冻结事件副本。分阶段资源数值及不相加的 RSS 解释见 [资源记录](macos-m3-resources.md)。本轮补充了真实视频的同项目恢复链路与最终显示，没有替代新项目从头创建、缩略图、混合尺寸输入或其他主机的独立验收。

## 本轮新增契约（最终 Release 构建原生回归待补）

- Mac 采用 ⌘N/⌘O 和 ⌘Enter；Windows/Linux 保留 Ctrl。表单、输入法、已处理事件及模态层仍屏蔽全局导航。
- 实时预览同时要求 Brush 的 `live_preview` 功能及 `ply_request_ack_v1` 协议；旧引擎继续使用检查点。
- Mac 关闭主窗口隐藏窗口，Dock 重新激活恢复窗口；显式退出等待任务暂停、状态落盘及进程组清理。
- 退出时先处理编辑器的保存／放弃／取消；停止超时或状态无法保存时保持应用打开。退出门禁拒绝新任务并等待正在进行的预检/素材读取结束。

上述契约初始验证包括快捷键 27 项前端测试、退出编辑保护 3 项前端测试和桌面 Rust 库 67 项测试。bb13 所绑定的完整源码门禁为 Rust 705 项通过／14 项环境专用测试默认忽略、前端 190 项通过，fmt、Clippy、TypeScript、ESLint 和生产构建均通过；冻结证据在 `target/macos-m4/final-gates-20261027/`。这些计数不替代各构建的原生验收。

`8656d4e0` 候选已覆盖 32 GB 主机的中型场景、训练中退出与 warm start、live 项目/窗口切换、实际 warning/normal 压力循环，以及大小写敏感模拟卷和中文路径。显式选择检查点、编辑保存和未保存退出的较早开发构建证据仍各自保留。bb13 已补充工程视频、路径、恢复及编辑回归，离线核心通过不变源码与包内引擎哈希绑定；恢复后的失效预览已在 6784 候选按上述范围修复并原生复测。cfba 补充了 119 帧真实视频的方向缓存恢复、下游完整生成和自动最终显示，范围限于沿用旧暂停项目与进程级禁网。Dock 专项、睡眠恢复、物理外接盘、混合尺寸素材及原生缩略图等尚未据此通过。macOS 15、实际 16 GB、干净主机和 Windows 需要当前不可用的外部环境。此记录不能关闭 M3/M4。

## 2026-10-27：4e76 原生缩略图修复与正常／进程禁网复测

此前 cfba 的缩略图缺陷在正常 LaunchServices 启动下也能复现：12 个图像元素均为损坏图标或替代文本，磁盘上的 119 张正向 JPEG 及最终高斯模型已独立通过。该次没有禁网包装，故不能把现象归因于进程禁网。复现、截图与原生启动身份保存在 [正常启动复现收据](../../target/macos-m4/native-thumbnails-normal-20261027/reproduction-summary.json)。静态检查确认详情页经 `convertFileSrc` 生成本地 asset URL，而 Release 未启用对应协议；修复改为后端验证项目与帧路径后返回有界 JPEG data URL。

新候选主程序 SHA-256 为 `4e763b5864705fd0c91fa5a63a547cb4119552e4a6c9a6113f017ba40a17ef3d`，完整 bundle 清单 SHA 为 `243fae560b63c8bef480477f4f434b1707ccfcfd49ed4b5826cc7ff34c57f587`。后端在阻塞工作线程中顺序生成至多 12 张、长边至多 360 像素的缩略图；解码前检查 64 MiB 文件和 64 × 1,024 × 1,024 像素上限，拒绝帧目录／图片符号链接，并返回实际编码尺寸。前端按帧清单身份清除失效结果、忽略过期异步响应，普通轮询和无关检查点变化不会反复解码。这里只验证静态路径防护与有界预览，没有宣称可抵御恶意并发替换文件。流水线、压力处理、项目持久 schema 和引擎均未修改；八文件改动、红绿回归、721 项 Rust／198 项前端完整门禁及完整打包审计见 [引擎包记录](macos-engine-pack.md)。

在同一 Apple M1 Pro／32 GiB／macOS 27.0.1 主机重新打开已有 Objectron119 工程 `01a17d05-dae3-7662-bd32-eb7c18c51d72`，执行了两次独立原生查看：

- 正常通过 LaunchServices 打开精确 bundle 路径，实际应用 PID 77099。帧准备显示 12 张不同且方向正确的已加载缩略图；切换回最终模型，显示 651,384 个高斯和实际渲染画面。随后 ⌘Q；下一次启动前的进程检查确认旧应用已退出。
- 直接在 `sandbox-exec` 网络拒绝策略下启动同一可执行文件，PID 77289。四项 loopback 正负对照通过，75 次采样的 75 条 owned 记录均拒绝 inbound/outbound 网络检查。帧准备仍显示 12 张不同的正向缩略图，切回最终模型仍显示 651,384 个高斯。⌘Q 后退出码 0，`remaining_known=[]`。

两轮仅查看既有产物，没有重新抽帧或训练；119 张帧图、`frames/frames.json` 及 2 个 output 文件共 122 个文件的前后哈希一致。651,384 高斯和 scene.ply SHA `96d53e36f14fd99949c47d0f53123ae5688f82af3bba244a215d12cec3c1e50a` 的生成身份仍属于前述 cfba run。新包通过的是已有帧缩略图显示及返回最终模型，不是新包完整生成验收；旧离线核心结果也没有转移到新候选。

[原生汇总](../../target/macos-m4/native-thumbnails-fixed-20261027-summary.json) SHA-256 为 `f53055c7d51d670439186cf1cd4d7025173f44253a0df70f6ee45819b64fde9e`，绑定应用、包收据、两组原生截图和 AX 文本。正常证据位于 `target/macos-m4/native-thumbnails-fixed-normal-20261027/`，禁网证据位于 `target/macos-m4/native-thumbnails-fixed-offline-20261027/`，均包含 `thumbnails.*`、`final-model.*` 和 `launch.json`；后者另保留策略、loopback 对照、进程样本和 `exit.json`。包收据创建时记录的 native pending 保留为历史事实，后续专项结果由此独立收据补充。

[独立原生证据审计](../../target/macos-m4/thumbnail-package-audit-20261027/native-evidence-audit-attempt02.json)重新核对 148 份绑定文件及四张原尺寸截图，确认上述身份、75/75 owned 禁网记录、退出状态和 122 文件不变。四张截图虽以 `.png` 命名，实际编码均为 2880×1898 JPEG；首轮审计错误地按扩展名要求 PNG 头而中止，该失败记录保留，修正格式判定后的第二轮通过，没有修改截图或原始收据。

本节补齐 cfba 遗留的原生缩略图显示缺口。禁网范围仍限于应用及已归属的进程，WebKit XPC 服务未建立归属，系统网络未修改；这不构成 Finder 加离线的组合验收、完整操作系统离线或干净主机证明。Dock、睡眠恢复、物理外接盘、混合尺寸输入以及 macOS 15／实际 16 GiB／Windows 的未完成范围保持不变；五项许可证缺口、Developer ID 和公证门禁仍未关闭。

## 2026-10-27：4e76 新建 Objectron119 工程首轮完整生成

本节仅记录新工程 `01a17d49-2341-7603-a9d0-a24a6655fb8b` 的首轮正常完成快照，名称为 `M4 异常恢复 Objectron 119`。工程名称和目录名称不代表已执行异常恢复。应用主程序 SHA-256 为 `4e763b5864705fd0c91fa5a63a547cb4119552e4a6c9a6113f017ba40a17ef3d`，由 `release-package-thumbnails-20261027/acceptance-summary.json`、实际可执行文件及 `training-launch/launch.json` 一致绑定；原生 PID 79115 直接在进程级 `sandbox-exec` 网络拒绝策略下启动，不是 Finder 启动。执行 profile 的 run ID 为 `01a17d4c-a15e-7730-af45-7fc2b43dd103`，四个包内引擎哈希与 profile 相同。

新建时全部 12 阶段为 pending。应用关闭、工程仍为 ready 时，明确将 `frame_fps` 从 null 改为 5、`max_frames` 从 300 改为 150，记录在 `fps-override.json`；其余设置不变。因此这次使用显式抽帧参数，不能描述为完全未调整的默认快速预设。输入是同一 Objectron 实拍 MOV，23.796667 秒、714 个源帧、1920×1440、−90° 显示矩阵，源文件及项目副本 SHA-256 均为 `30d0f636a458183aae5ca36a36343c99ed6254d4ebabf3df020376b070ff163f`。训练参数为 fast、3,000 步、SH0、长边 1,280、6 线程、1 GiB 图像缓存和 150 万高斯上限；32 GiB 主机上的 16 GiB 策略预算不构成实际 16 GiB 机器验收。

事件记录显示全部 12 阶段各有一次 started 和 completed，没有沿用早先工程的 MediaValidation 完成状态。流程于 12:18:56.496774 UTC 开始，`pipeline_completed` 的实际时间为 **12:28:42.153266 UTC**，项目 `updated_at` 为 12:28:42.153509，事件跨度 585.656492 秒。先前操作侧提到的 12:28:53 是完成后的观察时间，不是流程完成时间。Brush 阶段耗时 274.185944 秒，结果中的 `duration_ms=270615` 只覆盖较窄的 Brush 进程段。

独立审计仅读取 `fresh-completed-frozen/`，其 419 个文件、807,266,186 字节与 `fresh-completed-manifest.json` 前后完全一致，未读取随后用于恢复操作的实时工程。119 张提取帧均为正向 1440×1920，processed 副本逐张哈希相同；第 0、59、118 帧与 FFmpeg 自动处理原始显示矩阵的独立参考图解码像素一致。COLMAP 注册 119/119 图，得到 99,553 点、628,190 个观测；独立二进制解析确认双向轨迹引用和数值有效。训练数据为 119 张 959×1280 去畸变图，与 PINHOLE 相机尺寸、注册名称及全部准备指纹一致。

训练从第 0 步运行到 3,000，未恢复优化器。最终为 647,529 个高斯、SH0、36,262,123 字节，`output/scene.ply` 与 `checkpoint_3000.ply` 的 SHA-256 均为 `20feeb8fb4fc8f36770a881195445c57a498c9624fd25c6f2d7b55d8ab9b45da`；validation、manifest、result 与 completion 哈希一致。0500、1000、1500、2000、2500、3000 六个检查点均通过全顶点浮点有限值、SH0 和完整载荷检查。以上是新包自身的生成数据证据，没有转移 cfba 的旧结果。

12:28:29 的受控 capture 尝试因 `Cannot read process argv` 失败，结果明确记录 `process_signals_requested=false`、`project_files_modified=false`；该尝试没有造成异常终止，不能计为异常恢复通过。首轮快照之外的后续恢复流程另行记载。完成附近出现内存压力 warning，`current-1229.jpg` 保留的是 2,961 步旧 live 帧及暂停提示；本节没有证明最终 647,529 高斯已在原生静态 viewer 安装或显示，也没有证明本轮压力回落后的自动恢复。有效最终 PLY、PreviewGeneration 成功和保留的 live 截图不能代替这一 UI 结论。

证据位于 `target/macos-m4/native-abnormal-recovery-20261027/`：[冻结数据审计](../../target/macos-m4/native-abnormal-recovery-20261027/fresh-completed-audit/audit-summary.json) SHA-256 为 `7f6dd5a1035ba69ef859466c1b51e1ffa8abd7d15ce68bf81dd0e5c841da3903`，其 30 项校验清单复核通过；另保留 `project-created.json`、`fps-override.json`、原始事件与采集 JSONL、capture 失败收据及冻结文件清单。资源样本的范围和未测项目见 [资源记录](macos-m3-resources.md)。本节不新增系统完全离线、最终预览、异常恢复、16 GiB、macOS 15、干净主机或 Windows 验收结论。

## 2026-10-27：4e76 原生受控混合40图完整生成与最终显示

本节全部原生结果仅绑定应用 SHA-256 `4e763b5864705fd0c91fa5a63a547cb4119552e4a6c9a6113f017ba40a17ef3d`，完整 bundle 清单 SHA 为 `243fae560b63c8bef480477f4f434b1707ccfcfd49ed4b5826cc7ff34c57f587`。原生 PID 85772 在进程级 `sandbox-exec` 网络拒绝策略下运行，创建新项目 `01a17d7e-fe9f-7fd0-a127-a28681b353f7`（`M4 混合输入 40`），run 为 `01a17d7f-0b0f-7de0-9e51-b6f02d919ca5`。主机仍为 Apple M1 Pro／32 GiB／macOS 27.0.1；没有将早期候选的生成结果移交为本次新包证据。

输入来自 James40 同一场景的 40 个独立视角，每张只取一个受控派生图。四组各 10 张：两组使用**合成的 EXIF 相机身份**，另两组不含相机 EXIF 且尺寸不同。这验证受控元数据和尺寸分组，不代表四台真实相机的实拍混合采集。原始四子目录保留；为适配当前原生文件选择器通过所选图片定位父目录的流程，另建 `input-flat-40/`，40 个文件只做逐字节平铺复制，没有再次改变像素或 EXIF。`native-input-manifest.json` 明确记录这一边界，不能据此宣称只含子目录的根目录可直接经原生向导导入。

保持快速预设，COLMAP 上限 2560、训练上限 1280，3,000 步、SH0、6 线程、1 GiB 图像缓存和 150 万高斯上限。实际归一化尺寸为 1536×1024、1200×800、1536×1024、1152×768；所有源派生图长边不超过 1536，因此本次 2560 上限与先前 core 的 1536 上限产生相同的 40 张归一化 JPEG。独立审计逐名核对全部字节相同，总计 10,129,974 字节，并重新核对原始照片、受控 fixture、core 项目 source、平铺输入、原生项目 source 各 40 张的固定哈希。历史 core 的方向 1–8／像素参考审计只作哈希绑定，本次没有重新执行其全部正负案例。

SQLite 实际有四个独立相机组，每组 10 图；数据库图像、相机、rig、frame、特征引用与所选二进制模型一致。首个 `images-exhaustive-global` 方案注册 40/40 图，得到 21,203 点、103,204 个观测，平均轨迹长度 4.867424、重投影误差 0.242959 px，最大匹配连通分量覆盖 100%。11 项质量检查均通过，无质量风险覆盖、重试或 fallback。去畸变后的四组 PINHOLE 尺寸为 1280×851、1205×800、1280×850、1157×768，40 个名称、相机引用、位姿和双向轨迹均有效，准备指纹重算一致。历史独立 CLI 去畸变参考使用不同重建模型，因此不声称两者 JPEG 逐字节相同；本次审计也不自动关闭较早 adapter-vs-CLI 的质量差异审查。

12 个阶段各有一次真实 started/completed，没有跳过阶段。MediaValidation 于 13:14:00.352309 UTC 开始，`pipeline_completed` 为 13:18:03.670597，跨度 243.318288 秒；项目创建到最终 `updated_at` 为 246.518923 秒。Brush 阶段为 182.085403 秒，结果中的 `duration_ms=179486` 仅覆盖引擎进程段。训练从 0 到 3000，未恢复优化器；完整数据、引擎身份与设置组成的训练 fingerprint 独立重算匹配。0500 至 3000 六个检查点及最终 scene 均通过全部标量有限值、SH0、属性与完整载荷检查。最终 121,334 个高斯、6,795,204 字节，checkpoint、scene、validation、manifest、result 和 completion 一致，scene SHA-256 为 `e147d8ca2ae7061152e33f5abd39d5b21774d50b47c1ba6ef90d8831aa426061`。

`live-first.{jpg,ax.txt}` 显示 716 步／36,354 高斯，`live-second.*` 显示 2,189 步／84,325 高斯。完成后自动切换到最终模型，`final.*` 显示可见的岩石与转台、121,334 高斯和“高斯渲染”，viewer 内无实时 step 标记；右侧“最近检查点 3,000 step”是独立的检查点信息。`sparse-pending.*` 虽使用该文件名，实际捕获时已进入 TrainingPreparation，不能作为 sparse 尚未发布时的原生占位截图。原生 ⌘Q 后，13:27:02.619330 UTC 的退出收据为 exit 0、`remaining_known=[]`。

全部证据位于 `target/macos-m4/native-mixed-input-20261027/`。[独立数据简报](../../target/macos-m4/native-mixed-input-20261027/independent-audit/summary.json) SHA-256 为 `4f8300c52aa0a45052de287ebf4fd56a77c25e51cf024aab5bc9daee6191b5db`，完整第三次审计为 9,407 项检查、945 个文件绑定。前两次审计脚本分别因 0500 文件名假设和误用不含 PLY 入口的 helper 中止，失败收据保留；修正仅写入新审计脚本，没有改变项目。[退出后收尾审计](../../target/macos-m4/native-mixed-input-20261027/independent-audit/closeout-receipt.json) SHA-256 为 `05e76cd2f476998416b2b6a094c3a8693bb13c374a1d4788b379217b5a2b06a3`，确认先前 945 份绑定、完整 220 文件项目树、445 个打包生产输入和 4,751 项 bundle 清单均未变。资源采集只覆盖本次正例的独立时间窗，详见[资源记录](macos-m3-resources.md)。本节不新增真实多相机、嵌套根目录选择、系统或 XPC 全面离线、macOS 15、16 GiB 实机、干净主机、Windows 或公开发布验收结论。


## 2026-10-27：d91c 诊断修复、已有模型查看与退出

本轮仅绑定新主程序 SHA-256 `d91c49edcf382212a4c29e11b85fdd21bf9b721959d109dcb6852946ba55758b`；包、DMG、445 个生产输入和启动前独立复核见 [打包记录](macos-engine-pack.md)。原生 PID 95924 以 `sandbox-exec` 进程网络拒绝策略直接启动，环境 PATH 只含系统目录；不代表 Finder 启动、干净机或完整系统离线。所有证据位于 `target/macos-m4/native-diagnostics-fixed-20261027/`。

通过原生向导分别新建低纹理和低重叠 24 图项目，保持快速预设。两者均首次执行且无重试：前者在特征提取阶段以 E-3010 拒绝，24 图／0 个特征点；后者在匹配阶段以 E-3020 拒绝，24 图／40,498 个特征点／0 个有效匹配。两张截图中的完整中文说明及清晰度、纹理、增加重叠、补拍等针对性建议均可见，没有被通用错误覆盖或裁切。源图保留，训练及下游阶段等待，没有误导性最终 PLY。独立后端、AX 和视觉审查见 [负例聚合](../../target/macos-m4/native-diagnostics-fixed-20261027/native-negative-summary.json)，SHA-256 `e8d83848eb247a07e060470276da2f65053fbe69bdfbaa403c1e32a4da571684`。旧包的通用提示失败证据保持不变。

另将 4e76 已生成的混合 40 图工程逐字节复制为独立查看副本，复制时 220 个文件／151,871,613 字节一致；[复制清单](../../target/macos-m4/native-diagnostics-fixed-20261027/positive-view-copy.json)保留原始身份。通过项目目录选择器打开副本，Spark 清晰显示岩石、转台及 121,334 高斯。进入 SuperSplat 后 `scene.ply` 和 121,334 数量已载入，但初始视角仅见网格，重置相机后仍未见主体；点击场景条目并使用“框显所选”后，可见模型与转台。返回 Spark 后仍正常显示相同数量。该结果证明手动框显后的编辑器渲染，**不证明初始自动框显通过**；该问题继续定位。没有进行模型编辑或保存，也没有在 d91c 上重新生成正例。首次在目录选择器输入 `project.json` 被拒，改选 `.splat-project` 目录后成功；这一操作失误没有修改原始项目。

原生 ⌘Q 正常退出，`launch/exit.json` 的 14:10:40.338953 UTC 收据为 exit 0、`remaining_known=[]`。root 的 [原生观察收据](../../target/macos-m4/native-diagnostics-fixed-20261027/root-native-observation.json) SHA-256 `ca820b9e76d07492d985f40fe0f551adda91cada97f9ffa2df818bbb908356d7` 绑定全部 AX、JPEG、复制清单和退出记录。这里关闭两个受控负例的具体诊断缺口；SuperSplat 初始视角、CPU SfM 质量对照、Dock、离线 Finder 以及外部环境矩阵仍未完成。真实睡眠按用户要求暂留，M4 与公开分发状态不变。

## 2026-10-27：9e25 初始框显的部分原生验证

本轮应用主程序 SHA-256 为 `9e25bb7cd571115bf88ac8abef72d6588b0ee066464bfa77e4a9b5543c5e602d`，新包构建与 202 项前端测试见 [引擎包记录](macos-engine-pack.md)。证据目录为 `target/macos-m4/native-editor-framing-fixed-20261027/`。包内桥接在成功导入后调用 `scene.camera.focus()`；测试通过原生目录选择器打开两份专用项目副本，没有重新生成模型。混合项目复制时 220 文件／151,871,613 字节、Objectron 项目 439 文件／1,047,169,524 字节均与原始工程一致。启动前 [独立包绑定](../../target/macos-m4/native-editor-framing-fixed-20261027/independent-package-binding.json) 核对实际程序、DMG、完整 bundle、446 个源文件、25 个编辑器资源及 sourcemap，SHA-256 为 `611844fda80913c0d4a1f32c03bf7d99c4720c2cca318759ad90e37d9452a419`。

混合 40 图副本在 Spark 显示 121,334 高斯；首次进入 SuperSplat 即可见岩石和支撑台，后续捕获与再次进入仍可见，两次返回 Spark 均没有未保存修改提示。测试没有点击场景条目或使用重置、框显、缩放、旋转、编辑、保存。独立视觉复核确认主体可辨，取景偏远，不据此声称模型质量改善。

Objectron 副本在 Spark 显示鞋与地毯及 614,263 高斯；编辑器首次进入也有场景几何和正确数量，但默认角度模糊、破碎，不能描述为清晰主体。随后文件名为 `objectron-editor-settled.jpg` 的截图已显示变换 Y=7.228，而首次截图为 0；工具在返回动作前报告窗口被用户改变。后续刷新也出现不同视角，返回时实际弹出未保存修改提示。因此该 settled 文件不是无人操作的稳定帧证据。root 选择“继续编辑”保留状态，没有保存、丢弃或退出，也不将该变更归因为相机修复。

[独立部分审查](../../target/macos-m4/native-editor-framing-fixed-20261027/independent-partial-native-review.json) SHA-256 为 `d96eb42167e0ffe99f2266299b5481acf3d3237f02b73d3ca0fe4332f1ebb318`，绑定 24 份 AX／JPEG；[交互保留记录](../../target/macos-m4/native-editor-framing-fixed-20261027/progress-user-interaction-preserved.json) SHA-256 为 `1ed05645d2ac4b01b54568575773b00d00e947ba5c83ecde7ec77a3ef0855783`。Objectron 无修改返回、再次进入、正常退出及退出后文件审计尚未完成，完整原生验收保持未通过。此次为直接启动并限制进程网络，仍不是 Finder、系统完全离线或干净机验收；M4 和公开分发门禁保持开放。

### 用户授权保存后的收尾

用户随后明确选择“保存到测试副本后继续验收”。[保存前独立清单](../../target/macos-m4/native-editor-framing-fixed-20261027/independent-before-authorized-save.json) 确认两份原始项目及两份副本共四个目录仍与准备清单逐文件一致。root 点击保存一次，截图显示“模型已保存”；同次 AX 捕获时仍在保存阶段，后续 AX 才显示已保存，不将两者误记为同一瞬间。返回、重新进入和再次返回均未出现未保存提示；重新进入加载 614,263 高斯并自动显示场景几何，默认角度仍模糊。最后 ⌘Q，`launch/exit.json` 在 15:02:59.492528 UTC 记录 exit 0、`remaining_known=[]`。

保存后的 Spark 三张返回截图均显示 614,263 高斯，但只见局部模糊背景，鞋的主体不可见。源码定位为首次载入仍无条件采用原 SfM 相机，覆盖根据当前模型计算的整体取景；保存后的平移不更新 SfM 相机。此项保留为独立取景缺口，不能写作保存后查看全部通过。

[顺序无关坐标审计](../../target/macos-m4/native-editor-framing-fixed-20261027/independent-order-invariant-transform.json) SHA-256 `056adb31da680a19bb09e0652c4cd9197a016fc8ecc524be749d7461e545ac1f` 按除 Y 外 13 个 float32 属性的完整字节键匹配全部 614,263 个高斯，全部唯一匹配、无遗漏；13 属性逐点位完全一致，Y 均为 `float32(originalY - 7.22796630859375)`。全部 8,599,682 个标量有限，SH0、属性与载荷合法。这证明保存平移正确，未发现 PLY 损坏；它不证明默认视角或模型质量。

[退出后独立收尾](../../target/macos-m4/native-editor-framing-fixed-20261027/independent-postexit-closeout.json) SHA-256 `9bb11032d4b9c03cd73aa2c6819b243339dba73dd1e9d234b1ae06f54bed7c60` 确认两份原始工程、混合项目副本完全不变，Objectron 副本仅 `output/scene.ply` 有授权保存差异，无临时文件；446 个源文件、25 个编辑器资源、完整 bundle 及 DMG 均与该候选绑定一致。[root 操作记录](../../target/macos-m4/native-editor-framing-fixed-20261027/root-native-observation.json) SHA-256 `44b5f15fc2789fd471b62549ef09279ebe851bef8fc31783cee7aadf5c780d6e` 保留完整操作顺序与截图。原先被手动操作中断的 Objectron 无修改试验不能倒推通过；本次新增保存、保存后复进及正常退出的限定证据，Spark 保存后取景与完整 M3/M4 继续开放。

[退出后独立收尾](../../target/macos-m4/native-diagnostics-fixed-20261027/post-exit-closeout.json) SHA-256 `471e98116c63bdc1726e6612070c8c52a6ea36e987a7682bd182cc3737ba095e` 确认两个负例的 83／85 文件、正例原件与查看副本各 220 文件均无变化；新包绑定和 14 项原生图文证据一致，保留初始框显问题。当时的候选指针更新为 d91c，并保存上一版指针；M4 与公开发布标志仍为 false。

## 2026-10-27：f7b7 三模型静态取景复验

本轮绑定完整构建 `build.XWwqBV` 的 `f7b7141afa4da873bce0c90a3ca4ad218512f60eb18936047e15b91e70abd5ac`，使用三份预先逐文件校验的原始 Objectron、已授权平移的 Objectron 及混合 40 图副本。两个 Objectron 的项目 ID 相同，操作与证据均用完整目录区分。PID 19606 以进程网络拒绝策略直接启动，不是 Finder 或系统完全离线测试。未训练、编辑、保存、重置、手动框显或操作相机，没有用户交互警告。

原始 Objectron 的 Spark 首次及编辑器返回后均清晰显示鞋和地毯，数量 614,263。混合模型的 Spark 首次与返回显示岩石、转台及 121,334 高斯，SuperSplat 自动框显可辨但偏远。两个 Objectron 均可自动载入编辑器场景几何，默认方向模糊；三次无修改返回均未出现未保存提示。

从原始副本直接打开同 ID 的平移副本时，Spark 仅显示顶部模糊片段与大片暗背景，**初次取景失败**。进入编辑器再返回后自动框显了当前场景，但看到背面，鞋不可辨。源码确认预览组件的 key 只有项目 ID，路径变化会保持旧 viewer，相同文件 revision 还可能跳过重新读入；重新挂载后几何 guard 可以触发，但固定回退方向与原拍摄方向相差约 134°。这两项继续修复，不将“有几何可见”记为主体清晰。

⌘Q 后 `launch/exit.json` 于 15:54:24.384007 UTC 记录 exit 0、`remaining_known=[]`。[原生操作记录](../../target/macos-m4/native-spark-framing-fixed-20261027/root-native-observation.json) SHA-256 为 `cbfbbe0bf1406f599f8d4afcc32e779c854fcc528386ec6f99b06d85581dc03b`；同目录保留完整路径选择器 AX、十张截图和各次 AX。首张原始 Spark AX 为 no-change diff，其余 capture 为完整 AX；平移编辑器首次截图仍在加载，另有 loaded 截图。本轮结果为限定通过与两个未关闭取景问题，M4 与公开发布均未通过。

[独立退出审计](../../target/macos-m4/native-spark-framing-fixed-20261027/independent-postexit-closeout.json) SHA-256 `d3e2de615e3677a8383abbe80da9e32a902861e7ae4d1b620f06efc7114ee2ac` 确认三份 source 与三份 copy 的全部文件均不变，448 个构建输入、25 个资源、4,755 项 bundle 清单、DMG 和 614 个许可证文件与启动前一致，并独立复核上述图像结论。后续源码改动在此冻结点之后进行，不属于 f7 包。

后续证据完整性更正：e086 会话的持久 CUA 截图辅助函数仍写入本节目录，覆盖了 13 份同名 AX／截图。上述历史 JSON 收据未改，但对应资产现已不匹配原哈希，不能再描述为完整保留或重新校验通过。受影响清单及本轮图文归档见下节；项目副本、原始素材和包未因此改变。

## 2026-10-28：e086 跨路径身份与自动取景朝向复验

本轮绑定完整构建 `build.r7Jz6T` 的应用 SHA-256 `e0863d0e025bfe3934189dc05c2db7bf68eed4ddde4cb394eae563b1bf4dc7e1`，bundle 清单 SHA-256 `b6b2fc0948a78a450c9890d642a23bcd31947c118bba48309e419d4a87822c93`。219 项前端测试、类型与 lint 检查、完整 app/DMG 构建和只读挂载验证见[打包记录](macos-engine-pack.md)。原生 PID 25376 使用进程级网络拒绝策略直接启动；主机仍是 M1 Pro／32 GiB／macOS 27.0.1，不代表 Finder、系统完全离线或干净主机验收。

通过完整路径依次打开 `native-spark-framing-fixed-20261027/projects/` 下的既有原始 Objectron、已授权平移 Objectron 及混合素材副本，没有再复制或生成项目。两个 Objectron 保持相同项目 ID，原始／平移 scene SHA-256 分别为 `c9e297ae96d27bcef2aae910d451b56d5fdb9dae0e06bdf8ba72188510bcd97d`／`7b66c650f8df0c5632e7fd71a2f3cfb00563ab6dcc0328fdef334fb44457c5e9`，不能只用标题或数量识别工程。

原始 Objectron 的 Spark 清晰显示鞋与地毯、614,263 高斯。直接打开同 ID 的平移副本后，Spark 自动显示可辨的两只鞋与地毯，视野更广、主体较小，边缘仍有模糊重建区域；无需手动导航。进入该副本的编辑器后，614,263 高斯及场景几何加载成功，但默认角度仍模糊、鞋不可辨，只通过几何加载，不宣称编辑器主体清晰度改善。无修改返回未出现未保存提示，Spark 自动恢复可辨的鞋与地毯。混合副本的静态 Spark 清晰显示岩石、白色转台及 121,334 高斯；本轮没有重复其编辑器往返。

本轮未编辑、保存、重置、使用整体视图或操作相机，也未训练或睡眠，没有工具报告用户交互警告。⌘Q 后退出收据在 2026-10-27 16:24:18.532941 UTC（本地 10 月 28 日）记录 exit 0、`remaining_known=[]`。[root 原生观察](../../target/macos-m4/native-spark-path-orientation-20261027/root-native-observation.json) SHA-256 `5d1d02f09351e57c46c870f86b38d736e86abd5242be65a8860fb0f176e189e2` 绑定实际包、操作顺序、13 份图文和退出记录。

收尾发现截图辅助函数误写上一轮目录。本轮 13 份图文按实际文件、会话内修改时间和捕获名称识别，逐字节复制到正确的 `native-spark-path-orientation-20261027/`；[目录纠正收据](../../target/macos-m4/native-spark-path-orientation-20261027/capture-location-correction.json) SHA-256 `d317fffafa5c1bc4e54237bae1cb9dc95bb044e3423da8196b819260468b56c1` 逐项列出新旧哈希。f7 被覆盖的资产没有恢复，历史 JSON 记录保持原样；不把本轮图文当作 f7 证据，不声称旧证据完整保留。

[独立退出收尾](../../target/macos-m4/native-spark-path-orientation-20261027/independent-postexit-closeout.json) SHA-256 `ccb3b06a024e121167c3ee168daa8f66bd8bb4fd4c6524b8a287c22f4ff66daf` 实际复核五张截图，并确认三组 source／copy 各 439／439／220 个文件全部不变；448 个生产输入、25 个编辑器资源、614 个许可证文件及 4,755 项 bundle 清单与启动前一致，当前包签名校验通过。仅执行一次项目全树与一次包体／输入审计，没有因图文纠正重复核验。该收据也独立确认 13 份历史资产哈希失配及原 JSON 收据未改。当前候选指针已绑定这些限定结果，`m4_accepted` 与 `public_release_ready` 均为 false。

本轮关闭 Spark 同 ID 不同目录初次取景、平移模型自动回退朝向及编辑器返回后主体取景这三个限定检查。既有生成结果只作静态查看素材，9e25 的授权保存仍属于其原构建；没有将旧生成、编辑或保存验收转移到 e086。完整 M3/M4、编辑器默认主体清晰度、相对 SfM 质量判定、其他生命周期／环境及公开发布条件仍开放，真实睡眠依用户要求暂留。

## 2026-10-28：6925 编辑器初始拍摄朝向与干净返回复验

本轮绑定完整构建 `build.IWJQjj`，主程序 SHA-256 `6925467b4fe285a08797b1b80b84ca938c64ff02c7f7d8e40929410aee02b8ff`、bundle 清单 `63258eb3abd7e7df2b949a575d54227efeef7a753b089157c411947c0b014ce6`。完整 app/DMG、235 项前端、729 项 Rust／15 忽略、36 个 schema 用例及其余静态检查见[打包记录](macos-engine-pack.md)。编辑器在导入后以当前几何框显，并采用导入物体世界变换后的拍摄 forward 设置普通相机角度；不恢复历史相机位置、FOV 或 roll，不改变全局相机控制或重置行为。

沿用 `native-spark-framing-fixed-20261027/projects/` 的三份静态工程副本，通过原生选择器按完整路径依次打开原始 Objectron、同 ID 的已授权平移 Objectron 及混合 40 图模型。没有重新复制或生成素材。启动前独立绑定核对 449 个源码输入、25 个编辑器资源、610 个许可文件及六个关键项目文件。PID 33798 在当前 M1 Pro／32 GiB／macOS 27.0.1 上以进程网络拒绝策略直接启动，不是 Finder、系统全面离线或干净主机验收。

原始 Objectron 的 Spark 首次与返回均可辨鞋和地毯、614,263 高斯。编辑器第一张捕获仍在加载，不能作为成功显示证据；随后 `original-editor-loaded` 自动显示可辨的两只鞋与地毯，视野较广、主体较小，周围背景与重建边缘仍模糊。直接切到同 ID、不同路径的平移副本后，Spark 首次、编辑器载入及返回均显示可辨的鞋与地毯，数量同为 614,263。两个项目以完整路径与不同 scene 哈希绑定，不能仅凭相同标题和数量区分。

混合副本的 Spark 首次和返回清晰显示岩石、白色转台及 121,334 高斯；编辑器自动视角同样可辨岩石与转台，但主体偏远。三次返回均没有未保存提示。整个会话未编辑、保存、重置、使用整体视图、手动导航相机或训练，也未出现工具报告的用户交互警告。此结果关闭三份测试模型首次进入编辑器主体可辨的限定检查，不表示模型重建质量改善或全部相机交互验收完成。

⌘Q 正常退出；`launch/exit.json` 于 2026-10-27 17:10:58.931909 UTC（本地 10 月 28 日）记录 exit 0、`remaining_known=[]`。[root 原生操作记录](../../target/macos-m4/native-editor-capture-20261028/root-native-observation.json) SHA-256 `20d91c10bee878d4c05de2707d3e5899f9348ca5305f7ebd9ef5e0d74fbea88d` 绑定 10 份截图及对应完整 AX、三个选择器路径和启动退出记录。本轮捕获使用显式目标根目录及排他创建的独立子目录，按实际 JPEG 编码保存，没有复用旧捕获路径。此前 f7 的 13 份历史图文覆盖事故及未恢复状态继续保留。

本轮只验证已有模型查看、首次编辑器朝向、无修改返回与正常退出。9e25 的授权平移保存和更早的生成结果仍绑定各自原包，不自动转移到 6925。完整 M3/M4、相对 SfM 质量、其他原生生命周期／资源检查、外部环境矩阵、Developer ID／公证以及 WebP 编译来源证据仍开放；真实睡眠按用户要求暂留。

[独立退出收尾](../../target/macos-m4/native-editor-capture-20261028/independent-postexit-closeout.json) SHA-256 `93ec0b5f6b9f211faa6b7c6d82c21b4ef904715e60c0f4a5c29137b691616155` 独立查看十张截图，其中九张已加载，排除一张加载中画面；复核两组鞋与地毯、混合模型的岩石与转台均可辨，取景偏广及主体较小的限制保留。捕获的返回状态无未保存对话框；连续操作过程是否出现瞬时提示单独依据 root 观察。三组 source／copy 共六棵项目树、2,196 个文件均保持不变；当前 bundle 清单与冻结包一致，449 个源码输入、25 个资源和 610 个许可文件及 DMG／签名核对完成，另行获准的只读进程查询未发现当前应用或已知测试进程身份。

审计在最后附加 `/bin/ps` 查询被执行沙箱拒绝时，已保存项目与 bundle 完整清单，但尚未序列化包汇总 JSON。收尾收据明确区分已落盘清单与根据顺序执行到失败行确认已完成的输入、许可、DMG 和签名断言；包汇总于事后写入，并独立补齐进程查询，没有重复扫描或重新启动应用。该边界及失败 trace 完整保留，没有把事后汇总称作当时已经生成。最新候选指针已绑定本次限定通过，`m4_accepted` 与 `public_release_ready` 仍为 false。

## 2026-10-28：6925 Finder 启动与窗口命令后的唤回

本轮在 Finder 中选中当前 `bundle/macos/MetOrigin Splat.app`，用 ⌘O 启动。绑定 CUA 应用对象之前，独立只读进程查询已确认主程序的完整路径、PID 36032 和启动时间；主程序仍为 `6925467b`。随后按完整路径打开原始 Objectron 测试副本，Spark 显示 614,263 高斯及可辨的鞋与地毯。此次为普通 Finder 启动，没有进程禁网策略，没有改变系统网络，也不代表干净主机或离线生成验收。

先点击最小化按钮并读取 AX，但 AX 仍可读取完整内容，且没有独立的最小化属性；此观察不能证明窗口当时已最小化。随后通过 Window → Minimize 发出命令，此后只观察 Finder，再用 Finder ⌘O 唤回应用。又点击窗口关闭按钮，在再次打开前确认原 PID／启动时间仍在，随后 Finder ⌘O 唤回；模型可见，进程身份仍相同。三张模型截图的数量与主体取景基本一致。中间 minimized／hidden 状态没有独立证据，因此这里只记录命令后可唤回和进程连续性，**不关闭完整最小化／恢复或 Dock 点击验收**，也没有据源码猜测缺陷而修改 `show_main`。

最后发出 ⌘Q，只读进程查询确认原 PID 和当前应用路径均不存在。应用由 Finder／launchd 启动，本观察器不能读取其退出码，记录为 `null`；资源采样器退出码 0 不能当作应用退出码。[root 操作记录](../../target/macos-m4/native-finder-lifecycle-20261028/root-native-observation.json) SHA-256 `87f3ec30a4da0c08a8c197f286f6c00842f330861e2a2787f0d022633e021149` 保留操作顺序、Finder 选择路径、三张截图、AX 与进程收据。

[独立收尾](../../target/macos-m4/native-finder-lifecycle-20261028/independent-closeout.json) SHA-256 `03252f5d4faa47867262a4592ae43e1664f83ab4cc112945ed76cada93c839d6` 确认本次触及的副本 439 文件／1,047,169,524 字节与上一轮冻结清单一致，并独立复核图文及主程序哈希。只扫描该副本一次；原项目、其他五棵树、完整包体、源码与许可文件未重扫，前次审计及其序列化边界明确复用。47 次资源采样均为 normal，45 次记录应用 RSS，另两次在退出后未见应用；WebKit／Metal 归属未知，不能据此判定循环内存稳定性。本轮没有编辑、保存、训练、导航相机、Dock 操作或睡眠，完整 M3/M4 仍未通过。

## 2026-10-28：ebef WebP 原生图像导出失败与下载路径诊断

本次新包 `ebefccae78577fb9fa9ed83418ff62b8aa426d6797fc3c06a5ea2ab4cff54e80` 已通过完整 app／DMG 校验及零 finding 许可证绑定。通过 CUA 以精确应用路径启动，PID 49612／启动时间与主程序哈希独立绑定；普通主机环境，不代表 Finder 或离线验收。主页最近项目项暴露完整路径，随后打开既有 `objectron-original` 测试副本。Spark 显示 614,263 高斯及可辨的鞋与地毯；编辑器加载后主体可辨但较小，外围仍模糊。

在「渲染 → 图像」选择标准投影、自定义 320×240、WebP，透明背景和调试覆盖均关闭。点击渲染一次后，CUA 报告 noWindowsAvailable；再次观察和 Escape 取消均超时，同一应用进程仍存在。3 秒采样的主线程 223 个样本都停在 Wry 下载回调后的 WebKit 下载目的地／SandboxExtension／`_sandbox_extension_issue` 系统调用。源码确认 Wry 默认接受下载并使用 Downloads，不弹保存对话框；这定位了采样时的阻塞阶段，不能据此证明底层 OS 原因或有效 WebP 字节。没有取得可核验输出文件，故**原生图像导出验收失败**。

保存采样后，对完整 PID／启动时间／路径守卫匹配的本次进程发出 SIGTERM；后续 `ps -p` 返回 1、无该进程。不能把它称为正常退出，返回／复进也未完成。本轮没有编辑或保存场景，先前用户授权保存仍是历史 9e25 的结果。[唯一副本完整性核对](../../target/macos-m4/native-webp-20261028/project-integrity.json)确认 439 个文件、1,047,169,524 字节与会话前完全一致，仅扫描本副本，没有重读其他五棵树或原件。

[原生观察](../../target/macos-m4/native-webp-20261028/root-native-observation.json)、[下载路径诊断](../../target/macos-m4/native-webp-20261028/download-path-diagnosis.md)及[收尾记录](../../target/macos-m4/native-webp-20261028/closeout.json)保留四组图文、进程绑定、线程采样及失败范围。后续同源编辑器桥接与原生保存路径已在 6095 实现，见下一节；ebef 的失败记录不变。真实睡眠继续暂留，M3/M4 和公开发布仍未通过。

## 2026-10-28：6095 原生图像保存、取消与往返

完整 `build.vwiRqG` 主程序 SHA-256 为 `6095c7b2e95939417bca04b976038aec31364ce500c1ffc224354628bcbae4e4`。同源桥接传递有界编码字节，Rust 通过原生异步保存窗口选择路径，并在会话复核后以同目录临时文件替换；不经过 WKDownload、不触发模型 `doc.saved`。代码及跨层失败路径审查、273 项前端、738 项 Rust／15 忽略和静态门禁见[构建摘要](../../target/macos-m4/native-image-save-20261028/acceptance-summary.json)。

CUA 按精确应用路径启动，独立核对 PID 56903 与主程序哈希。使用同一 Objectron 测试副本，标准投影／自定义 320×240／透明和调试覆盖关闭，依次输出 WebP、PNG、JPEG（质量 90）。原生保存窗口均正常出现；输入不带后缀的 `objectron`，系统补出 `.webp`、`.png`、`.jpg`，只写入独立证据目录。三份文件完整解码及尺寸检查通过，WebP 为 RIFF／VP8L，见[文件验证](../../target/macos-m4/native-image-save-20261028/native/image-validation.json)。第四次以 `cancelled-export` 为目标点击原生 Cancel，未出现错误弹窗，导出目录仍只有此前三份且哈希不变。

保存和取消后返回／保存按钮恢复可用；返回 Spark 无未保存提示，再进入编辑器成功载入 614,263 高斯。两个查看器均可辨鞋与地毯，编辑器仍视野较广、主体偏小且外围模糊。最后在干净编辑器发出 ⌘Q，独立 `ps` 确认该 PID 和当前应用进程消失，无强制终止；CUA 启动未取得 OS 退出码，记录为未知。未编辑或保存模型，历史 9e25 用户授权保存未转移给本轮。[退出后单副本核对](../../target/macos-m4/native-image-save-20261028/native/project-integrity.json)确认 439 文件／1,047,169,524 字节全部未变。

**本轮只通过保存传输、取消、干净往返及 UI 退出的限定检查，导出画质未通过。** WebP／JPEG 实际图像比 PNG 有明显点状噪声，后续诊断定位到固定上游图片捕获缺少稳定渲染锁；限定修复复测见下节，`6095` 本身仍保留失败结果。详见[root 观察与捕获索引](../../target/macos-m4/native-image-save-20261028/native/root-native-observation.json)。未覆盖本构建的 dirty 模型保护、原生写入失败恢复、保存窗口期间退出、360／SOG／视频、大图内存或新的生成。真实睡眠暂留，完整 M3/M4 仍开放。

## 2026-10-28：0f85 稳定图像捕获与限定原生验收

完整 `build.qhJJPk` 的主程序 SHA-256 为 `0f85289e89e606c4732675347c138bf1b922e1bc8c1a49453c487310e6685180`，DMG SHA-256 为 `0a403c7603db77238dd1e8b0d261f67bbcf07eca6705f183917ed8264661c2a5`。同源桥接只在图像捕获期间锁定排序渲染，结束或失败后恢复锁状态、移除监听，并保留用户的持久渲染偏好。比 `6095` 仅桥接及其图像导出测试两份源码变化；[独立源码审查](../../target/macos-m4/image-render-quality-20261028/independent-review.json)和[打包审查](../../target/macos-m4/image-render-quality-20261028/package-review.json)绑定冻结输入与实际可执行文件。

本轮新跑前端 290 项、定向 46 项均通过；定向测试包含 7 项实际固定上游 Scene／render 路径，GPU 和 codec 使用 stub，不能当成原生 GPU 捕获验收。TypeScript 与仅覆盖两份改动文件的 ESLint 通过；738 项 Rust／15 忽略、fmt／Clippy 及 36 项 schema 按[门禁收据](../../target/macos-m4/image-render-quality-20261028/gates.json)的输入范围复用，没有声称重新执行。四份 578 条源码／118 条 overlay 快照一致；快照包围完整前端测试和生产构建，最终 typecheck／定向 lint 较早完成并由冻结审查绑定。

CUA 按精确应用路径启动，原生会话 PID 为 **62152**。在同一既有 Objectron 测试副本中，以标准投影、自定义 **320×240**、透明背景和调试覆盖关闭，实际保存 WebP、PNG、JPEG（质量 90）。三份原文件完整解码通过，WebP 为 VP8L；第四次 JPEG 保存选择 Cancel，没有错误弹窗。随后干净返回 Spark，再进入编辑器成功加载 **614,263** 高斯。本轮没有编辑或保存模型，也没有重新生成工程；用户先前授权的模型保存仍属于历史 `9e25` 会话。

[独立原图对比](../../target/macos-m4/image-render-quality-20261028/native/image-comparison-review.json)检查了新旧六张原文件，确认旧 WebP／JPEG 的明显黑孔点噪在本样本中消失，三格式原尺寸画面一致。PNG／WebP **不是逐像素完全一致**：76,800 个像素中 38 个有 RGB 差异，最大通道差 1，整帧 RGB MAE 为 0.000221；PNG／JPEG MAE 为 0.380469。WebP／JPEG 在各自 PNG 亮度参考掩膜中的近黑点由 2449／2447 降为 0／0，整帧 Laplacian RMS 从 141.78／141.04 降为 35.288／35.480，接近 PNG 的 35.288。指标没有设置通用质量阈值；场景原有模糊边缘和重建碎片仍存在，没有据此声称模型质量改善。

在干净编辑器发出 ⌘Q 后，CUA 返回 `App quit`；[退出观察](../../target/macos-m4/image-render-quality-20261028/native/quit-observation.json)中 `ps` 和精确可执行文件 `pgrep` 均返回 1、输出为空，未强制终止、未重启应用。普通 CUA 启动无法取得子进程 wait 状态，OS 退出码明确为未知。复进证据见[捕获索引](../../target/macos-m4/image-render-quality-20261028/native/editor-reentered/capture.json)；[本轮收尾](../../target/macos-m4/image-render-quality-20261028/native/closeout.json)汇总原生操作、取消目录及测试副本完整性证据。打包时的 `native_acceptance=pending` 是不可变历史收据，由本轮专项证据补充，不转移旧包原生结果。

[取消后核对](../../target/macos-m4/image-render-quality-20261028/native/cancel-integrity.json)确认导出目录仍恰有三张原图，文件大小和哈希未变，`cancelled-export` 及其目标后缀均不存在。[退出后单副本核对](../../target/macos-m4/image-render-quality-20261028/native/project-integrity.json)确认 439 文件／1,047,169,524 字节全部未变；本轮只审计这个授权副本，没有重扫原项目或其他副本。[root 原生记录](../../target/macos-m4/image-render-quality-20261028/native/root-native-observation.json)绑定 16 组图文，收尾 SHA-256 为 `43c50528f48a169698d5380c7ced74f910dadc2471cb4d3fad5bc56748e130e0`。

**本轮仅关闭该样本的实际保存、既有点噪、取消及干净往返／退出缺口。** 未验收本构建的新生成、模型保存、dirty 保护、写入失败恢复、保存窗口期间退出、原生 360、SOG／视频、大图内存或完整 M3/M4。真实睡眠按用户要求暂留；macOS 15、实际 16 GiB、干净主机和 Windows 环境仍不可用。Dock、离线 Finder、物理外接盘、CPU SfM 质量对照及其他未完成矩阵不由本轮关闭；Developer ID、公证、Gatekeeper 与公开发布仍未通过，内部 Alpha、M4=false／public=false 保持不变。


## 2026-10-28：0f85 六次预览往返与内存增长发现

同一已验证应用以普通 CUA 启动，PID 64253；主页完整路径绑定既有 Objectron 授权副本。先确认 Spark 614,263 高斯，再进行六次进入编辑器、加载完成、无修改返回 Spark，每次均重新显示相同数量及可辨的鞋与地毯。本轮没有修改、保存、相机导航或生成，也没有观察到未保存确认或失败提示。[独立视觉复核](../../target/macos-m4/native-preview-cycles-20261028/native/visual-cycle-review.json)实际查看了初始 Spark 及六组往返的 13 张原始截图和 AX，文件身份一致；该复核证明捕获时点，连续操作是否短暂出现提示依据 root 观察。

第 2 轮起在每次点击前记录动作时间；首轮作为热身，不倒推精确加载边界。动作到捕获包含人工操作与截图延迟，不能作为实际渲染耗时。返回项目中心后又独立确认页面没有模型视图；两段有时限的连续采样与之后的单次快照各自保留覆盖及空档，没有拼接成连续记录。WebContent 在相同 viewer 状态下的物理占用随轮次增长，内存稳定性不通过；归属方法、每轮数值和边界详见[资源记录](macos-m3-resources.md#2026-10-28-six-viewer-cycles-and-explicit-webkit-attribution)及[增长发现](../../target/macos-m4/native-preview-cycles-20261028/native/memory-growth-finding.json)。仍需区分泄漏、缓存保留与延迟回收，不能由应用主进程 RSS 较稳推断全部 WebKit／GPU 已释放。

⌘Q 返回 `App quit`；[退出记录](../../target/macos-m4/native-preview-cycles-20261028/native/quit-observation.json)确认主 PID 与精确可执行路径消失，OS 退出码未知，未强制终止。[已观察身份检查](../../target/macos-m4/native-preview-cycles-20261028/native/observed-identities-after-quit.json)对八个已明确归属的旧身份均得到 ESRCH，无未知或仍存身份；不扩展为所有未来 XPC 进程的证明。[单副本审计](../../target/macos-m4/native-preview-cycles-20261028/native/project-integrity.json)确认 439 文件／1,047,169,524 字节完全未变。本轮新增的是六次原生往返、资源归属、内存增长和退出证据，没有新构建、目标硬件验收、真实睡眠、Dock、最小化或原生离线 Finder 生成结果。

## 2026-10-28：6a5 补丁包六轮往返与内存复测

完整 `build.Vw47qp` 候选通过 CUA 精确路径启动，PID 77997；主程序 SHA-256 为 `6a5c7be6e3f40130779674ab1903374da7f9ef4def2ecca5794786a3b7458b8f`。初始 Spark 及六次进入 SuperSplat、无修改返回 Spark 均加载 614,263 高斯。13 份加载画面和前后项目中心的截图／AX 均保存于新目录，未覆盖旧证据。[root 操作记录](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/root-native-observation.json)绑定捕获和逐次动作时间；[独立视觉审查](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/independent-visual-review.json)复核原图、AX 与文件哈希。鞋与地毯可辨，编辑器仍视野较广、主体较小、外围模糊，不声明模型质量改善。操作中未出现未保存确认或失败提示。

每个加载阶段停留至少 30 秒，返回项目中心后停留 142.856 秒，再执行原生 ⌘Q。CUA 返回 `App quit`；[退出确认](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/exit-confirmation.json)对八个已归属进程均得到 ESRCH，两个采样器均退出 0；应用自身 OS 退出码未知。没有强制终止或重启应用。[文件完整性比对](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/project-integrity.json)确认测试副本 439 文件／1,047,169,524 字节完全未变。先前用户授权的保存已在历史 `9e25` 会话完成，本轮未编辑或保存模型。

本轮通过限定的加载、干净往返、项目中心与正常退出检查，**内存稳定性仍不通过**。WebContent 在六次返回 Spark 后的物理占用中位数从约 356 MiB 增至 681 MiB，Home 静置窗口中位数约 632 MiB。原 900 秒采样和延长采样分开保留，分析排除重叠；续流系统压力查询被拒绝并记为未知。完整数值、覆盖、权限及归属限制见[资源记录](macos-m3-resources.md#2026-10-28-patched-candidate-still-shows-native-growth)。条件性 Spark 修复未关闭实机增长发现，下一步需隔离 Spark 与编辑器路径。完整 M3/M4、真实睡眠、Dock、离线 Finder、目标环境与公开发布条件保持开放。

## 2026-10-28：6a5 仅 Spark 的六轮隔离

同一 `6a5c7be6` 包重新启动后，完成初始项目中心、六组打开 Spark／返回项目中心和正常 ⌘Q，全程未进入编辑器。每个加载阶段至少 30 秒，最后项目中心静置 141.093 秒。[root 操作记录](../../target/macos-m4/native-spark-only-isolation-20261028/native/root-native-observation.json)与[独立视觉复核](../../target/macos-m4/native-spark-only-isolation-20261028/native/independent-visual-review.json)绑定 13 张原图、AX 和收据；六次 Spark 均显示 614,263 高斯，鞋与地毯可辨，七次首页无模型视图。首页硬件检测及 GPU 指标仍待获取；截图只证明捕获时点，全程未进编辑器由操作记录补充。

441 个完整资源样本均为系统 normal 压力。WebContent 占用中位数从初始 Home 101.06 MiB 到末次 Home 336.42 MiB，逐轮并非严格单调，**内存稳定性仍未通过**。这说明保留并不要求进入编辑器，尚不能直接定性泄漏或证明具体代码机制的实机贡献。详细表格、真实模块监听器复现及限制见[资源记录](macos-m3-resources.md#2026-10-28-spark-only-isolation-and-shared-resource-diagnosis)。

[退出确认](../../target/macos-m4/native-spark-only-isolation-20261028/native/exit-confirmation.json)记录 CUA `App quit` 后八个已归属 PID 均为 ESRCH；应用 OS 退出码未知，采样器退出 0。[完整性比对](../../target/macos-m4/native-spark-only-isolation-20261028/native/project-integrity.json)确认测试副本 439 文件／1,047,169,524 字节不变，应用可执行文件哈希也未变。本轮未编辑、保存、生成、改变睡眠设置或强制终止。未产生新包，先前授权保存仍只绑定历史 9e25 会话；M3/M4 及外部环境验收保持开放。

## 2026-10-28：ee0f 共享资源修复包的历史待测状态

新 `ee0f0bea` 将 Spark 全屏几何、计算材质和回退纹理改为按底层渲染器管理，显式释放各使用者，保留既有异步排序释放保护。初始化失败时也清理桌面组件已创建的 renderer。[构建收据](../../target/macos-m4/spark-resource-ownership-fix-20261028/acceptance-summary.json)绑定主程序 SHA-256 `ee0f0beaae735811eaee41c068204e434d1208a4422afc1e7e2704fd9a65d1cd`、`build.Lotfbt` DMG SHA-256 `0ee24a97cfd2ffc0858b03c28a7d839ff803a191cf0bcd96cb789f03236aa617`，只读挂载、包体一致性和最终签名检查通过；签名为 ad-hoc，仍是内部 Alpha。

[检查记录](../../target/macos-m4/spark-resource-ownership-fix-20261028/gates.json)包含本轮新跑的 58 项 Spark、292 项前端、typecheck、完整 lint、生产构建及两项运行包预检；Rust 738 项／15 忽略、fmt／Clippy 与 schema 36 项按审查后的历史输入复用，并非本轮重跑。589 项源码输入及 118 项 overlay 在检查／构建前后不变，许可证集合列出 726 个文件且零 issue。

这些模块测试使用真实 Spark／Three 清理代码，但 WebGL 边界与驱动结果为 stub，没有真实 shader 像素或原生内存测量。**本节记录打包当时的准备状态，构建收据的 native-pending 保留为历史事实。** 后续隔离复测另记如下；旧 6a5 失败证据及历史包保留，不转移旧构建的生成、编辑保存或图片导出结果。真实睡眠继续暂留；macOS 15／16 GB／干净机／Windows、其余 M3/M4 与公开分发条件保持开放。

## 2026-10-28：ee0f 六轮 Spark 往返复测与保留内存

同一 `ee0f0bea` 包通过 CUA 精确路径重新启动，完成初始项目中心、六组 Spark／项目中心往返及正常 ⌘Q，全程未进入编辑器。[本轮收尾](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/closeout.json)与[root 操作记录](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/root-native-observation.json)绑定逐次操作和证据。[独立视觉审查](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/independent-visual-review.json)核验 13 张原始截图、对应 AX 和全部采集哈希：六次 Spark 均显示 614,263 高斯及可辨的鞋／地毯，七次 Home 均为项目中心。采集时刻未见当前弹窗、未保存提示、加载／错误遮罩或编辑器工作区；静态图文不证明两次捕获之间的连续状态。外围模糊及未重建黑色区域仍存在，不声明画质改善。

单流资源采集包含 438 个完整样本，系统压力全部 normal。最后 Home 静置 129.859 秒，包含 65 个完整样本。WebContent 物理占用中位数由初始 Home 的 101.68 MiB 到末次 Home 的 345.61 MiB，Home 第 4→5 轮略降，序列并非严格单调。**本轮仍未通过内存稳定性验收**。与旧 6a5 的数值比较仅作描述，不是受控改善／退化评估，也不能定性泄漏或量化该补丁的因果贡献。完整窗口、归属及测量限制见[资源结果](macos-m3-resources.md#2026-10-28-ee0f-native-spark-only-closeout-with-retention-unresolved)。

CUA 在正常 ⌘Q 后返回 `App quit`；[退出确认](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/exit-confirmation.json)记录八个已观测进程身份均为 ESRCH，应用 OS 退出码未知，采样器退出 0。[项目完整性比对](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/project-integrity.json)确认 439 文件／1,047,169,524 字节不变。本轮未编辑、保存或重新生成，历史 9e25 授权保存仍绑定原构建。当时下一步为有界保留路径诊断，再决定生产补丁；随后诊断与 a214 修复／复测见下文，旧失败记录保留。真实睡眠、Dock／最小化、离线 Finder、目标环境、完整 M3/M4 和公开分发条件继续开放。

## 2026-10-28：历史开发诊断与重建前产物检查

临时 `478f67f4` debug 应用在同一 Objectron 测试副本完成六轮 Spark／首页操作，13 个自然采样点、末次首页静置 183.635 秒；另列 2 个 Inspector／GC 诊断点。发现每轮一个 controls／camera／canvas 存活，并以真实 OrbitControls 最小复现确认 DOM 脱离后的监听移除根不匹配。该阶段尚未安装生产补丁；855 个资源样本均 normal，正常 ⌘Q 后 16 个已观测进程实例均不存在，439 个测试副本文件不变。详见[历史诊断记录](macos-m3-resources.md#2026-10-28-developer-census-and-orbitcontrols-root-mismatch)。重建前曾发现历史 `ee0f0bea` Release `.app` 不在原输出路径，原因未知；当时 DMG 哈希仍一致，未恢复或覆盖。该检查与后续独立 `a2146f95` Release 构建分别保留，不能把旧 `.app` 缺失描述为当前包状态。

## 2026-10-28：a214 OrbitControls 生产修复与六轮原生复测

Three 0.185.1 的版本固定补丁保存 OrbitControls 的监听注册根，dispose／disconnect 使用原根清理 Control-keydown 与待处理 keyup，覆盖 DOM 脱离、重复 dispose 和跨根 reconnect。真实模块原始基线 2 通过／16 失败，实际安装补丁后 18 项通过；四个真实 React 卸载用例在相同测试字节下由失败变为通过。修复只改变该依赖的 `OrbitControls.js`，不将这些机制测试称作 WKWebView 内存通过。

[包体收据](../../target/macos-m4/orbit-controls-root-fix-20261028/acceptance-summary.json)绑定 `a2146f9544baf9dde30c4dbfd43371b296796b3c41c2495822024998175251c8` 主程序及 `build.OX71fC` DMG（SHA-256 `3f2ce450159bd3f264cf454f3970da7069a893e8ad449d9f0ddb2fec2db33b0f`）。完整构建退出 0，DMG 只读挂载、包体一致性及最终 ad-hoc 签名检查通过。[本轮门禁](../../target/macos-m4/orbit-controls-root-fix-20261028/gates.json)为新跑前端 296 项／36 文件、Spark 60 项、Three 39 项（18 生命周期／21 来源），以及 typecheck、lint、完整 app／DMG 构建和两项运行包预检；单列 18／4 项已含在完整套件内，不重复相加。Rust 738 项／15 忽略、fmt／Clippy 与 schema 36 项按已审查输入复用，未本轮重跑。597 个来源记录在门禁前、门禁后、构建后快照一致，729 个许可文件／611 条许可文本记录零 issue。快照无内嵌时间戳，时间顺序由 parent 操作记录约束；历史工具链／环境等价未独立证明。

本轮通过 CUA 精确路径启动 `a2146f95`，初始 Home 后完成六组打开 Spark／返回 Home，最后正常 ⌘Q；全程未进入编辑器、编辑保存、相机导航或训练。[操作记录](../../target/macos-m4/native-orbit-root-cycles-20261028/native/root-native-observation.json)与[收尾](../../target/macos-m4/native-orbit-root-cycles-20261028/native/closeout.json)绑定限定序列。[独立视觉审查](../../target/macos-m4/native-orbit-root-cycles-20261028/native/independent-native-visual-review.json)逐张查看 13 个原始 JPEG，并核验 13 份 AX、捕获收据及 26 个载荷哈希。六张 Spark 均显示 614,263 高斯和可辨双鞋／地毯，七张 Home 均为项目中心；捕获时无当前错误、模态框或打开的编辑器。历史列表中的“失败／路径已丢失”不等于本轮错误；外围模糊与未重建黑区仍存在，不声明画质改善或捕获间连续画面均被记录。

末次 Home 静置 140.659 秒，包含 70 个完整样本；全流共 460 个样本。压力／swap 的 sysctl 查询被拒，全部记为 unknown，不能当作 normal 压力或零 swap。以下为同一已归属 WebContent 实例的 Home 窗口中位数，单位 MiB；初始 Home 物理占用为 100.907 MiB。

| Home 轮次 | 物理占用 | RSS |
| --- | ---: | ---: |
| 1 | 184.001 | 384.734 |
| 2 | 200.033 | 426.672 |
| 3 | 203.017 | 515.828 |
| 4 | 245.267 | 519.844 |
| 5 | 208.783 | 555.859 |
| 6 | 211.900 | 560.133 |

物理占用并非严格单调，RSS 同状态轮次间仍呈阶梯增长；结合未知压力条件，尚不能证明“多次预览切换无持续增长”，**本轮内存稳定性不通过**。高于初始基线的残留本身不能证明泄漏，也不据跨包数值宣称受控改善或量化补丁贡献。[资源汇总](../../target/macos-m4/native-orbit-root-cycles-20261028/native/resource-summary.json)与[资源说明](macos-m3-resources.md#2026-10-28-orbitcontrols-root-repair-and-release-observation)保留窗口、身份、采样与归属边界。

[独立退出与完整性审查](../../target/macos-m4/native-orbit-root-cycles-20261028/native/independent-exit-integrity-review.json)32 项通过：观测集合与退出检查集合精确一致，八个 PID／启动时刻／可执行 UUID／路径／coalition 身份均为 ESRCH；439 个完整文件记录相等，合计 1,047,169,524 字节。此为已观测身份的退出证明，不扩展为所有未来 XPC 的全局检查；应用 OS 退出码未知，采样器退出 0。包体收据保留打包当时的 native-pending，后续原生结果单独补充。此轮仅通过已记录的显示、返回、正常退出操作与文件完整性，历史生成、授权保存及图片导出不转移；真实睡眠、Dock／最小化、离线 Finder、目标环境、完整 M3/M4 与公开分发条件仍开放。
