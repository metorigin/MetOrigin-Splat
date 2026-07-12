# MetaOrigin Splat

> 一款开源、本地运行、无需配置 Python 环境的 Gaussian Splatting 桌面应用，将视频或照片自动转换为可查看和导出的三维场景。

MetaOrigin Splat 是一款 Windows 优先的开源桌面应用。它使用本地计算资源，将视频或照片自动转换为 Gaussian Splatting 三维场景。全流程本地运行，不上传任何用户素材，无需配置 Python 或 Conda 环境。

## 技术链路

```
视频或图片
    ↓
素材检查
    ↓
FFmpeg 视频抽帧
    ↓
图像预处理
    ↓
COLMAP 特征提取
    ↓
COLMAP 特征匹配
    ↓
COLMAP Sparse Reconstruction
    ↓
数据格式检查与转换
    ↓
Brush 本地 GPU 训练
    ↓
Checkpoint / PLY
    ↓
预览与导出
```

## MVP 范围

| 项目     | MVP 范围                              |
| -------- | ------------------------------------- |
| 操作系统 | Windows 10/11 x64                    |
| 输入     | MP4、MOV、JPG、PNG                  |
| 场景     | 静态物体、静态室内外场景              |
| SfM      | 本地 COLMAP                          |
| 训练后端 | Brush                                |
| GPU      | 以 Brush 实际支持为准，优先验证 NVIDIA |
| 输出     | PLY、项目文件、日志                  |
| UI       | Tauri + React + TypeScript           |
| 核心后端 | Rust                                 |
| 隐私     | 全流程本地，不上传用户素材            |
| 安装方式 | Windows 安装包和便携版               |

### MVP 不包含

云训练、多机训练、动态 3DGS、手机端训练、完整 Gaussian 编辑器、自研 SfM、自研 3DGS 训练器、自动生成公网分享链接、macOS/Linux 正式发行版、商业授权系统、账号体系、在线素材同步。

## 快速开始

```bash
# 前置要求：Rust stable、Node.js 18+、pnpm

# 克隆仓库
git clone https://github.com/metorigin/splat.git
cd splat

# 构建并以开发模式运行
pnpm install
pnpm tauri dev
```

详细开发环境搭建请参考 [docs/development.md](docs/development.md)。

## 仓库结构

```
splat/
├── apps/desktop/        # Tauri 桌面应用
├── crates/              # Rust workspace crates
│   ├── splat-domain/    # 核心领域类型
│   ├── splat-project/   # 项目管理
│   ├── splat-pipeline/  # 管道编排
│   ├── splat-process/   # 外部进程管理
│   ├── splat-hardware/  # 硬件检测
│   ├── splat-engine-ffmpeg/
│   ├── splat-engine-colmap/
│   └── splat-engine-brush/
├── schemas/             # JSON Schema 定义
├── presets/             # 训练预设
├── docs/                # 文档
├── scripts/             # 构建工具脚本
└── tests/               # 集成和 E2E 测试
```

## 文档

- [架构设计](docs/architecture.md)
- [开发指南](docs/development.md)
- [引擎集成](docs/engine-integration.md)
- [项目格式](docs/project-format.md)
- [发布流程](docs/release-process.md)
- [故障排查](docs/troubleshooting.md)

## 许可证

[待确定](LICENSE)
