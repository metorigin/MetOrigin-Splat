# macOS M0 引擎验证记录

开始日期：2026-10-26，实测更新至 2026-10-27。状态：**M0 独立引擎 smoke 已通过，正在推进 M1 应用接入**。真实 CPU 重建、实际 Metal adapter、300 步训练与有效 PLY 均已取得证据；本记录不构成完整 macOS 支持或安装包验收声明。完整范围见[实施方案](../macos-gaussian-generation-plan.zh-CN.md)。

应用分支为 `codex/macos-gaussian-generation`。引擎隔离 checkout、构建依赖、日志、素材与输出均放在 Git 忽略的 `target/macos-m0/`；不修改两个用户 fork 的 main，不上传素材。

## 环境与固定输入

| 项目 | 实测或固定值 |
| --- | --- |
| 主机 | Apple M1 Pro，32 GB，arm64 |
| 系统 | macOS 27.0.1，build 26A434 |
| Xcode / SDK | Xcode 27.1（27A9275），macOS SDK 27.0 |
| 最低部署目标 | 15.0；尚未在 macOS 15 机器验证 |
| Brush | `MinKaiZhi/brush`，`1388f74c6fe0236f68ee4915564bf00e9d2e3747`，1.0.0 |
| Brush 编译器 | 已安装的 Rust / Cargo 1.95.0，与固定源码的 CI 配置一致 |
| COLMAP | 上游 release 4.1.0，目标 commit `fa8e3b3ff591552855f8ad2806723c80f963f69c` |
| 应用编译器 | 项目要求 Rust 1.97.0；不因 Brush 工具链更改应用要求 |

`system_profiler` 报告 Metal 支持，只能作为系统信息。GPU 初始化、训练内核、反向传播及 PLY 导出须另外实测。环境收集脚本只保留设备型号、内存、工具版本等白名单字段，排除序列号、UUID、用户名和原始错误输出。

```sh
python3 scripts/macos/collect-environment.py \
  --rust-bin "$BRUSH_RUST_BIN" \
  --output target/macos-m0/environment.json
python3 -m unittest discover -s scripts/macos -p 'test_*.py' -v
```

`BRUSH_RUST_BIN` 指向已安装 Rust 1.95.0 的 bin 目录。工具安装位置不写入此文档。

## 当前结果

- 已核对应用分支，保留原方案及索引变更。
- 已读取实施方案、constitution 与适用仓库指令。
- 已创建两个隔离引擎 checkout；Brush 固定在审计 commit。
- Brush 已以 Rust 1.95.0、原始 Cargo.lock、默认 WGPU features 真实构建成功，arm64 / minos15.0 / SDK27.0。初次下载的代理阻碍已解除。随后复现了本机 Xcode 27 的 `strip=debuginfo` 过程宏 LINKEDIT 对齐错误；固定配方改为 `CARGO_PROFILE_RELEASE_STRIP=none` 后通过，详见 [Brush 记录](../../scripts/macos/BRUSH-M0.md)。
- COLMAP 已真实编译并安装，help 报告 `4.1.0 (Commit fa8e3b3f, without CUDA)`，六类命令均正常启动。主程序为 arm64，Mach-O minos=15.0 / SDK=27.0。
- COLMAP 开发依赖安装于项目内独立 conda prefix，不改变系统工具。实测依赖包括 Ceres 2.2.0、Eigen 5.0.1、Boost 1.90.0、OpenImageIO 3.2.1.2、LLVM OpenMP 23.1.4。开发依赖含 GPL 配置及传递的 FFmpeg 9，**不是计划中的最终发行包**；FFmpeg 8.1.2 和许可证/动态库闭包仍须在 M4 单独构建、审查。
- `global_mapper --help` 实测仍默认 `gp_use_gpu=1` 和 `ba_ceres_use_gpu=1`，CPU 构建不能代替运行时显式传 `0`。其他 CPU 参数也按方案显式传入。
- COLMAP 在清理后的 PATH 下可启动，但仍通过 M0 rpath 引用开发依赖 prefix，不能据此认定干净机器可运行。
- 应用既有核心基线：Rust 1.97.0，`cargo test --locked --offline -p splat-domain -p splat-process -p splat-hardware -p splat-engine-brush -p splat-engine-colmap`，275 passed / 0 failed / 1 ignored。这是核心回归基线，不是完整 workspace、Windows 或原生 UI 验收。
- 环境记录脚本的自动测试覆盖隐私白名单、缺失工具、失败输出处理和原子替换失败保护。

