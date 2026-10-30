# macOS M1 应用接入验证

日期：2026-10-27。状态：**照片、视频的完整应用核心流水线 smoke 已通过；原生窗口验收进行中**。本记录不是完整 Mac 支持或独立安装包声明。环境仍为 [M0](macos-m0.md) 的 Apple M1 Pro / 32 GB / macOS 27.0.1。

## 固定引擎

| 引擎 | 版本 / 身份 |
| --- | --- |
| FFmpeg / FFprobe | 8.1.2，commit `38b88335f99e76ed89ff3c93f877fdefce736c13`，LGPL shared native arm64 |
| COLMAP | 4.1.0，commit `fa8e3b3ff591552855f8ad2806723c80f963f69c`，CPU CLI |
| Brush | `1.0.0+metorigin-macos.3`，原始 commit `1388f74c6fe0236f68ee4915564bf00e9d2e3747` + 累计补丁 |
| Brush binary SHA-256 | `d73830ee5ad1b04d13ec3e2c5fca92be52a7589171b4432ef24d47ea5c6e7acf` |
| Brush 最终补丁 SHA-256 | `f2e0853ba495e492fa5ebb890ed8d2a7886ce54752740daacbc67aff3c228cc8` |

每次运行的完整四引擎 SHA、实际 probe 与参数在独立 `runtime/execution-profile.json` 中冻结。运行前、训练前与 adapter 构造时检查身份；进程仍统一通过 `splat-process` 执行。`.3` 的最终 build-info 位于忽略目录 `target/macos-m2/brush-artifacts-final/<binary SHA>/`，此前稳定产物不被覆盖。

## 实测结果

真实照片来自已固定整归档及逐图 hash 的 James40 CC0 fixture。视频由这些照片以 2 fps 编码为 20 秒、960×640、40 帧 MPEG4；它用于抽帧和后续流水线工程验证，不是另行实拍的视频。视频 SHA-256 `b5959e9d02dd4b7680e6735f68a73cd45cc0ea86770a1ac71c549c7b6e9cdf75`。尺寸依据原始 `target/macos-m1/video-fixture/encode.log` 和 MP4 `stsd` 中 `mp4v` sample entry 的宽高字段，已将此前的 960×638 笔误更正；视频文件与 hash 未变。

`real_macos_pipeline.rs` 使用生产默认 orchestrator 注册的全部 12 个 stage，从新项目和复制的输入开始，经过 CPU SfM、选择模型、质量检查、同步相机内参的去畸变、真实 Metal 训练、最终 PLY 校验、导出和输出 manifest。两个项目名均含中文和空格。显式 smoke 参数为 300 步、SH0、960 px、256 MiB 图像缓存、30 万 splats 上限、4 个 loader 线程、LOD0。它们不是 fast 预设的质量或耗时验收。

| 项目 | 注册 | 最终 Gaussian | PLY bytes | 流水线记录耗时 |
| --- | --- | --- | --- | --- |
| 照片 | 40/40 | 14,599 | 818,044 | 196.733 s |
| MPEG4 视频 | 40/40 | 16,073 | 900,588 | 140.056 s |

照片 PLY SHA-256 `e7c5387a5461b679f9364273b7cede4ef01a582e7ef328fb4efc8e64905ae275`；视频 PLY `3b581745ed32dd73a6097ef124ebefabb43f6dbafd738a699dbef16d0af63c39`。两个 PLY 均完成结构、长度、Gaussian 必需属性、SH 和逐值有限性检查。原始照片、视频 hash 不变。完整 test wall time 分别 202.04 s / 145.75 s，含前后 fixture 校验等额外工作；Rust 测试为 debug 构建，不能拿该耗时比较发行版性能。

证据位于 `target/macos-m1/app-core-photos-01/` 与 `app-core-video-01/` 内项目的 `runtime/acceptance-evidence.json`，原始子进程命令/输出在对应 `logs/`。独立应用 Brush adapter 另完成 `.3` 真实 300 步、44,010 Gaussian、SH0、loader4 测试，记录在 `target/macos-m2/adapter-contract-02/evidence.json`。

应用 adapter 的真实 GPU probe 在默认受限 sandbox 中失败并保留失败记录；允许本机 Metal 访问后通过。失败返回非零退出码和结构化 failed JSON，未被当作支持。`.3` 还通过显式默认值覆盖 args.txt、中文/空格 token、线程限制、原子完整 checkpoint、导出失败非零、中断后 warm start、降低 max-splats 拒绝等真实 CLI 检查，见 [Brush 补丁记录](../../integrations/brush-macos/README.md)。

## 复现与未完成项

