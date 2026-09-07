# 前端交互优化验证记录

> 本文件只允许记录脱敏结果。不得写入用户名、绝对项目路径、凭据、私有媒体、原始引擎输出、日志正文或诊断包内容。`PENDING` 表示尚未执行，不能解释为通过。

## 1. 验证元数据

| 字段 | 值 |
| --- | --- |
| 功能 | `001-frontend-ux-improvements` |
| 记录日期 | 2026-08-15 |
| 提交/工作树 | PENDING — 最终验证时填写脱敏 commit ID |
| Windows 版本 | PENDING |
| CPU / 内存 | PENDING — 仅记录型号类别与容量，不记录设备名 |
| 显示与缩放 | PENDING |
| Node / pnpm / Rust | Node 24.14.0 / pnpm 11.12.0 / rustc 1.97.0（验证机 Node 高于文档基线 22，未改依赖） |
| Tauri 构建 | PASS — debug/no-bundle，隔离 target 目录，退出码 0 |

## 2. 宪章六项原则签署

| 原则 | 自动化/文档证据 | 实机或人工证据 | 审核状态 | 审核人/日期 |
| --- | --- | --- | --- | --- |
| I. 保持现有分层架构 | `desktopApi` 边界审计、无新路由/状态框架、前后端测试 | PENDING | PENDING | PENDING |
| II. 向后兼容 | 旧命令签名测试、增量命令测试、schema diff | PENDING：代表性旧项目流程 | PENDING | PENDING |
| III. 测试支撑 | pnpm/Cargo 门禁、Windows Tauri build、Edge/CDP 自动预检 17/17 | 原生 Tauri + 真实引擎 Fast 流程及跨进程重启恢复 PASS；睡眠/缩放/可用性仍 PENDING | PENDING | PENDING |
| IV. 安全持久化与迁移 | recent-index 原子写入/恢复测试、无 schema 修改 | 本次 3 文件素材 checksum 前后相同；代表性旧项目仍 PENDING | PENDING | PENDING |
| V. 结构化可执行错误 | 双格式错误、retryability、stale token、回执测试 | 原生 Brush 进程故障产生本地化 `E-4003`、保留恢复入口并从 Checkpoint 恢复 PASS | PENDING | PENDING |
| VI. 敏感信息保护 | canary redaction、仓库扫描、`.gitignore` 审计 | PENDING：截图/诊断包人工复核 | PENDING | PENDING |

任何例外必须在此表写明受影响原则、理由、风险、恢复/回滚方式和批准人；当前无已批准例外。

## 3. 自动化质量门禁

| 命令 | 结果 | 摘要 |
| --- | --- | --- |
| `pnpm lint` | PASS | 退出码 0，0 warnings |
| `pnpm typecheck` | PASS | strict TypeScript，退出码 0 |
| `pnpm test` | PASS | 22 files / 108 tests passed |
| `pnpm build` | PASS | 退出码 0；保留非阻断的大 chunk 提示，未调高阈值掩盖 |
| `pnpm test:ux:automated` | PASS | Microsoft Edge/CDP 管道，合成 Tauri IPC，17/17；生成物仅在已忽略的 `.test-results/ux-automation/` |
| `pnpm test:tauri:native-fast` | PASS | 原生 `tauri.localhost` WebView2、真实 Tauri IPC 与打包引擎，16/16；Fast 流程 529.617 秒，含暂停/恢复、Checkpoint 后取消/恢复与最终产物校验 |
| `pnpm test:tauri:native-failure-recovery` | PASS | 14/14；唯一 Brush 测试进程被终止后产生本地化 `E-4003`，无虚假成功，全局活动槽释放，Checkpoint 保留并在 32.118 秒内恢复到 Completed/100% |
| 原生应用跨进程重启恢复探测 | PASS | 6/6；项目仍为 Completed/100%，输出清单与 98,778 顶点 PLY 可读，无陈旧 active pipeline；测试 recent 记录已清理 |
| `cargo fmt --all -- --check` | PASS | 退出码 0 |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | PASS | 退出码 0 |
| `cargo test --workspace --all-targets` | PASS | 462 passed；5 个依赖真实引擎/媒体的测试按约定 ignored |
| `pnpm --dir apps/desktop tauri build --debug --no-bundle` | PASS | 首次默认 `target/` 遇到旧沙箱 ACL；未删除缓存，改用已验证可写的 `.codex-cargo-target` 后退出码 0，产物 `splat-desktop.exe` |

