# 文档索引 / Documentation

本文档集描述当前实现。中英文项目介绍分别见 [English README](../README.md) 和[中文 README](../README.zh-CN.md)。

## 使用 / Usage

| 文档 | 内容 |
| --- | --- |
| [使用指南（中文）](user-operation-flow.zh-CN.md) | 项目中心、素材导入、预设、重建、预览和设置 |
| [高斯渲染与实时预览（中文）](gaussian-live-preview.zh-CN.md) | 配套 Brush 引擎、交互、更新机制和验证 |
| [Troubleshooting](troubleshooting.md) | 启动、引擎、预检、恢复与预览问题 |

## 开发 / Development

| 文档 | 内容 |
| --- | --- |
| [Development](development.md) | 工具链、启动、测试、构建和提交范围 |
| [Architecture](architecture.md) | 模块边界、状态流、流水线和渲染 |
| [Engine integration](engine-integration.md) | 版本锁定、路径解析、适配器和恢复边界 |
| [Project format](project-format.md) | 目录结构、持久化字段和产物 |
| [Contributing](../CONTRIBUTING.md) | 贡献与审阅约定 |

## 发布 / Release

- [Release process](release-process.md)：源码发布、内部安装包与公开分发条件。
- [Windows packaging](../packaging/windows-x64/README.md)：打包命令、输出位置与引擎包。
- [Changelog](../CHANGELOG.md)、[Security policy](../SECURITY.md)。

## 历史验证与设计记录 / Historical records

- [真实引擎基线，2026-07-13](validation/engine-baseline.md)：保留测量数据和兼容性发现，不代表当前完整兼容性矩阵。
- [设计契约与验收协议索引](../specs/README.md)：供追踪状态、安全交互和验收方法；旧界面文案与布局以当前使用指南和代码为准。

参数以 [presets](../presets/) 为准，项目格式以 [schemas](../schemas/) 和 Rust 类型为准，引擎版本以 [engine-lock.json](../packaging/windows-x64/engine-lock.json) 为准。更新实现时同步修改对应指南，不再为每次界面调整新增独立说明文件。截图、日志和临时审阅报告保存在被 Git 忽略的 `.test-results/` 中。
