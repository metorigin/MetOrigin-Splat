# 历史文档档案

本目录保存冻结的设计方案、阶段记录和实验结果。当前平台、引擎路线、候选构建、已验及待验范围统一见[项目状态](../status.md)；当前操作、架构与设计规则从[文档索引](../README.md)进入。

## 阅读与维护边界

- 文中的“当前”“最新”、工具版本、命令、旧路径和未完成事项均属于原记录时点。归档不新增通过结果，不将旧构建结果转移到新候选。
- 构建 SHA、包/模型哈希、失败结果、实验数据与覆盖边界保留。旧 `target/`、`.test-results/` 等字段仍指当时证据；可用开发指南中的历史路径解析器查询，载荷可能已被保留策略清理。
- 只为文档导航更新相对链接；原始回执与第三方来源证据保持原字节。历史命令不是当前开发或打包入口。
- 仍需执行的验收项目进入[当前状态](../status.md)，原文中的未完成记录不被覆盖成“已完成”。

## 冻结实施方案

| 档案 | 原始范围 |
| --- | --- |
| [macOS 高斯生成方案](plans/macos-gaussian-generation-plan.zh-CN.md) | M0–M4 设计、实现与逐次进展；内存稳定性、目标环境和完整验收边界保留 |
| [Windows 高斯对齐方案](plans/windows-gaussian-alignment-plan.zh-CN.md) | Brush 1 对齐设计与初始任务；当前进度见项目状态及 Windows alignment 记录 |

## 前端设计与验收

- [前端 UX feature 001](specs/001-frontend-ux-improvements/spec.md)：[实施计划](specs/001-frontend-ux-improvements/plan.md)、[研究](specs/001-frontend-ux-improvements/research.md)、[数据模型](specs/001-frontend-ux-improvements/data-model.md)、[任务记录](specs/001-frontend-ux-improvements/tasks.md)、[需求检查](specs/001-frontend-ux-improvements/checklists/requirements.md)。
- [旧 UI 交互契约](specs/001-frontend-ux-improvements/contracts/ui-interaction-contract.md)与[旧 IPC 契约](specs/001-frontend-ux-improvements/contracts/tauri-ipc-contract.md)保留历史接口示例；现行布局和请求结构以当前规范、服务包装及 Rust 类型为准。
- [验收协议](specs/001-frontend-ux-improvements/quickstart.md)与[结果](specs/001-frontend-ux-improvements/validation-results.md)保留原环境、计数与结论。
- [旧设计系统方案](design/design-system-proposal.zh-CN.md)、[前端迁移记录](design/frontend-migration-plan.zh-CN.md)与[设计 QA 历史](design/design-qa.md)保存多轮调整；当前规则见[设计系统](../design-system.zh-CN.md)。

Feature 001 的 `T082`、`T084` 仍未勾选，最终结果仍为 `PENDING`。旧记录尚缺的 Windows 原生矩阵、睡眠/恢复、辅助功能与缩放、至少10人的可用性协议、正式计时、兼容性比较和审核签署，不因归档而通过。后续若已被新协议替代或取得新证据，应在当前状态中标明来源、构建与范围，保留这里的原始结论。

## 历史阶段与实验

| 档案 | 范围 |
| --- | --- |
| [真实引擎基线，2026-07-13](validation/engine-baseline.md) | 单次 Windows/Brush 0.3 流水线、兼容性与恢复结果 |
| [macOS M0](validation/macos-m0.md) | 固定引擎与独立 smoke，不代表完整应用支持 |
| [macOS M1](validation/macos-m1.md) | 核心照片/视频流水线与原构建输出 |
| [macOS CLI/adapter 比较](validation/macos-cli-adapter.md) | James40 工程视频数据上的有限结构/视角对照，不声明质量等价 |

其余仍在承担当前验收总账的记录暂留 [`docs/validation/`](../validation/)，当前状态页是统一入口。它们的历史段落和未关闭事项不应按日期直接删除。

## 原生配方与补充实验

- [Brush M0配方](engines/BRUSH-M0.md)、[COLMAP M0配方](engines/COLMAP-M0.md)：原始命令与结果保留；当前入口位于scripts/macos。
- [训练来源契约实测](validation/training-provenance-2026-10-27.md)、[Mac 2026-10-27打包经过](validation/macos-packaging-2026-10-27.md)。

## 历史图标

停用稿保留在[桌面图标档案](../../design/app-icon/archive/README.md)和[Windows 图标档案](../../design/app-icon/windows/archive/README.md)。当前 v4 母版、Mac 原生构图、Windows shared-v4 派生资源和构建 manifest 保持在原位。