## 4. 异步操作审计与测试映射

规则：查询必须区分 loading、完整空结果、部分成功、refreshing、stale 和阻断失败；只有安全且准确标记为 retryable 的操作提供重试。可能产生副作用的 mutation 在重试前重新验证目标与影响，并以 action key single-flight 防重。

| 操作/所有者 | 类型 | 状态、失败与重试策略 | Single flight / 新鲜度 | 自动化所有者 |
| --- | --- | --- | --- | --- |
| app version / engines / settings / recent index bootstrap (`App`) | 查询 | 各自独立完成；recent index 不等待磁盘探测；失败不伪造成功 | 页面卸载防迟到写入；recent availability 另行代际校验 | `App.test.tsx`, `appContextValue.test.ts` |
| active/viewed pipeline refresh (`App`) | 查询 | 保留按项目最后快照，失败标 stale；sequence 防回退 | 全局活动任务与当前项目按 ID 隔离 | `App.test.tsx`, `appContextValue.test.ts` |
| resource metrics (`App`) | 可丢失查询 | 失败归为未知，不显示虚假 0 或成功 | 单一轮询生命周期 | `App.test.tsx`（壳层真实性）；实机计时 PENDING |
| recent availability (`useProjectAvailability`) | 只读查询 | `available/missing/unreadable/check_failed` 分离；仅 check_failed 可重试 | 最多 4 并发；ID/path/generation 丢弃迟到响应 | `useProjectAvailability.test.tsx`, `ProjectNavigator.test.tsx` |
| open/reveal/remove/relink recent project (`App`/`ProjectNavigator`) | mutation | mismatch 与 I/O 失败零替换；独立打开必须显式选择 | Rust CAS + writer lock；UI 防重复 | `ProjectNavigator.test.tsx`, `desktop.test.ts`, Rust `project` tests |
| media analysis / image previews / preflight (`NewProjectPage`) | 查询 | 参数改变即失效旧结果；失败内联并阻止创建 | request generation 丢弃迟到响应 | `NewProjectPage.test.tsx` |
| create/cancel creation (`NewProjectPage`) | mutation | 可见复制进度；取消保留明确结果；创建失败不导航成成功 | create action single-flight | `NewProjectPage.test.tsx` |
| start/resume pipeline (`App`, `NewProjectPage`, `ProjectDetailPage`) | mutation | 已知冲突前端阻断；竞态冲突读取权威活动摘要；不排队/取消 A | 后端全局 gate；重复入口受 busy/冲突保护 | `App.test.tsx`, `NewProjectPage.test.tsx`, Rust `pipeline` tests |
| artifacts/checkpoints/previews (`ProjectDetailPage`) | 查询 | 完整空、部分成功、旧值 stale、首次阻断失败分离；只给安全查询 Retry | project/request key 防旧响应覆盖 | `ProjectDetailPage.test.ts`, `useAsyncResource.test.ts` |
| activity cursor/search/filter refresh (`ActivityWorkbench`) | 查询 | 完整空与 stale 保留；安全 refresh Retry；敏感字段不直接呈现 | query key 丢弃旧查询；确定性去重 | `ActivityWorkbench.test.tsx` |
| preview workspace action (`WorkspaceActionDialog`) | 只读查询 | 初次/刷新失败可见；旧预览仅参考且 Confirm 禁用 | request generation；刷新显式触发 | `WorkspaceActionDialog.test.tsx`, `desktop.test.ts`, Rust action tests |
| execute workspace action (`WorkspaceActionDialog`) | guarded mutation | completed/stale/expired/replay 分离；stale 零副作用并要求再次确认 | token 单次消费；确认 action single-flight | `WorkspaceActionDialog.test.tsx`, `desktop.test.ts`, Rust action tests |
| generic command hook (`useTauriCommand`) | 查询/安全命令基础 | 失败统一为 `UiError` 并保留最后有效值 | pending promise 合并 | `useTauriCommand.test.ts` |
| action receipt / error / diagnostics入口 | 反馈 | 回执持续可见；默认/复制文本脱敏；非 retryable 不给 Retry | 同 action key pending 防重复 | `errors.test.ts`, `ActionReceipt.test.tsx`, `WorkspaceActionDialog.test.tsx` |

