# 文档索引 / Documentation

本文档集描述当前实现。中英文项目介绍分别见 [English README](../README.md) 和[中文 README](../README.zh-CN.md)。

Windows 和 macOS 验收文档中指向 `target/` 的链接是本地构建与原生测试证据，原始产物不随 Git 提交。文档保留构建身份、结果和未通过项；新克隆需要另行生成或取得对应证据，不能把源码提交视作完整验收通过。

## 使用 / Usage

| 文档 | 内容 |
| --- | --- |
| [使用指南（中文）](user-operation-flow.zh-CN.md) | 项目中心、素材导入、预设、重建、预览和设置 |
| [User guide (English)](user-guide.md) | Language, media import, reconstruction, editing, recovery and settings |
| [高斯渲染与实时预览（中文）](gaussian-live-preview.zh-CN.md) | 配套 Brush 引擎、交互、更新机制和验证 |
| [Troubleshooting](troubleshooting.md) | 启动、引擎、预检、恢复与预览问题 |

## 开发 / Development

| 文档 | 内容 |
| --- | --- |
| [Development](development.md) | 工具链、启动、测试、构建和提交范围 |
| [Architecture](architecture.md) | 模块边界、状态流、流水线和渲染 |
| [Engine integration](engine-integration.md) | 版本锁定、路径解析、适配器和恢复边界 |
| [Windows 高斯生成对齐方案](windows-gaussian-alignment-plan.zh-CN.md) | 实施中：同源 Brush 1.0、Windows 运行配置、引擎准备与原生验证，以及 Mac 回归保护 |
| [Windows 对齐验证记录](validation/windows-alignment.md) | WIN-01–22 分层进度、最终来源/安装与不同应用身份边界；当前优先Windows，Mac和发布默认门槛保留 |
| [Windows 核心流水线验证](validation/windows-core-pipeline.md) | 照片、实际视频、中型307帧、混合EXIF/旋转和故障输入的真实核心结果 |
| [Windows COLMAP 验证](validation/windows-colmap.md) | 严格4.1门禁、实际CUDA特征/匹配与明确CPU GP/BA |
| [Windows 候选包验证](validation/windows-engine-pack.md) | 874来源/451工具、16测试、安装exit0/158资源与重定位静态运行；clean VM和许可未验收 |
| [Windows 原生 UI 验证](validation/windows-native-ui.md) | 7348照片/六轮/编辑导出单列；最终5386视频、强制退出恢复、直接暂停/继续与预览开关；取消按钮/跨项目及睡眠/压力仍待验收 |
| [Windows legacy 迁移与回退](validation/windows-legacy-migration.md) | 生产新attempt、独立PLY warm start及11阶段缓存回退；匹配旧GUI查看、只读编辑器往返与正常退出通过 |
| [Project format](project-format.md) | 目录结构、持久化字段和产物 |
| [Contributing](../CONTRIBUTING.md) | 贡献与审阅约定 |
| [Localization](localization.md) | 中英文资源、后端消息兼容与翻译贡献 |
| [Jan 全页面迁移方案](frontend-migration-plan.zh-CN.md) | 第 9–10 节：固定 Jan 来源、全部页面与 SuperSplat 内部 UI、桌面四区布局、实施证据与未验矩阵；当前实施/验收中 |
| [当前设计系统](design-system-proposal.zh-CN.md) | 当前 Jan 同源主题、组件与桌面分栏规范；历史方案保留并标明适用范围 |

## 发布 / Release

- [Release process](release-process.md)：源码发布、内部安装包与公开分发条件。
- [macOS 安装包打包命令（中文）](macos-packaging.zh-CN.md)：完整 DMG 流程、清单更新、Node/pnpm 环境、常见报错和安装步骤。
- [Windows packaging](../packaging/windows-x64/README.md)：打包命令、输出位置与引擎包。
- [macOS engine packaging](../packaging/macos-arm64/README.md)：arm64 引擎闭包、许可来源、完整性与内部 Alpha 门槛。
- [Windows Alpha 发布准备](windows-alpha-release.zh-CN.md)：第三方源码、许可证、SBOM、签名与 GitHub 草稿。
- [Changelog](../CHANGELOG.md)、[Security policy](../SECURITY.md)。

## 历史验证与设计记录 / Historical records

- [macOS 高斯生成实施方案](macos-gaussian-generation-plan.zh-CN.md)：M0 与照片／视频核心流水线已有实测；M2–M4 的原生体验、资源及分发验收持续进行。
- [macOS M0 验证记录](validation/macos-m0.md)：固定源码、构建命令、环境、实际结果及未通过的验收项。
- [macOS M1 应用接入记录](validation/macos-m1.md)：完整照片/视频核心流水线、固定 profile、真实输出及原生验收边界。
- [macOS 原生桌面验收](validation/macos-native-ui.md)：WKWebView、SuperSplat 编辑保存、快捷键与生命周期证据及待验项。
- [macOS CLI 与应用对照](validation/macos-cli-adapter.md)：同规范化数据的 SH0 属性、坐标/尺度与固定视角证据及局限。
- [macOS 混合输入与失败输入](validation/macos-mixed-input.md)：混合尺寸、EXIF 归一化、相机分组和受控失败素材的证据及待验项。
- [macOS 资源验证](validation/macos-m3-resources.md)、[退出与恢复](validation/macos-shutdown.md)、[空闲睡眠策略](validation/macos-idle-sleep.md)：测量语义、进程清理和未覆盖的真机情形。
- [macOS 引擎包验收](validation/macos-engine-pack.md)：独立库闭包、重定位、完整性与许可证证据。
- [前端迁移记录](frontend-migration-plan.zh-CN.md)：第 1–8 节记录已实施的 shadcn/ui、Tailwind CSS、Magic UI 宿主迁移与验证边界；第 9–10 节记录本轮 Jan 全界面实施、四区桌面布局、真实验证与尚未关闭的验收项。

- [真实引擎基线，2026-07-13](validation/engine-baseline.md)：保留测量数据和兼容性发现，不代表当前完整兼容性矩阵。
- [设计契约与验收协议索引](../specs/README.md)：供追踪状态、安全交互和验收方法；旧界面文案与布局以当前使用指南和代码为准。

参数以 [presets](../presets/) 为准，项目格式以 [schemas](../schemas/) 和 Rust 类型为准，引擎版本以 [engine-lock.json](../packaging/windows-x64/engine-lock.json) 为准。更新实现时同步修改对应指南，不再为每次界面调整新增独立说明文件。截图、日志和临时审阅报告保存在被 Git 忽略的 `.test-results/` 中。

本产品包含 [Menlo Research](https://menlo.ai) 开发的 Jan 软件（固定来源与 Apache-2.0 原文见迁移记录和 `integrations/jan/`）；本地适配保留原 shadcn/ui MIT 声明，不将不同来源统一重标许可。
