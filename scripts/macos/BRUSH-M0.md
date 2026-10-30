# Brush M0 构建记录与复现

固定源码：[`MinKaiZhi/brush@1388f74c6fe0236f68ee4915564bf00e9d2e3747`](https://github.com/MinKaiZhi/brush/tree/1388f74c6fe0236f68ee4915564bf00e9d2e3747)，workspace 1.0.0。使用 fork CI 对应的 Rust **1.95.0**，保留原始 `Cargo.lock`，默认 WGPU feature，不启用 `brush-cube/metal` 或 `--all-features`。应用自身的 Rust 1.97.0 配置保持不变。

## 复现

在应用根目录运行；`BRUSH_REPOSITORY` 指向已有本地 fork，`RUST_TOOLCHAIN` 指向安装好的 `1.95.0-aarch64-apple-darwin` 工具链目录。脚本不安装或修改全局工具，也不改动原仓库 main。

```sh
git clone --shared --no-checkout "$BRUSH_REPOSITORY" target/macos-m0/brush
git -C target/macos-m0/brush checkout --detach 1388f74c6fe0236f68ee4915564bf00e9d2e3747

PATH="$RUST_TOOLCHAIN/bin:$PATH" \
CARGO_HOME="$PWD/target/macos-m0/cargo-home" \
CARGO_TARGET_DIR="$PWD/target/macos-m0/brush-target" \
CARGO_BUILD_JOBS=4 \
scripts/macos/build-brush.sh --stock target/macos-m0/brush target/macos-m0/brush-build
```

实际训练验证推荐加 `--diagnostics-patch`，使用单独的输出目录
`target/macos-m0/brush-build-patched`。该显式选项应用固定的
[`metorigin-macos.1` 补丁](../../integrations/brush-macos/README.md)，要求 detached checkout，保留原 commit 和依赖锁，只接受这份精确补丁。构建后的 CLI 版本为 `1.0.0+metorigin-macos.1`，JSON 证据另记录 `patch_id` 和 `patch_sha256`。历史原版构建现在必须显式传 `--stock`；当前无选项默认构建为 `.5` 发行候选，见文末 M4 说明。

脚本拒绝错误 commit、脏源码、非原生 arm64 主机、错误 Rust 版本、自定义 Rust flags，以及输出/cache/target 与源码目录重叠。调用参数按独立 argv 传递，支持空格及中文路径。编译固定传入 `--locked --release -p brush-cli --target aarch64-apple-darwin`，SDK 来自 `xcrun`，部署目标为 15.0。

成功后 `brush-build/evidence/` 保存工具链、lock 哈希、help/version、Mach-O 架构与 load commands、二进制 SHA-256，以及可供独立 smoke 核验的 `build-info.json`。该 JSON 只在编译及 CLI 检查成功后生成；失败重跑会移除上一轮的成功凭据。完整本地日志可能含绝对路径，不应提交或直接公开。

## Xcode 27 的实际编译问题

2026-10-26/27，Apple M1 Pro、macOS 27.0.1、Xcode 27.1、SDK 27.0 上，初次编译在 `serde_derive`、`bytemuck_derive`、`zerocopy_derive` 的动态加载阶段失败。`rustc` 表面错误为 `E0463: can't find crate`；详细诊断为 `dlopen: mis-aligned LINKEDIT string pool`。相关 arm64 dylib 实际存在，且包含 `.rustc` 元数据段。

对无依赖 proc-macro 的最小测试取得以下结果：

| 工具链 | `-C strip=debuginfo` | `-C strip=none` |
| --- | --- | --- |
| Rust 1.95.0 | 宏加载失败 | 宏加载及消费端编译通过 |
| Rust 1.97.0 | 宏加载失败 | 宏加载及消费端编译通过 |

配方显式设置 `CARGO_PROFILE_RELEASE_STRIP=none` 并记录在证据中，不更换依赖或修改源码；随后上述宏依赖已成功编译。未来分发若需要 strip，必须在签名和最终文件哈希之前单独验证，不能对已签名包直接剥离符号。

原版实际 release 构建耗时 8 分 30 秒，`brush-cli --version` 为 1.0.0，二进制为 arm64，`LC_BUILD_VERSION` 的 minos=15.0、SDK=27.0；`otool -L` 仅列出 Apple 系统库和 frameworks。原版 binary SHA-256 为 `3d66dab4d53bc688a21802e21ddbd9239ce6b141f016993c8526ec2be7e60b72`，原始 Cargo.lock SHA-256 为 `ff67adb6a9f772bdd648d645a66207198e79b1a7d532f3fbb4b453fbcf835d71`。这没有验证 macOS 15 真机。

原版使用 CPU SfM 已注册的 40 张 CC0 火山弹照片，完成 300 步训练，生成 100/200/300 步三个完整 checkpoint；最终 43,998 个 Gaussian，SH0，2,464,389 bytes，所有记录为有限值，规范化输入哈希未变化。wall time 16.90 秒，进程最大 RSS 为 301,350,912 bytes，`time -l` 另报 peak memory footprint 2,414,478,536 bytes，二者不可当成同一内存指标或整个系统物理内存占用。未执行 held-out eval 或视觉质量验收。

该原版运行状态保留为 `training_passed_backend_unverified`：训练成功，但 WGPU 初始化早于 CLI logger，真正的 AdapterInfo 未被记录；后续 `backend: Auto` 不能证明具体 Metal 设备。上述诊断补丁补齐这处证据缺口，补丁版必须单独重新训练。

诊断补丁版已在相同数据集完成第二次 300 步训练，记录到实际初始化的 `AdapterInfo { name: "Apple M1 Pro", device_type: IntegratedGpu, backend: Metal, ... }`，最终 44,014 个 Gaussian，2,465,285 bytes，三个 checkpoint 完整、输入哈希不变。此次使用已热的 CubeCL autotune 缓存，wall time 5.742 秒、最大 RSS 283,787,264 bytes、peak footprint 308,511,824 bytes、运行前后 swap 为零。不得将其相对于冷启动的性能/内存差异归因于诊断补丁；资源预算必须覆盖冷启动峰值。

源码补丁的 CLI 7 项原生单元测试、两个改动库的 Clippy（`-D warnings`、默认 features）和 Rust 格式检查已通过。源码准备/构建配方另有离线防护测试；完整 CPU SfM → 去畸变 → Brush 的证据与最低系统、视觉和安装包验证仍分别记录。

最终 lint 修复后的补丁 SHA-256 为 `00f507d8d14290232f2ddc02d5cffed88f127044a0bb3bd9e19ea9055929aadb`；其改动仅为文档注释，重建后的二进制与此前诊断版逐字节相同，SHA-256 均为 `c833c5a02aeab088eb536801e845aef1c8108ccea46b573fa28fab56a70b9f20`。最终产物另固定保存在 `target/macos-m0/brush-artifacts/<binary-sha256>/brush-cli` 和同目录 `build-info.json`，后续实验应引用稳定路径，避免编译覆盖正在使用的引擎。

该最终产物的第三次独立 300 步验证再次通过：实际 Apple M1 Pro/Metal、43,996 个 SH0 Gaussian、最终 PLY 2,464,277 bytes、SHA-256 `2b3484612a4e913d0b6431e55b65c48bc6302d411404d9fc6fa65aca89ff7ecf`，三个 checkpoint 完整、输入未变化。warm-cache wall time 8.108 秒、最大 RSS 314,638,336 bytes、peak footprint 336,184,472 bytes。相同 seed 的 GPU 运行仍有轻微点数差异，不要求 PLY 逐字节相同，也不据此宣称质量评估已通过。

## 内嵌权重与边界

此固定源码没有 `.gitattributes`，`crates/lpips/burn_mapped.bpk` 为实际约 28 MiB 的二进制，非 Git LFS 指针，SHA-256 为 `ff80f1f56a24c6021d1e82b9957f92ee9a28d1b2fef4198e8ad1eedfbb93c252`。LPIPS crate 使用 `include_bytes!` 引入它；训练默认 `lpips_loss_weight=0.0`，只有该值大于零时才初始化 LPIPS 模型。

权重存在只能证明该编译资源可获得。源码中的转换器读取 `lpips_vgg_remapped.pth`，当前检查未找到单独说明权重来源与分发权限的文件；M4 仍须核实，不能将项目 Apache-2.0 许可证自动视作权重许可证。

```sh
python3 -m unittest discover -s scripts/macos -p 'test_*.py' -v
```

`test_build_brush.py` 使用模拟工具验证构建配方的防护和失败处理，不证明引擎或 GPU 可用。真实 CPU SfM、Metal 训练、完整 PLY 和资源记录由 `smoke-engines.py` 单独取得。CLI 构建完成不能替代 macOS 15 真机、原生预览或独立安装包验收。

### M4 权重分发处理（2026-10-27）

后续审查已决定默认发行构建排除 LPIPS BPK：无法把本地
`lpips_vgg_remapped.pth` 与精确上游权重、重映射脚本和完整授权链对应。
`metorigin-macos.5` 默认 feature 不编译 `lpips`，对正 LPIPS loss 权重明确报错；
`.3/.4` 仅保留为此前验证产物。详见
[完整审查与实现政策](../../integrations/brush-macos/LPIPS-AUDIT.md)。


当前默认发行候选为 `metorigin-macos.6`：在 `.5` 的无 LPIPS 权重策略上，
排除默认 native Rerun/hex-slice，并以独立 ProgressLogger 删除缺 notice 的
indicatif-log-bridge。仅锁文件对应依赖/包条目删除，无版本升级。历史 `.5`
通过 `--lpips-policy-patch` 重现；`.6` 使用独立 `brush-v6` / `brush-v6-target`，
不覆盖运行中的 `.5`。默认构建不启用研究 feature、all-features 或 native MSL。
