# macOS 原生引擎验证脚本

## 当前路径入口（2026-11-01）

当前脚本通过 [`engine-paths.json`](../../packaging/shared/engine-paths.json) 解析引擎与原生构建路径，缓存根目录仍由 `cache-paths.json` 决定。Node 调用方使用 `scripts/shared/engine-paths.mjs --key KEY`；原生配方使用只依赖 Python 标准库的 `engine_paths.py`，不额外要求 Node。

| 用途 | 默认位置 |
| --- | --- |
| 开发运行引擎：FFmpeg 8.1.2、COLMAP 4.1.0、Brush `.5` | `.engines/macos-arm64/development/` |
| 开发 COLMAP 依赖前缀 | `.engines/macos-arm64/development/colmap-deps/` |
| 原 Alpha `.6` 完整包输入 | `.engines/macos-arm64/distribution/` |
| 旧 pack 与原始 Brush artifact | `.engines/macos-arm64/archive/` |
| 原 COLMAP 依赖环境、开发安装证据 | `.engines/macos-arm64/archive/colmap/{dependencies-original,development-original}/` |
| 固定原生源码 | `.cache/metorigin/sources/engines/macos-arm64/` |
| 迁入的旧构建树、原证据 | `.cache/metorigin/build/engines/macos-arm64/imported/` |
| 新原生构建输出 | `.cache/metorigin/build/engines/macos-arm64/native/` |
| 共享 Cargo 包缓存 | `.cache/metorigin/downloads/cargo/macos-arm64/` |
| Conda 包缓存 | `.cache/metorigin/downloads/conda/macos-arm64/` |

迁入的 Cargo/CMake/FFmpeg 构建树仍包含当时的绝对路径，保留作历史记录，不直接增量续编。当前重编译入口默认使用独立 `native/` 输出；下面的开发 COLMAP 命令显式选择稳定开发安装目录，其他默认命令不会自动替换稳定开发引擎。所有重编译都不替换冻结分发包。显式 `CARGO_HOME`、`CARGO_TARGET_DIR` 优先于默认值；Brush 配方仍固定 Rust 1.95.0，应用自身使用 Rust 1.97.0。

从仓库根目录只读查看当前路径：

```sh
python3 scripts/shared/engine_paths.py --repo-root "$PWD" --key developmentRoot
node scripts/shared/engine-paths.mjs --key distributionRoot
```

日常应用打包不需要重编译引擎。选择重编译 FFmpeg 时，入口为：

```sh
bash scripts/macos/build-ffmpeg.sh --jobs 4
```

开发 COLMAP 使用原有 171 包显式锁，由 Conda 原生安装到新的 canonical 前缀，不手工修改 dylib 或固定前缀字段。新建环境时，先准备锁中全部包的本地缓存；以下命令只离线安装，缓存缺包时会失败。目标前缀必须不存在，已有匹配环境时跳过创建，不在旧环境上覆盖安装。本轮迁移保留的原环境和原开发安装仅用于历史来源审计。

```sh
colmap_deps="$(python3 scripts/shared/engine_paths.py --repo-root "$PWD" --key colmapDependencyPrefix)"
conda_cache="$(python3 scripts/shared/engine_paths.py --repo-root "$PWD" --key condaPackageCache)"
CONDA_PKGS_DIRS="$conda_cache" \
CONDA_REGISTER_ENVS=false CONDA_NO_PLUGINS=true \
CONDA_REPORT_ERRORS=false ANACONDA_ANON_USAGE=no \
conda create --solver classic --offline --copy --prefix "$colmap_deps" \
  --no-default-packages --no-shortcuts --yes \
  --file scripts/macos/colmap-m0-deps.explicit.txt
```

本轮前缀迁移使用隔离的临时包缓存执行上述 Conda 原生安装，`CONDA_PKGS_DIRS`、`CONDA_ENVS_PATH` 与 `CONDARC` 均指向本轮临时目录，保护历史原包缓存不变。普通首次重建可使用上面共享包缓存入口；`--copy` 让新环境与缓存文件分离，不直接复制或修改已经安装的旧 prefix。显式锁仍是同一份 tracked 文件，其 171 个原始 HTTPS URL 与 SHA-256 不替换。

环境就绪后，在全新的 `native/colmap-development/build/` 构建树重建 COLMAP 4.1.0，并显式安装到开发引擎目录。保留原开发 profile：CGAL、LSD、MVS、downloads 均为 ON，不使用 `--alpha-profile`。以下复用迁入证据中的固定 PoseLib/Faiss 源码，避免重新获取依赖源码；构建树本身不复用旧 CMake 缓存。