[真实核心测试](../../crates/splat-pipeline/tests/real_macos_pipeline.rs) 默认忽略，需设置绝对路径环境变量 `METORIGIN_TEST_PROJECT_ROOT`、`METORIGIN_TEST_IMAGE_DIR`、`METORIGIN_TEST_FFMPEG`、`METORIGIN_TEST_FFPROBE`、`METORIGIN_TEST_COLMAP`、`METORIGIN_TEST_BRUSH`；视频另需 `METORIGIN_TEST_VIDEO`。项目根必须已存在且未包含对应同名验收项目。每次使用新的输出根，禁止覆盖前次证据。

```sh
cargo test --locked --offline -p splat-pipeline --test real_macos_pipeline \
  macos_real_photos_to_scene_ply -- --ignored --nocapture
cargo test --locked --offline -p splat-pipeline --test real_macos_pipeline \
  macos_real_video_to_scene_ply -- --ignored --nocapture
```

已验证核心流水线不能代替 WKWebView 查看、SuperSplat 编辑保存、真实取消/恢复 UI、live 视觉一致性、统一内存峰值、自包含 app/dmg、macOS 15 / 16 GB 机器或 Windows 原生回归。上述各项继续按方案 M1–M4 推进。

## 最终包离线核心复核（2026-10-27）

09:05:35–09:07:34 UTC，使用最终 `006cfe46` app 内嵌引擎完成一次新的应用核心视频 smoke。测试由当前源码以 `--locked --offline --no-run` 重新构建并复制冻结，旧 `33c719…` 测试二进制未复用；精确执行 `macos_real_video_to_scene_ply --exact --ignored --nocapture --test-threads=1`，结果为 **1 passed、退出码 0、12 个生产阶段完成**。此处运行的是独立核心测试，未启动原生应用。

| 对象 | 本次 SHA-256 |
| --- | --- |
| app 主程序 | `006cfe46d2d319f414be08d24d56f3a95a2909742b113c736c1cb4d93d6ea7ac` |
| 冻结核心测试 | `3f147ed610742a286a08f83c8dcb70fc245b6e12009c85d8031846ce72b5ffdc` |
| 内嵌 engine manifest | `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40` |
| FFmpeg 8.1.2 | `254cf3ef679ff627d027ef4537d3c8c9663c1764338b7ac64679c5f4b647e723` |
| FFprobe 8.1.2 | `75fb210106cbd57d05a63a8c16c4fab25ed115beaa0fda0cb6fe179145b13f2b` |
| COLMAP 4.1.0 | `bfd28a4abfc6aad219fbe73e0cc065277604cfa5bdfe68d762c14164478c5443` |
| Brush `1.0.0+metorigin-macos.6` | `f8fb8784d394e224f9057243bbb6e1f33039ea34063ec8fa91c339853c144e1c` |

测试及其 Metal 预检、版本探测和引擎子进程在 `sandbox-exec` 的 `(allow default)`、`(deny network*)` 策略内运行，未放宽禁网规则。运行前后各完成四项 IPv4 回环对照：裸客户端及 allow-default 客户端正常回显；deny-network 直接子进程及后代进程均返回 `EPERM`；每轮监听端恰好收到两次连接。宿主网络设置未改变，结论仅覆盖该受限进程子树。

同一 James40 工程视频抽出 40 帧，**40/40 注册、300 步、SH0、960 px，最终 16,022 个高斯**。最终 checkpoint 与 `scene.ply` 均为 897,734 字节，SHA-256 同为 `31bdb7b461fa7e4b832346255c2befa7ac489b3bc37ae620982f722362c185c8`；完整 Gaussian 校验、manifest、completion fingerprint 和终态一致，项目锁释放，退出后已归属进程观察为空。核心证据计时 108.758 秒，整个测试 114.30 秒；二者计时范围不同，不作为发行版性能比较。

前后复核确认整包 inventory、2,999 个内嵌引擎包文件、测试二进制、依赖源码、策略、40 张源图及视频哈希均未变。绑定、前后网络对照、进程观察和独立产物审计见忽略目录 `target/macos-m4/offline-core/prepared-final-20261027/final-app-binding-v3.json` 与 `target/macos-m4/offline-core/runs/20261027T090535Z-247581c1/summary.json`。

本次通过范围是 **M1 Pro / 32 GB / macOS 27.0.1 上，最终包内引擎的应用核心禁网 smoke**。显式 300 步参数不代表完整 fast 预设验收；40 帧 MPEG4 仍由照片合成，不是独立实拍视频或 100–200 帧视频验收。它也不证明原生离线 UI、全机断网、干净机、macOS 15 或 16 GB 环境通过。
