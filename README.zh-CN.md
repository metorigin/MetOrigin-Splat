# MetOrigin Splat

[English](README.md) | [简体中文](README.zh-CN.md)

将一段视频或一组照片重建为 3D Gaussian Splatting 场景的 Windows 桌面应用。通过 FFmpeg 准备影像、COLMAP 重建相机与稀疏几何，再由 Brush 在本机训练高斯模型。

**当前状态：Alpha / v0.1.0。** 核心流程已实现，Windows 安装包用于内部验证，暂未提供受支持的公开二进制版本。

## 主要功能

- 导入 MP4、MOV、AVI、MKV 视频，或包含 JPG、JPEG、PNG 的图片文件夹。
- 分析素材、检查运行环境，选择快速、均衡或高质量重建预设。
- 跟踪四个处理阶段，查看阶段产物，暂停、取消任务，并使用有效恢复数据继续执行。
- 查看 COLMAP 稀疏几何与完整高斯模型；配合 Brush 实时预览引擎，边训练边查看模型更新。
- 管理最近项目、查看质量指标和资源占用、导出 PLY 结果。
- 重建完成后在操作台内使用 SuperSplat 编辑模型，直接保存到项目模型文件。
- 在“设置与引擎”中管理引擎、存储、性能，以及浅色、深色和跟随系统的外观。

素材处理在本机完成。准备引擎、安装依赖时可能下载软件，不会上传项目素材。

## 本地启动

Windows 10/11 x64 开发环境需要：

- Rust **1.97.0**，包含 `x86_64-pc-windows-msvc` 目标
- Node.js **22**、pnpm **11.12.0**
- Visual Studio Build Tools 的 **使用 C++ 的桌面开发** 工作负载，以及 Windows SDK
- Microsoft Edge WebView2 Runtime
- 兼容的 NVIDIA GPU；当前重建流程按这一硬件路径验证

在项目根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm tauri dev` 会同时启动桌面应用和 Vite 服务，不需要再启动一个占用 1420 端口的 `pnpm dev`。前端支持热更新；修改 Rust/Tauri 代码后，需要重新执行桌面启动命令。

### 准备重建引擎

源码仓库不包含引擎可执行文件。可以在左侧“设置与引擎”中配置已有安装，也可以准备仓库锁定版本的本地引擎包：

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

生成的引擎目录为 `target/distribution/windows-x64/engines`，本地使用时在“设置与引擎”中选择此目录。引擎包包括 FFmpeg/FFprobe、COLMAP 和 Brush。具体版本与校验值以 [engine-lock.json](packaging/windows-x64/engine-lock.json) 为准。首次构建配套实时预览引擎可能需要较长时间。

已有 Brush 安装时，也可以单独构建实时预览引擎：

```powershell
pnpm build:brush:live
```

默认输出为 `.engines/brush-v0.3.0-windows-x64/brush_live.exe`，应与已配置的 `brush_app.exe` 放在同一目录。新启动的训练会自动使用它。普通 Brush 可以提供已保存的 checkpoint；查看尚未保存的训练模型更新，需要配套实时预览引擎。详见[引擎接入](docs/engine-integration.md)和[高斯渲染与实时预览](docs/gaussian-live-preview.zh-CN.md)。

### 仅预览前端界面

```powershell
pnpm dev
```

浏览器打开 `http://localhost:1420/?ui-preview` 可查看开发模式的示例数据界面。该模式不能验证原生文件选择、真实重建或实时 GPU 渲染。

## 使用流程

1. 点击“新建项目”，选择视频，或浏览并选择目标文件夹中的一张图片。图片导入范围是该图片所在的整个文件夹，包括子文件夹。
2. 查看素材分析与预检结果，选择重建预设。
3. 确认项目名称和保存位置，选择“仅创建项目”或“创建并开始重建”。
4. 跟踪“预处理 → 特征提取 → 训练重建 → 质量评估”，点击阶段卡片展开具体步骤及其产物。
5. 查看高斯模型、质量报告和 checkpoint，通过输出目录使用 `output/scene.ply`。

同一时间只运行一个重建任务，运行时可以浏览其他项目。PLY checkpoint 恢复模型几何，不包含完整优化器状态。实时预览通过跨进程模型快照更新，速度取决于训练速度与模型大小。

## 开发检查

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

真实引擎测试需要手动启用，并准备本地素材和相应硬件。详细命令与构建输出见[开发与验证指南](docs/development.md)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/desktop/` | React/TypeScript 前端、Tauri 命令和前端测试 |
| `crates/` | Rust 领域模型、项目存储、进程管理、流水线、硬件检测和引擎适配 |
| `integrations/brush-live/` | 训练快照配套引擎源码 |
| `presets/`、`schemas/` | 重建参数与持久化数据格式 |
| `scripts/`、`packaging/` | 验证、Windows 构建、引擎版本锁定和第三方声明 |
| `docs/` | 当前使用、实现与发布文档 |
| `specs/` | 历史设计契约与验收协议 |

可从[文档索引](docs/README.md)、[使用指南](docs/user-operation-flow.zh-CN.md)、[架构说明](docs/architecture.md)或[故障排查](docs/troubleshooting.md)开始阅读。贡献流程与漏洞反馈方式分别见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 许可证与分发

应用源码采用 [MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE) 双许可证，可任选其一。第三方引擎与依赖保留各自的许可证。

源码公开不等于允许分发完整引擎包。二进制发布条件见[发布流程](docs/release-process.md)和 [Windows 打包声明](packaging/windows-x64/THIRD_PARTY_NOTICES.template.md)。
