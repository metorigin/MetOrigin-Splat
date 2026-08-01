# MetOrigin Splat

[English](README.md)

> **Alpha / 源码预览：** 当前开放的是用于开发和审阅的源代码，暂不提供公开二进制版本，也不提供受支持的完整离线安装包。

MetOrigin Splat 是一款 Windows 优先的 Gaussian Splatting 桌面应用。它使用本地计算资源，将视频或照片转换为三维场景；应用不会把用户素材上传到云端服务。

## 项目状态

桌面工作流、项目模型、外部进程管理、引擎适配器、恢复逻辑、预览和导出路径已经实现，并有自动化测试覆盖。但项目仍属于预发布软件：

- 目前仅验证 Windows 10/11 x64。
- Brush 训练预计需要兼容的 NVIDIA GPU。
- FFmpeg、COLMAP 和 Brush 只在有限的硬件与数据集组合上完成验证。
- 真实引擎集成测试需要本地引擎、测试素材、较大磁盘空间和兼容 GPU。
- 完整离线安装包在第三方再分发义务闭环前仅供内部验证。

当前项目文件格式和命令行为不应被视为稳定的公共 API。

## 技术链路

```text
视频 / 图片
    ↓
素材检查
    ↓
FFmpeg 视频抽帧
    ↓
图像预处理
    ↓
COLMAP 特征提取 / 匹配 / 稀疏重建
    ↓
Brush 本地 GPU 训练
    ↓
Checkpoint / PLY
    ↓
预览与导出
```

## 当前范围

| 项目 | 当前范围 |
| --- | --- |
| 操作系统 | Windows 10/11 x64 |
| 输入 | MP4、MOV、JPG、PNG |
| 场景 | 静态物体、静态室内外场景 |
| SfM | 本地 COLMAP |
| 训练后端 | Brush |
| GPU | NVIDIA，以 Brush 实际兼容性为准 |
| 输出 | PLY、项目文件、日志 |
| UI | Tauri、React、TypeScript |
| 核心后端 | Rust |
| 隐私 | 本地处理，不上传用户素材 |

云训练、账号体系、云同步、公开分享、动态 3DGS、多 GPU 训练、移动端、完整 Gaussian 编辑器以及正式 macOS/Linux 版本不在当前范围内。

## 开发环境快速开始

### 前置要求

- Rust 1.97.0 和 `x86_64-pc-windows-msvc` target
- Node.js 22
- pnpm 11.12.0
- Windows SDK 和包含“使用 C++ 的桌面开发”工作负载的 Visual Studio Build Tools
- Windows 平台的 Tauri 前置依赖

```powershell
git clone https://github.com/metorigin/MetOrigin-Splat.git
Set-Location MetOrigin-Splat

pnpm install --frozen-lockfile
pnpm tauri dev
```

构建应用不会获得公开再分发 FFmpeg、COLMAP 或 Brush 的授权。运行完整三维处理链路需要兼容的本地引擎。请阅读[开发指南](docs/development.md)、[引擎集成指南](docs/engine-integration.md)和[Windows 打包边界](packaging/windows-x64/README.md)。

## 验证命令

```powershell
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --all -- --check
cargo test --workspace --all-targets
```

真实引擎测试默认忽略，其运行要求和命令记录在[技术验证文档](docs/plans/technical-spike.md)中。

## 仓库结构

```text
MetOrigin-Splat/
├── apps/desktop/        # Tauri 桌面应用和前端测试
├── crates/              # Rust workspace crates 和集成测试
├── schemas/             # JSON Schema 和示例
├── presets/             # 训练预设
├── docs/                # 架构、开发和项目文档
├── packaging/           # 内部打包定义与许可证门禁
└── scripts/             # 构建和打包工具
```

## 文档

- [架构设计](docs/architecture.md)
- [开发指南](docs/development.md)
- [引擎集成](docs/engine-integration.md)
- [项目格式](docs/project-format.md)
- [发布流程](docs/release-process.md)
- [故障排查](docs/troubleshooting.md)
- [参与贡献](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全漏洞请按照 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

MetOrigin Splat 源代码采用 [MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE) 双重许可，使用者可任选其一。

第三方程序、模型权重、图标和其他依赖保留各自的许可证。项目许可证不代表可以再分发内部完整引擎包；分发二进制文件前必须查看[打包许可声明](packaging/windows-x64/THIRD_PARTY_NOTICES.template.md)。