审计结论：PASS — 所列自动化所有者与前端/Rust 门禁均通过；真实 FFmpeg/COLMAP/Brush 的 Fast 路径、控制操作、外部 Brush 进程终止后的失败/恢复和应用重启恢复也已通过。Windows 睡眠/恢复、系统缩放与人工可用性证据仍按后续章节保持 PENDING。

## 5. 向后兼容与数据安全

### 5.1 代表性旧项目流程

| 操作 | 期望 | 结果 | 证据/备注 |
| --- | --- | --- | --- |
| Open | 旧项目无需迁移即可打开 | PENDING |  |
| Start | 旧命令与项目状态仍有效 | PENDING |  |
| Pause | 旧签名可调用；新 UI 走 guarded action | PENDING |  |
| Cancel | 旧签名可调用；新 UI 走 guarded action | PENDING |  |
| Resume | A 活动时 B 不写 `Recovering` | PENDING |  |
| Preview | 既有预览读取不改变素材 | PENDING |  |
| Export | 导出仍可用且内容脱敏 | PENDING |  |

### 5.2 Schema、索引与 checksum

| 检查 | 前值 | 后值 | 结果 |
| --- | --- | --- | --- |
| `schemas/project.schema.json` Git blob hash | `731997e8b425e47e5c2d00770eb2b8efdf0c842b` | `731997e8b425e47e5c2d00770eb2b8efdf0c842b` | PASS — 与 HEAD 完全相同 |
| 代表性旧项目 `schema_version` | PENDING | PENDING | PENDING |
| 用户素材目录 checksum 清单 | 3 个脱敏别名及 SHA-256 基线 | 同一 3 个脱敏别名及 SHA-256 复核 | PASS — 主视频、代理视频与时间码旁车文件均未改变；不记录私有路径或文件名 |
| recent-index JSON 格式 | 既有 `ProjectInfo[]` | 既有 `ProjectInfo[]` | PASS（契约/Rust 测试与本次原生 current-project 样本）；测试记录已通过旧 remove 命令清理 |
| availability / preview token 持久化扫描 | 不应出现 | 仅 reducer / runtime state | PASS（源码与 schema 审计） |

## 6. Windows/Tauri 实机场景

补充自动预检：PASS — 生产前端在 Windows Microsoft Edge/CDP 管道中使用纯合成 IPC 数据完成页面上下文、
活动项目冲突、菜单/标签页/抽屉键盘契约、辅助名称、forced-colors/reduced-motion 查询和响应式布局验证，
17/17 通过且无未捕获浏览器异常。另在原生 Tauri/WebView2 中以真实 FFmpeg、COLMAP、Brush 和合法 4K
H.264 素材完成 Fast 流程：266/266 图像注册、6 个 Checkpoint、98,778 顶点 PLY，暂停在 542 ms 内确认，
Checkpoint 后取消并恢复到 Completed；完整应用重启后状态和产物仍可恢复。原生证据保存在已忽略的
`.test-results/native-tauri/`，报告只含别名、计数、耗时和哈希，不含私有路径或媒体。

受控故障注入也已通过：测试仅在基线无 Brush 进程时终止本次新出现的唯一 `brush_app`，项目进入
`failed` 而非虚假成功，持久化本地化 `E-4003`，释放全局 active slot 并保留 500-step Checkpoint；
显式 Retry 后 32.118 秒内恢复 Completed/100%，最终仍有 6 个 Checkpoint 与 98,778 顶点 PLY。

