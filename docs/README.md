# 文档索引 / Documentation

从[当前状态与验收边界](status.md)了解平台、引擎路线、候选构建、已验范围、待验事项和证据位置。这里是文档导航；构建状态统一在状态页维护。项目介绍见 [English README](../README.md) 和[中文 README](../README.zh-CN.md)。

## 使用 / Usage

| 文档 | 内容 |
| --- | --- |
| [使用指南（中文）](user-operation-flow.zh-CN.md) / [User guide](user-guide.md) | 项目中心、素材导入、重建、预览、编辑和恢复 |
| [高斯渲染与实时预览](gaussian-live-preview.zh-CN.md) | Windows legacy、Windows1和Mac通道、自动预览及验证边界 |
| [Troubleshooting](troubleshooting.md) | 启动、引擎、预检、恢复与预览问题 |

## 开发与规范 / Development and contracts

| 文档 | 内容 |
| --- | --- |
| [Development](development.md) | 工具链、启动、检查、构建与提交范围 |
| [目录职责与清理](development.md#generated-files-and-cleanup) | 四类生成目录、测试临时目录和保留规则 |
| [Architecture](architecture.md) | 模块边界、当前界面、状态流、流水线和渲染 |
| [Engine integration](engine-integration.md) | 路线、版本锁、路径解析、适配器和恢复边界 |
| [当前设计规范](design-system.zh-CN.md) | Jan来源、主题、桌面布局、组件和交互规则 |
| [Project format](project-format.md) | 持久化字段、目录结构和产物 |
| [Training provenance contract](contracts/training-provenance.md) | 指纹、缓存、warm start、归档恢复与live接收边界 |
| [Localization](localization.md) | 双语资源、消息兼容与翻译贡献 |
| [Contributing](../CONTRIBUTING.md) | 贡献与审阅约定 |

参数以 [presets](../presets/) 为准，持久化格式以 [schemas](../schemas/) 和Rust类型为准。Windows分别读取 [legacy lock](../packaging/windows-x64/engine-lock.json)和 [Windows1 lock](../packaging/windows-x64/alignment-lock.json)；Mac来源见[Alpha source index](../packaging/macos-arm64/alpha-source-index.json)，实际包身份以所选包的清单、release-status及[状态页](status.md)引用的回执为准。

## 发布 / Release

- [Release process](release-process.md)：源码、内部安装包和公开分发门槛。
- [macOS打包操作](macos-packaging.zh-CN.md)：完整DMG、签名、公证和恢复提交。
- [Windows packaging](../packaging/windows-x64/README.md)：默认legacy和显式Windows1候选。
- [Mac engine packaging](../packaging/macos-arm64/README.md)、[rebuild材料](../packaging/macos-arm64/REBUILD.md)：冻结源包、派生包和重建边界。
- [Windows Alpha发布材料](windows-alpha-release.zh-CN.md)、[Changelog](../CHANGELOG.md)、[Security policy](../SECURITY.md)。

## 验收与历史 / Validation and archives

- [当前状态](status.md)：唯一的跨平台候选与未关闭事项汇总。
- [验收记录索引](validation/README.md)：各构建、实验和机制记录的证据入口。
- [历史档案索引](archive/README.md)：冻结方案、旧Spec、阶段实验与设计QA。历史版本和结果保留，不作为当前UI操作说明。
- [图标来源](../design/app-icon/README.md)：当前母版、平台生成流程及停用稿档案。

旧 `target/`、`.test-results/` 链接保留当时位置；可用 `pnpm artifacts:resolve -- <old-path>` 查询迁移记录。原始产物不随Git提交，新克隆需另行生成或取得证据。正式报告放 `artifacts/verification/<platform>/`，安装包放 `artifacts/packages/<platform>/`。

来源、许可和构建文档留在所属模块，不能随着旧迁移方案删除。部分Markdown被哈希保护或作为实际准备输入，变更时同步来源/保护清单并重新验证。本产品包含 [Menlo Research](https://menlo.ai) 开发的Jan软件；固定来源与Apache-2.0原文见 `integrations/jan/`，shadcn/ui保留自身MIT声明。