## 真实照片与引擎结果

采用 Mike R. James / Stuart Robson 的 [CC0 样品照片集 v1](https://doi.org/10.6084/m9.figshare.9120020.v1)，固定 `IMG_1928.jpg` 至 `IMG_1967.jpg` 共 40 张。逐图 SHA-256 已纳入[fixture manifest](../../packaging/macos-arm64/fixtures/james-sample-40.json)。完整归档 611,535,084 bytes 已下载并验证 provider MD5 `a62826fd45a89551a548897cf6b62b01` 和 SHA-256 `b0d0995be5652d453fdb0d809a364ccd4a8a5040cae35fb6e748f0ff1783d2d1`；重新完整解压后的 40 图 hash 与首次 CRC 核验提取结果一致。照片和模型不进入源码仓库。

| 路径 | 注册 | 稀疏点 | 平均重投影误差 | mapping | undistort |
| --- | --- | --- | --- | --- | --- |
| incremental CPU | 40/40 | 36,910 | 0.520280 px | 26.296 s | 21.599 s |
| global CPU | 40/40 | 36,498 | 0.507404 px | 24.462 s | 31.746 s |

CPU 特征提取耗时 29.554 s，exhaustive matching 30.617 s；global 对照使用完成后的匹配数据库副本。两条路径都显式关闭 feature/matching/BA 的 GPU，global 另关闭 GP GPU。去畸变图像均为 960×638，与 PINHOLE 相机内参一致；源素材 hash 不变。初次 CPU 路径未测 RSS，不能用它确认内存档位。

未经源码补丁的 Brush 对 incremental dataset 完成 300 步训练，得到完整 checkpoint100/200/300。最终模型为 43,998 个 Gaussian、SH0、2,464,389 bytes；已逐个检查有限浮点值、必要属性、stride 与完整 payload。最终 PLY SHA-256 为 `dfc1871ed45bb6145f7925fd71142738da51a00a866f3df70262f836c2e31d91`。训练 wall time 16.90 s（含首次 autotune），`time -l` 报 maximum RSS 301,350,912 bytes、peak footprint 2,414,478,536 bytes；这些不是完整应用/系统统一内存预算。训练前后系统 swap 报 0；规范化 dataset 的 hash 未变。

上述原版日志只输出 `backend: Auto`，因为 CLI 在 WGPU 初始化之后才安装 logger。随后以最小诊断补丁 `1.0.0+metorigin-macos.1` 重新构建并独立运行，记录实际 adapter 为 **Apple M1 Pro / IntegratedGpu / Metal**。补丁 SHA-256 为 `00f507d8d14290232f2ddc02d5cffed88f127044a0bb3bd9e19ea9055929aadb`，二进制 SHA-256 为 `c833c5a02aeab088eb536801e845aef1c8108ccea46b573fa28fab56a70b9f20`；原始 source commit、补丁 hash 与稳定产物均保留在 build-info 中。

最新独立训练 `brush-training-03` 为 300 步、40 views、43,996 Gaussian、SH0，三个 checkpoint 均完整有效。最终 PLY 2,464,277 bytes，SHA-256 `2b3484612a4e913d0b6431e55b65c48bc6302d411404d9fc6fa65aca89ff7ecf`；wall 8.108 s、maximum RSS 314,638,336 bytes、peak footprint 336,184,472 bytes。首次与后续运行受到冷/热 autotune 缓存影响，不能把性能差异归因于诊断补丁。

统一 harness `smoke-complete-01/evidence.json` 记录 `engine_smoke_passed`：从原始 40 图重新运行 CPU SfM、去畸变、实际 Metal 训练 300 步，得到 43,988 Gaussian / SH0 / 2,463,829 bytes 的有效最终 PLY。harness 在各阶段及结束时校验引擎二进制 hash/build-info，源图与规范化 dataset 未改变。

另一次独立 CPU 资源记录 `smoke-incremental-02-rss`：40/40 注册、36,910 points、0.520457 px；feature 21.375 s / RSS 2,268,332,032 B，matching 23.051 s / 354,959,360 B，mapping 23.789 s / 334,970,880 B，undistort 15.469 s / 850,427,904 B。这些阶段峰值不能相加作为应用统一内存峰值，也不能代替 16 GB 机器验收。

完整命令、build-info、日志与 hash 位于忽略目录的 `colmap-build/`、`brush-build/evidence/`、`smoke-incremental-01/`、`colmap-diagnostic/`、`brush-training-01/`。复现入口见[脚本 README](../../scripts/macos/README.md)及[fixture 使用说明](../../packaging/macos-arm64/fixtures/README.md)。

## Unix 生命周期修复（MAC-08 的独立部分）

`splat-process` 新增独立 Unix PGID，取消先发 TERM、500 ms 宽限后发 KILL，正常父进程退出也清理留存后代，再等待输出管道结束。取消与后台清理共用组所有权，已完成组不被迟到取消再次发送信号；任务 abort/drop 有同步清理保护，应用自身进程组被显式拒绝。直接子进程回收和输出流等待有时间上限。Windows 的 `taskkill /T /F` 路径保留。

先加入三项回归测试，旧实现均失败：取消后持续写入、父退出后管道挂住、超时后后代残留；修复后三项通过。另覆盖应用组拒绝、保留 handle 时的任务 abort、首次 poll 前运行时关闭，以及 Darwin zombie-only 进程组暂时返回 EPERM 的回收竞态。当前 process crate 43 项单元测试通过，1 个 doctest 通过、1 个忽略；完整 workspace 478 passed / 0 failed / 5 ignored（14 suites）。workspace Clippy（`--all-targets --all-features -- -D warnings`）及格式检查通过。后续并行模块变更将继续执行相关检查；Windows 原生进程树/应用构建仍待对应平台验证。

新增 Unix 直接依赖复用 lock 中既有的 `libc 0.2.186`（MIT OR Apache-2.0），未升级版本或引入新下载包；作用仅为 POSIX PGID 信号调用。未更改项目持久化结构或 Tauri DTO。

## 尚需取得的证据

| 验收项 | 当前状态 |
| --- | --- |
| 固定 COLMAP release 源码核验 | 已核验目标 commit |
| Brush / COLMAP 原生 arm64 编译 | 均已通过 |
| 实际 CLI help 与 CPU flag 兼容 | 已通过 |
| 有许可且固定 hash 的照片素材 | CC0 40图及完整归档均已固定并验证 |
| CPU 特征、匹配、mapper、去畸变 | 两类 mapper 均已实测通过 |
| Metal 300 步训练、有效最终 PLY | 实际 Metal adapter、训练及 PLY 均通过 |
| 实际 backend、性能、资源记录 | CPU 各阶段、Brush、真实 adapter 及统一 harness 均有记录 |
| 独立 CLI 与应用 adapter 一致 | M1 待实施 |
| 实时、恢复、内存治理、原生查看编辑 | M2/M3 待实施 |
| 自包含 app/dmg、干净机和 Windows 回归 | M4 待实施 |

M0 已通过，可以推进 M1。测试 harness 的模拟进程通过仅证明脚本行为，不能替代上表的真实引擎结果。当前主机为 macOS 27 / 32 GB；macOS 15 和 16 GB 档位仍待实机验证。

## Constitution 检查

本阶段新增开发验证工具及统一 runner 的 Unix 生命周期修复，未改变应用分层、Windows 引擎契约、项目格式、数据库或 Tauri 权限。验证记录原子替换；工具失败保持显式未知/失败状态。构建依赖与素材不进入源码仓库，来源、许可和校验值在采用前核验。脚本测试与真实引擎记录分开；Rust 变更执行相关单元、完整 workspace、格式和 Clippy 检查。Windows 原生验证及后续完整应用验收仍是未完成门槛。