| 场景 | 结果 | 脱敏证据 |
| --- | --- | --- |
| A：项目中心与创建向导 | PARTIAL / PENDING | 原生 IPC 媒体分析、preflight、隔离项目创建 PASS；文件选择器、向导键盘全流程仍 PENDING |
| B：跨页面活动任务、重启、睡眠恢复、外部进程终止 | PARTIAL / PENDING | 原生 Pipeline 暂停/恢复、Checkpoint 后取消/恢复、完成态、跨进程重启与受控 Brush 进程终止 PASS；跨页面视觉和 Windows 睡眠仍 PENDING |
| C：错误、恢复与重跑 | PARTIAL / PENDING | 真实外部 Brush 故障进入本地化 `E-4003`、保留恢复入口、无虚假成功并从 Checkpoint 恢复 PASS；其他错误类型与 UI 全流程仍 PENDING |
| D：Checkpoint 与危险删除、过期确认 | PARTIAL / PENDING | 真实 Brush Checkpoint 保留、取消后恢复与最终 6 个 Checkpoint/产物校验 PASS；删除和 stale 二次确认实机流程仍 PENDING |
| E：available/missing/unreadable/check_failed 与重定位 | PENDING |  |

### 6.1 窗口、缩放与辅助功能截图

截图必须移除项目名、用户名和路径，仅记录附件的脱敏文件名或 PR 链接。

| 窗口 / 缩放 | 键盘全流程 | 焦点/裁切 | forced colors | reduced motion | 截图证据 |
| --- | --- | --- | --- | --- | --- |
| 1440×1024 / 100% | 自动菜单/标签页 PASS；真实全流程 PENDING | 自动截图复核无裁切；实机 PENDING | 浏览器媒体查询/截图 PASS；系统高对比 PENDING | 浏览器媒体查询 PASS；系统设置 PENDING | `home-1440x1024-100pct.png`, `project-forced-colors-reduced-motion.png`（本地忽略目录） |
| 1024×768 / 100% | 自动项目抽屉/Escape PASS；真实全流程 PENDING | 自动焦点恢复/截图复核 PASS；实机 PENDING | 同上 | 同上 | `project-drawer-1024x768-1x.png`（浏览器仿真） |
| 1024×768 / 125% | 自动项目抽屉/Escape PASS；真实全流程 PENDING | 819×614 CSS 保守视口无核心裁切；实机 PENDING | 同上 | 同上 | `project-drawer-1024x768-1_25x.png`（浏览器仿真） |
| 1024×768 / 150% | 自动项目抽屉/Escape PASS；真实全流程 PENDING | 683×512 CSS 保守视口无核心裁切；实机 PENDING | 同上 | 同上 | `project-drawer-1024x768-1_5x.png`（浏览器仿真） |

## 7. 受控可用性协议（SC-001/002/004/005/012）

固定脚本：参与者均为首次使用该应用、具备桌面创作工具基础经验的目标用户；使用同一脱敏测试项目，不给操作提示。依次完成：①从项目中心创建并进入项目；②发现并返回后台活动项目；③从 1,000 条活动中筛选并定位目标错误；④从可恢复错误完成正确恢复；⑤仅用键盘完成项目切换、设置、活动筛选和安全取消。结束后对“当前在何处/系统在做什么”及“下一步和操作影响是否清楚”各给 1–5 分。

| 匿名 ID | SC-001 | SC-002 | SC-004 | SC-005 | 键盘流程 | 清晰度 Q1 | 清晰度 Q2 | 备注（不得含个人信息） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P01 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P02 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P03 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P04 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P05 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P06 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P07 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P08 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P09 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| P10 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |  |
| 汇总 | PENDING | PENDING | PENDING | PENDING | PENDING | 中位数 PENDING | 中位数 PENDING | 阈值按 `spec.md` |

## 8. Release build 单调时钟计时（SC-003/009/010）