```sh
colmap_deps="$(python3 scripts/shared/engine_paths.py --repo-root "$PWD" --key colmapDependencyPrefix)"
colmap_install="$(python3 scripts/shared/engine_paths.py --repo-root "$PWD" --key colmapInstall)"
colmap_original_build="$(python3 scripts/shared/engine_paths.py --repo-root "$PWD" --key colmapDevelopmentBuildEvidence)"
bash scripts/macos/build-colmap.sh \
  --deps-prefix "$colmap_deps" --install-dir "$colmap_install" \
  --dependency-sources "$colmap_original_build/_deps" --jobs 4
```

`build-colmap.sh` 的 `--deps-prefix` 默认仍为空；上述命令显式选择开发依赖环境。原 `colmap/` 安装须先完成保留，不能用此命令覆盖唯一的原始审计输入。新构建须单独保留哈希、配置与实际验证结果，不能继承原开发二进制的证据或据此宣称可移植。要另建 Brush `.6`，先将 Rust 1.95.0 的 `bin` 放入 PATH，并选择其固定源码：

```sh
brush_source="$(python3 scripts/shared/engine_paths.py --repo-root "$PWD" --key brushSource.6)"
bash scripts/macos/build-brush.sh --distribution-patch "$brush_source"
```

上述命令是选择重编译时的入口，不能用来追认原 Alpha `.6`。日常完整应用打包继续读取原分发包的 2,999 个文件，清单 SHA-256 为 `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`。`pack-engines.py` 默认使用迁入的审计输入，Conda 来源明确选择 `colmapAlphaDependencyEvidence` 对应的原环境，不混用新开发前缀；先应用 `--repo-root` 再解析默认路径，并从 Brush artifact 的 `patch_id` 选择对应源码。新输出必须单独验证。其历史 `--pack-version` 默认值仍为 `0.1.0-alpha.1`，不是当前 Alpha `.6` 的身份声明。

Mac 引擎直接读取 `.engines/macos-arm64/` 下的 canonical 路径；`target/macos-m0/colmap-deps`、`target/distribution/macos-arm64` 两个兼容入口均退役，pnpm 开发或构建不再创建它们。准备阶段会先核对引擎包身份，再迁移保存的旧分发路径；其他自定义设置保留。`cargo clean` 后不需要恢复引擎链接，也不影响稳定引擎和正式报告。

已有平铺 `.engines/ffmpeg`、`.engines/colmap`、`.engines/brush` 作为指向新开发目录的兼容入口。Mac debug 默认选新开发目录，显式开发环境变量仍优先；将已有设置路径映射到同一份已验证引擎包，不改变引擎身份。Windows 引擎版本和 Release 完整性规则不变，Release 继续使用随包资源。本机旧位置到新位置的对应关系见 [引擎迁移映射](../../.engines/macos-arm64/migration-map.json)。原映射和 stage-4 回执保留，前缀退役与重编译新增后继记录。已有项目的历史引擎哈希不批量改写，下次主动启动或恢复训练时由 preflight 识别当前引擎并处理阶段失效。路径整理不等于新的训练、干净机或安装包验收。

2026-11-01 本机已完成 canonical 前缀重建与有限验证：COLMAP 4.1.0 保留上述开发 profile，新可执行文件 SHA-256 为 `23fbd89c03f8972396748d558c552fc84fdfe915bd92009465417c686a70c6ee`。在旧 `target/macos-m0` 实际不存在时，126 个 Mach-O 闭包文件的签名验证通过，无旧路径命中；JPEG、PNG 两张合成图完成 CPU 特征提取与匹配，共 2,889 个关键点、1,278 个匹配。实际范围与结果见 [native-validation.json](../../artifacts/verification/macos-arm64/colmap-development-prefix/native-validation.json)；这不代表完整 3DGS 训练、新 DMG 或干净机验收。

## 历史配方与记录（原文保留）

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

固定源码为上游 4.1.0：`fa8e3b3ff591552855f8ad2806723c80f963f69c`。使用隔离 clone，保留用户 fork 的 main。[COLMAP-M0.md](../../docs/archive/engines/COLMAP-M0.md) 给出源码获取、公开依赖锁、许可证限制和完整复现步骤。

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

[BRUSH-M0.md](../../docs/archive/engines/BRUSH-M0.md) 记录固定 Brush 1.0.0 的 Rust 1.95 默认 feature 构建、Xcode 27 的 strip 问题、原生测试与真实 300 步训练结果。[诊断补丁](../../integrations/brush-macos/README.md) 使用实际初始化的 AdapterInfo 补齐 Metal 证据，保留用户 fork main。构建使用 `build-brush.sh --diagnostics-patch`，成功后读取 `evidence/build-info.json`；源码准备与 recipe 的离线测试并入本目录 `test_*.py` discovery。

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
