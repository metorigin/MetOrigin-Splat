# COLMAP 4.1.0 CPU 开发构建

这些文件只建立 M0 开发环境。它们不会修改 Windows 引擎锁、用户 fork 的 main 或应用数据库，也不构成可分发的 Mac 引擎包。

## 隔离源码

在应用仓库根目录执行。`COLMAP_FORK` 指向现有本地 fork；目标目录必须尚不存在。

```sh
mkdir -p target/macos-m0
git clone --no-hardlinks --no-checkout "$COLMAP_FORK" target/macos-m0/colmap
git -C target/macos-m0/colmap fetch https://github.com/colmap/colmap.git fa8e3b3ff591552855f8ad2806723c80f963f69c
git -C target/macos-m0/colmap switch --detach fa8e3b3ff591552855f8ad2806723c80f963f69c
```

`build-colmap.sh` 要求源码 HEAD 精确匹配该 commit，拒绝脏 checkout，不更新依赖版本或补丁。`main` 上的 4.3 开发版本不能替代此基线。

## 隔离依赖

需要 Apple Silicon、Xcode 和已有 Conda。脚本不会安装 Homebrew 或修改 Conda base。公开 conda-forge 包 URL 与 SHA-256 固定在 `colmap-m0-deps.explicit.txt`；缓存和环境均留在 Git 忽略的 `target` 下：

```sh
CONDA_PKGS_DIRS="$PWD/target/macos-m0/conda-pkgs" \
CONDA_ENVS_PATH="$PWD/target/macos-m0/conda-envs" \
CONDA_REPORT_ERRORS=false ANACONDA_ANON_USAGE=no \
conda create --prefix "$PWD/target/macos-m0/colmap-deps" \
  --override-channels --channel conda-forge --no-default-packages --yes \
  --file scripts/macos/colmap-m0-deps.explicit.txt

scripts/macos/build-colmap.sh \
  --deps-prefix "$PWD/target/macos-m0/colmap-deps" --jobs 4
```

构建固定 `arm64`、最低部署版本 `15.0`、Release，禁用 CUDA、GUI、OpenGL、ONNX、CASPAR 和发行产物测试。保留上游 MVS、CGAL、LSD 默认选项，尚未进行依赖裁剪。源码中的 PoseLib、FAISS FetchContent 下载也使用上游固定的 SHA-256；首次配置需要网络。AppleClang 的 OpenMP 显式连接独立 prefix 中的 libomp。

该 Conda 环境包含 OpenImageIO 的大量传递依赖，其中有 GPL 构建的 FFmpeg、libheif、Ceres/SuiteSparse 组合等。Ceres 源码自身的许可证仍为 BSD-3-Clause；组合的分发义务不能只看顶层许可证。环境里的 FFmpeg 9.x **不是**应用计划锁定的 FFmpeg 8.1.2。M4 必须重新确定最小运行闭包和许可证，不能直接分发此开发 prefix。

安装产物的 rpath 显式包含开发 prefix 的绝对 `lib` 路径，以支持 M0 的真实 SfM。此路径必须在 M4 的 dylib 收集、load command 改写、签名与完整性清单流程中移除。

## 证据与复验

`target/macos-m0/colmap-build/` 保存环境、SDK/编译器、完整 configure 命令、CMakeCache、构建和安装日志、可执行文件 SHA-256、Mach-O 架构/load commands、依赖以及以下命令的真实 `--help`：feature_extractor、sequential_matcher、exhaustive_matcher、mapper、global_mapper、image_undistorter。

`build-success.txt` 只表示编译、安装、arm64 检查与这些 CLI help 成功；还会检查固定版本/commit/无 CUDA 标识及实际所需 CPU 参数是否存在，不能只凭 help 的退出码通过。它明确记录 `sfm_smoke_passed=not_run`。`build-info.json` 将可执行文件 SHA-256 绑定到固定 source commit、target、部署版本和 CPU CMake 配置。每次重新配置前会移除上一次成功标记和 CLI 证据，失败重试不会沿用旧成功记录。它们不能替代输入许可/哈希、实际 CPU SfM、图片去畸变、Metal 训练和完整 PLY 验收。

构建 recipe 的离线测试：

```sh
python3 scripts/macos/test_build_colmap.py
```

这些测试覆盖固定源码、脏 checkout、平台、CPU 参数、带空格/中文路径、输出目录逃逸和失败证据。它们不运行真正 COLMAP，不应计作 M0 引擎通过。

## CPU SfM 实测（2026-10-27）

素材为 James / Robson 的 CC0 火山岩样品照片，选取 `IMG_1928.jpg` 至 `IMG_1967.jpg` 共 40 张，来源 DOI `10.6084/m9.figshare.9120020.v1`。逐图 SHA-256 与许可证据见 `packaging/macos-arm64/fixtures/james-sample-40.json`。从 ZIP 分段下载的已选条目已校验 CRC32 与 SHA-256；完整归档 MD5 尚未验证，不应将其写为完整归档校验通过。

在独立引擎 CLI 中，以 1600 最长边、单相机、CPU SIFT 和 exhaustive matching、4 线程执行。incremental 和 global mapper 都显式禁用 GPU。global 测试从完成且已关闭的 incremental 数据库制作 SQLite 备份，复用相同特征/匹配结果，随后在独立目录执行全局重建与去畸变。

| 重建 | 注册 | 稀疏点 | 平均重投影误差 | Mapping | 去畸变 |
| --- | --- | --- | --- | --- | --- |
| incremental | 40/40 | 36,910 | 0.520280 px | 26.296 秒 | 21.599 秒 |
| global CPU | 40/40 | 36,498 | 0.507404 px | 24.462 秒 | 31.746 秒 |

共同输入的 CPU SIFT 为 29.554 秒，CPU matching 为 30.617 秒。时间是这次开发机 smoke 记录，可能受并行构建影响，不能当性能承诺或跨设备基准。global 命令在仅含 `/usr/bin:/bin` 的 PATH 下运行，仍使用受管开发 prefix 的运行库。

global 去畸变输出的 PINHOLE 相机尺寸为 960×638，40 张 JPEG 的实际像素尺寸全部吻合；逐图源哈希和复制后输入哈希均保持不变。规范化 dataset 的 40 张图片及 5 个 sparse 二进制文件另记录 SHA-256。详细命令、退出码和日志分别保存在 `target/macos-m0/smoke-incremental-01/evidence.json` 与 `target/macos-m0/colmap-diagnostic/evidence.json`。

这确认了固定版本在本机上的真实 CPU 重建和去畸变链路。应用接入、最低系统兼容性、独立安装包、Windows 回归和高斯训练须继续分别验收。