以下为生产前端 + Microsoft Edge/CDP + 合成 Tauri IPC 的自动预检样本，使用 `performance.now()` 单调时钟，
每组先预热一次再记录 20 次。SC-003 当前覆盖代表性的暂停→影响说明可见反馈；SC-009 覆盖事件→阶段文案；
SC-010 覆盖固定 1,000 条合成记录。它们证明浏览器级回归阈值，但未覆盖 SC-003 六条真实旅程的全部主操作，
也不能替代原生 Tauri/WebView2/真实设备正式计时，因此 T082 仍为 `PENDING`。

| 样本 | SC-003 最慢主操作 busy (ms) | SC-009 状态传播 (ms) | SC-010 1,000 条筛选定位 (ms) |
| --- | ---: | ---: | ---: |
| R01 | 36.4 | 56.3 | 1.9 |
| R02 | 35.7 | 81.2 | 5.5 |
| R03 | 41.1 | 117.9 | 6.5 |
| R04 | 51.9 | 82.4 | 6.4 |
| R05 | 36.6 | 83.2 | 2.8 |
| R06 | 42.5 | 80.7 | 1.8 |
| R07 | 37.6 | 123.4 | 1 |
| R08 | 35.2 | 102.9 | 1.2 |
| R09 | 42.1 | 92.3 | 1.1 |
| R10 | 71 | 97.3 | 1.6 |
| R11 | 32.3 | 95.1 | 1.8 |
| R12 | 34 | 145.8 | 1.5 |
| R13 | 60 | 90 | 2 |
| R14 | 32.5 | 100.3 | 1.4 |
| R15 | 37.1 | 82.6 | 2 |
| R16 | 62.9 | 87 | 2.2 |
| R17 | 31.7 | 80.8 | 3.5 |
| R18 | 35.3 | 89.2 | 1.2 |
| R19 | 59.7 | 84.3 | 0.9 |
| R20 | 32.5 | 80.6 | 1 |
| p95 | 62.9 | 123.4 | 6.4 |
| 阈值 | `< 1000` 每项 | `≤ 2000` | `≤ 2000` |

p95 计算：按升序排列 20 个样本，使用 nearest-rank `ceil(0.95 × n)` 对应值。自动预检三项均低于阈值；
正式 release 判定仍不得以 jsdom、浏览器仿真或主观观察替代真实 Tauri 表现。

## 9. 隐私与仓库审计

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| canary credentials / `PrivateUser` /绝对私有路径不进入默认 UI、复制文本和回执 | PASS（自动化范围） | `errors.test.ts`, `ActionReceipt.test.tsx`, 108-test gate |
| 活动详情不呈现 raw engine output、raw string metrics 或 unrelated source log | PASS（自动化范围） | `ActivityWorkbench.test.tsx` |
| 诊断包脱敏凭据、用户标识、项目/引擎/home 路径并排除无关日志 | PASS（自动化范围） | Rust `diagnostic_documents_redact_credentials_paths_and_unrelated_event_content`；zip 人工抽检 PENDING |
| `git status` 无媒体、项目、日志、诊断、环境文件、引擎二进制和模型权重 | PASS | 分类扫描无禁止条目；合成 canary 仅存在于测试/验证说明 |
| `.gitignore` 覆盖上述本地产物 | PASS | `target/`, `.codex-cargo-target/`, `.test-results/`, `dist/`, `.env*`, logs, coverage, projects 均受保护 |
| 常见真实凭据模式扫描 | PASS | 未发现 private key、AWS、GitHub、Slack 或 OpenAI token 模式 |
| diff/schema/release 文档 | PASS（自动化范围） | `git diff --check` 通过；schema blob 未变；CHANGELOG/architecture/development 已更新 |

## 10. 最终结论

当前结论：`PENDING`。自动化门禁、Windows Tauri build、浏览器级 UX 预检，以及原生真实引擎 Fast
流程、外部 Brush 进程故障恢复和跨进程重启恢复已通过；仍需 Windows 睡眠/缩放/高对比场景、至少 10 人协议、
代表性旧项目比较、正式全旅程计时和六项独立审核签署，完成后才能改为 `PASS`。
