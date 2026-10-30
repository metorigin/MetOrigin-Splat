# macOS 原生引擎验证脚本

本目录用于实施方案的 macOS 引擎构建及验证。构建产物和完整日志存入忽略的 `target/macos-m0/`、`target/macos-m1/` 等目录；引擎构建或 mock 测试通过不代表桌面生成或独立安装包验收通过。

完整应用与 DMG 的操作命令见 [macOS 安装包打包命令（中文）](../../docs/macos-packaging.zh-CN.md)。

## FFmpeg / FFprobe 8.1.2

固定上游 `n8.1.2` tag 的 peeled commit 为 `38b88335f99e76ed89ff3c93f877fdefce736c13`。使用干净隔离 clone，原生 AppleClang，arm64 / minos15.0；不安装到系统目录。

```sh
bash scripts/macos/build-ffmpeg.sh --jobs 4
python3 -m unittest discover -s scripts/macos -p 'test_build_ffmpeg.py' -v
python3 scripts/macos/smoke-ffmpeg.py \
  --install-dir target/macos-m0/ffmpeg-install \
  --video target/macos-m1/video-fixture/james40.mp4 \
  --output target/macos-m1/ffmpeg-media-01
```

配方禁用 GPL、nonfree、version3、自动外部库探测、网络及硬件解码；显式启用系统 zlib，保留 JPEG/PNG 和软件视频解码。采用 LGPL-2.1-or-later shared libraries，install name 为 `@rpath`，程序 rpath 为 `@executable_path/../lib`，库 rpath 为 `@loader_path`。保留许可证文本。Xcode 27 的 host build 同样需要显式 SDK 参数；仅给 target compiler sysroot 不足以找到 host 工具的 C 标准库头文件。

2026-10-27 实测 FFmpeg SHA-256 `b6ca65238b5a4ce39650087cc471885534b8fb61ebba309c9fe748bbe4fb6f40`，FFprobe `11c61497f8d8cc6294b7e87941f4e28dec6c17a28e4e996b13a1cf5014e963b6`。完整库清单、版本、配置及 load commands 在 `ffmpeg-build/build-info.json` 等证据中。将 bin/lib 复制到含中文与空格的新目录、清除继承的 PATH/DYLD/Conda 覆盖后，版本、MPEG4 解码、JPEG/PNG 编解码和 90° 元数据自动旋转均通过。记录位于 `target/macos-m1/ffmpeg-media-01/evidence.json`；这是当前主机上的重定位测试，不能替代 macOS 15 干净机器验收。

测试视频由已固定 hash 的 James40 CC0 照片按 2 fps 编码为 20 秒、960×638、40 帧 MPEG4，用于工程链路测试，不能描述为另行实拍的视频。实际命令如下，输出必须不存在：

```sh
target/macos-m0/ffmpeg-install/bin/ffmpeg -nostdin -hide_banner -n \
  -framerate 2 -start_number 1928 \
  -i target/macos-m0/datasets/james-sample-40/images/IMG_%04d.jpg \
  -frames:v 40 -vf scale=960:-2 -an -c:v mpeg4 -q:v 2 -pix_fmt yuv420p \
  target/macos-m1/video-fixture/james40.mp4
```

## COLMAP CPU

固定源码为上游 4.1.0：`fa8e3b3ff591552855f8ad2806723c80f963f69c`。使用隔离 clone，保留用户 fork 的 main。[COLMAP-M0.md](COLMAP-M0.md) 给出源码获取、公开依赖锁、许可证限制和完整复现步骤。

安装开发依赖的命令（需要已有 Conda，不改变 base）：

```sh
CONDA_PKGS_DIRS="$PWD/target/macos-m0/conda-pkgs" \
CONDA_ENVS_PATH="$PWD/target/macos-m0/conda-envs" \
CONDA_REPORT_ERRORS=false ANACONDA_ANON_USAGE=no \
conda create --prefix "$PWD/target/macos-m0/colmap-deps" \
  --override-channels --channel conda-forge --no-default-packages --yes \
  --file scripts/macos/colmap-m0-deps.explicit.txt
```

实际构建命令：

```sh
scripts/macos/build-colmap.sh \
  --deps-prefix "$PWD/target/macos-m0/colmap-deps" --jobs 4
```

