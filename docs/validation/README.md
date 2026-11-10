# 验收记录索引 / Validation records

平台、候选构建和未关闭事项统一见[当前状态](../status.md)。本目录保留各次运行的证据和机制说明，正文中的“当前”“最终”按各段日期与构建理解，不能合并为当前源码全量通过。

| 范围 | 记录 |
| --- | --- |
| Windows实施与构建身份 | [Alignment](windows-alignment.md)、[engine pack](windows-engine-pack.md) |
| Windows实际运行 | [Core pipeline](windows-core-pipeline.md)、[COLMAP](windows-colmap.md)、[native UI](windows-native-ui.md)、[legacy migration](windows-legacy-migration.md) |
| GPU后端选择与诊断 | [Windows验证及实现边界](gpu-backend-resilience.md)、[M1 Pro验收结果](gpu-resilience-m1-pro-results.md)、[Mac重跑步骤](gpu-resilience-m1-pro-handoff.md) |
| Mac包与许可 | [Engine pack](macos-engine-pack.md)、[application licenses](macos-app-licenses.md) |
| Mac原生与资源 | [Native UI](macos-native-ui.md)、[resource measurements](macos-m3-resources.md)、[mixed input](macos-mixed-input.md) |
| Mac生命周期机制和实验 | [Shutdown/recovery](macos-shutdown.md)、[idle/sleep](macos-idle-sleep.md) |
| 当前训练契约 | [Training provenance](../contracts/training-provenance.md) |
| 历史阶段和基线 | [档案索引](../archive/README.md)：M0/M1、CLI对照、7月引擎基线和旧方案 |

新正式证据位于`artifacts/verification/<platform>/`。旧路径查询见`pnpm artifacts:resolve -- <old-path>`；解析失败或载荷已清理不能写成重新验证成功。原始输入、哈希、失败和未验边界应与各自构建一起保留。