2026-10-26 在 Apple Silicon/macOS 27.0.1 上，使用 AppleClang 21.0.0、SDK 27.0，已完成固定源码的 CPU-only arm64 编译、安装、CLI help 验证。二进制 `LC_BUILD_VERSION` 的 minos 为 15.0；这尚未证明能在 macOS 15 真机运行。主要依赖为 Ceres 2.2.0、Eigen 5.0.1、OpenImageIO 3.2.1.2、Boost 1.90.0、LLVM OpenMP 23.1.4，全部包 URL 与 SHA-256 见显式锁。

实际 `global_mapper --help` 仍将 `GlobalMapper.gp_use_gpu` 和 `GlobalMapper.ba_ceres_use_gpu` 默认为 1，CPU 命令必须显式传 0。feature、matching、incremental mapper 的相应默认值为 0，验证流程仍显式传 0。

开发版可执行文件为 `target/macos-m0/colmap-install/bin/colmap`，此次 SHA-256 为 `19270b456f5a95e138cdd03ac4d659ad898fb273e5179d3dd02c59a06e35e6a8`。受限 PATH (`/usr/bin:/bin`) 的 `--help` 已通过，但运行仍依赖开发 prefix 的 dylib，不能当作干净机或可分发证明。该环境内的 FFmpeg 9.x 和 GPL 传递依赖不能替代计划的 FFmpeg 8.1.2 发行配方。

```sh
python3 scripts/macos/test_build_colmap.py
python3 scripts/macos/verify_colmap_help.py target/macos-m0/colmap-build/help
```

上述 14 项离线测试覆盖 recipe 拒绝错误源码/脏源码/错误平台、结构化路径参数、输出路径逃逸、失败重试清理证据，以及 help 中缺失 CPU flag 的拒绝行为；实际 help 校验另在编译产物上执行。CPU SfM、去畸变与训练的实测记录由 M0 smoke 报告单独保存。

## Brush WGPU / Metal

[BRUSH-M0.md](BRUSH-M0.md) 记录固定 Brush 1.0.0 的 Rust 1.95 默认 feature 构建、Xcode 27 的 strip 问题、原生测试与真实 300 步训练结果。[诊断补丁](../../integrations/brush-macos/README.md) 使用实际初始化的 AdapterInfo 补齐 Metal 证据，保留用户 fork main。构建使用 `build-brush.sh --diagnostics-patch`，成功后读取 `evidence/build-info.json`；源码准备与 recipe 的离线测试并入本目录 `test_*.py` discovery。

真实照片 CPU SfM、去畸变、训练及 PLY 检查使用 `smoke-engines.py`。每次实验用新的输出目录和固定哈希的引擎路径，构建与训练证据分别保存。上述结果仍不能代替应用流程、视觉质量或独立安装包验收。


`check-brush-contract.py` 验证当前 `--training-contract-patch` 构建的机器协议、
真实 loader 线程限制、args.txt 显式默认值覆盖、完整 PLY 原子发布、导出失败和
中断后的 PLY warm start。调用方法与协议见
[Brush 集成说明](../../integrations/brush-macos/README.md)。该脚本只复制已有规范化
fixture，输出必须是新目录；不修改原始数据，也不替代应用 adapter 的集成测试。


`check-brush-live.py` 针对 `--live-preview-patch` 的 Brush 1.x 主 CLI 运行协议 1
真实请求/ACK 消费和 baseline/live 内存观察，读取完整 PLY 后才发送 ACK。
它要求二进制已声明 `live_preview` 和 `ply_request_ack_v1`；不改写现有
Windows 0.3 companion。测量仅涵盖引擎进程，不含 WebView 或旧新 mesh 重叠。

macOS 发行候选应使用默认 `.6` 或 `--distribution-patch`。该版本编译时排除
来源授权链尚未完整确认的 LPIPS 权重，`lpips-loss-weight>0` 明确失败，保留
`.4` 实时协议和训练合约。旧配方的 stock 行为现在须显式传 `--stock`，仅用于
历史验证。详见 [LPIPS 审查](../../integrations/brush-macos/LPIPS-AUDIT.md)。
构建自动执行 `check-brush-distribution.py`，保存默认 CLI 依赖树、权重载荷排除
检查和机器能力声明；已有 contract/live 脚本也适用于 `.5` / `.6`。
`.6` 另外从默认依赖图排除 Rerun/hex-slice，移除 indicatif-log-bridge，
以独立日志适配器保持 stdout/filter/进度条行为。显式或 args.txt 中启用
Rerun 会明确失败；`native-rerun` 仅为需要另行许可审查的研究 feature。
历史 `.5` 用 `--lpips-policy-patch` 重现，所有版本使用独立源码/输出目录。
