# 当前状态与验收边界 / Project status

更新日期：2026-11-10（Asia/Shanghai）。本页是平台、引擎路线、候选构建、已验范围、待验事项和证据位置的统一入口。操作步骤见[开发指南](development.md)和[使用指南](user-operation-flow.zh-CN.md)，视觉规则见[当前设计规范](design-system.zh-CN.md)。

项目仍为 **Alpha / v0.1.0**，没有受支持的公开二进制发布。代码支持、自动测试、特定构建的实机结果、公开发布许可是独立状态。本页整理已有记录，不将历史结果转移到当前源码或另一安装包。

## 平台与引擎路线

| 路线 | 当前入口与引擎 | 支持和分发边界 |
| --- | --- | --- |
| Windows 10/11 x64 legacy | 普通 `pnpm tauri dev` 的默认发现和默认发布打包保留 `.engines/windows-x64/distribution/`；Brush 0.3 + `brush_live.exe` companion | 已有真实重建基线；内部安装包，未获公开分发验收 |
| Windows 10/11 x64 Windows1 | 显式 `pnpm dev:windows`、`prepare:windows:alignment`、`verify:windows:alignment`；`.engines/windows-x64/alignment/`，Brush 1 主 CLI | 候选路线。新项目默认 Auto，先检查 DX12，仅合格计算失败或清理后的超时才独立检查 Vulkan；显式或项目冻结选择不回退。COLMAP 特征提取/匹配仍用 CUDA，未支持 AMD 整流程。未切换 legacy 发布默认 |
| Apple Silicon macOS 开发 | `.engines/macos-arm64/development/`；FFmpeg 8.1.2、CPU COLMAP 4.1.0、Metal Brush `metorigin-macos.5` | 原生开发及真实照片/视频已有分项记录；配置最低macOS 15.0，最低系统与16 GB仍未验收 |
| Apple Silicon macOS 完整包 | `.engines/macos-arm64/distribution/` 冻结Alpha `.6`；显式签名时派生独立signed engine pack | 内部Alpha。派生包有独立清单身份，不覆盖冻结源包，不继承额外验收 |

这些路线不得混作同一引擎身份。显式设置和开发覆盖按[引擎接入](engine-integration.md)解析。打包步骤见 [Windows packaging](../packaging/windows-x64/README.md) 和 [macOS packaging](macos-packaging.zh-CN.md)。Windows使用WebView2，macOS使用WKWebView；查看与编辑的图形能力须分别验证。

Windows1/Mac主CLI实现协商后的live request/ACK，legacy使用独立companion。当前工作台自动管理预览请求；底层组件的模式和测试控件不代表当前可见按钮，见[实时预览](gaussian-live-preview.zh-CN.md)。

## 候选构建与证据身份

这里区分本机成功指针与已提交的历史验收记录。`artifacts/`、`.engines/`和历史`target/`证据不随Git提交，新克隆需另行生成或取得证据。

| 构建 / 记录 | 已记录范围 | 不能据此推断 |
| --- | --- | --- |
| **GPU resilience，2026-11-09 至 11-10**；实现 `908863b`，Mac 受测源码 `2121f91` | RTX 5080 Laptop 的 Auto→DX12、显式 Vulkan 均完成 James40 3000 步核心流水线、恢复、导出和重开，另有原生编辑保存/诊断证据；M1 Pro 32 GiB / macOS 27.0.1 完成 Metal 核心及原生 GUI 验收 | 两平台结果绑定各自记录的二进制，不能转移为新 Windows 安装器验收；RX 6600、其他 GPU、macOS 15 与干净机未验收。详见 [Windows 记录](validation/gpu-backend-resilience.md)及 [M1 Pro 结果](validation/gpu-resilience-m1-pro-results.md) |
| **M1 Pro 后续签名交付 `build.TdUd9m`，2026-11-10**；DMG `2e5beb2f…842b7b` | Developer ID 签名、Apple Accepted、DMG 票据、Gatekeeper、126 项 ticket 覆盖审计及签名后 Metal compute smoke 通过；记录见 [M1 Pro 结果](validation/gpu-resilience-m1-pro-results.md) | 签名后字节未重跑 3000 步和完整 GUI；应用单独 staple/execute assessment、干净机未执行；许可证人工审查缺项仍阻止公开发布。原始载荷和完整回执在执行的 Mac 上 |
| **Mac本机成功指针 `build.zvw9R6`，2026-11-01**；应用 `955e0b41…`，DMG `9a0f88b7…` | `latest.json`与该轮`final.json`一致；Developer ID应用和123项嵌套Mach-O验证；Apple `Accepted`、DMG附票据和Gatekeeper通过；只读挂载与来源应用一致；签名引擎重定位及真实CPU COLMAP提取。原回执记录119项自动检查。本次文档整理另只读核对应用/DMG哈希与回执一致 | 应用自身没有附票据；本轮未重跑签名/公证。应用许可仍`release_ready=false`，794个清单文件、1项许可文本缺项；干净机首次下载/打开和完整3DGS训练未验收 |
| **Mac历史原生基线 `a2146f95 / build.OX71fC`，2026-10-28** | ad-hoc包；Spark/Home六轮、正常退出和439文件完整性等有独立证据；相同包的后续VM分类诊断单列 | 内存稳定性未通过；编辑/保存、训练等不能从别的包转移到此包，更不能转移到`zvw9R6`或当前源码 |
| **Windows1最新已提交候选记录：879输入、源码 `5283428e`、NSS `320f8d50…f7505`，2026-10-30** | 来源/工具与159资源核对；复制NSS载荷的高质量原生预检和确认保持30000步/SH2/2560；公开TUM生产30k有效产物有独立复核，原harness后置断言失败也保留；原素材640×480、实际训练622×466，不是2560px负载验收 | 未实际安装该新NSIS。不能继承旧包的安装、完整原生训练、编辑及异常恢复；不宣称用户工程视觉问题已解决 |
| **Windows1历史 `5386…` 与 `7348…`** | `5386…`有安装/重定位、真实视频、强退重开恢复、直接暂停/继续和独立session预览协议开关记录；`7348…`有六轮查看/编辑/导出记录 | 两个应用身份的范围不能合并为879候选通过；旧3000步/960px限制不代表修复后的生产预设 |

### 本机Mac成功回执

- [成功指针](../artifacts/verification/macos-arm64/latest.json)、[最终报告](../artifacts/verification/macos-arm64/build.zvw9R6/final.json)、[验证摘要](../artifacts/verification/macos-arm64/build.zvw9R6/validation-summary.json)。
- [公证结果](../artifacts/verification/macos-arm64/build.zvw9R6/notary-dmg/result.json)、[公证审计](../artifacts/verification/macos-arm64/build.zvw9R6/notarization-audit.json)。这里只链接本地回执，不复制凭据或签名身份信息到源码文档。
- 应用SHA-256：`955e0b410d4d7f22fde6d0a89ce5181bbd36f0e8c08ca30fb89655f95924893d`。
- 已附票据DMG SHA-256：`9a0f88b7ed50cbb8b65791623956e14a942fc4489d743bea6234139613f5cb44`。
- 签名派生引擎清单SHA-256：`d17e31d232b65447439a2d43a904e698f54e0f9c0587bd4c210e1cd975aa3fe4`；原冻结源包仍为`590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`。
- 容器策略为`stapled-dmg-with-developer-id-application`：DMG公证通过，应用自身`notarization_verified=false`；这与应用独立附票据的严格策略不同。

Mac历史详情见[引擎包](validation/macos-engine-pack.md)、[原生UI](validation/macos-native-ui.md)、[资源](validation/macos-m3-resources.md)。Windows各构建的来源、安装及结果见[对齐总账](validation/windows-alignment.md)、[候选包](validation/windows-engine-pack.md)、[原生UI](validation/windows-native-ui.md)。

## 尚未关闭的验收与发布事项

| 范围 | 待验 / 未关闭事项 | 原始记录 |
| --- | --- | --- |
| Mac系统与硬件 | macOS 15最低系统、16 GB、干净机安装/首次打开及完整离线重建；同主机重定位不能替代 | [历史方案](archive/plans/macos-gaussian-generation-plan.zh-CN.md)、[包记录](validation/macos-engine-pack.md) |
| Mac资源与生命周期 | 内存稳定性、受控真实压力、系统睡眠/唤醒、Dock/最小化等未覆盖场景；VM分类诊断结束不代表M3/M4通过 | [资源](validation/macos-m3-resources.md)、[退出恢复](validation/macos-shutdown.md)、[空闲睡眠](validation/macos-idle-sleep.md) |
| Mac质量与新包回归 | 混合输入相对质量差异；新签名包独立的原生生成、编辑/保存、预览和恢复覆盖 | [混合输入](validation/macos-mixed-input.md)、[原生UI](validation/macos-native-ui.md) |
| Windows候选 | 879候选实际安装、升级/卸载、完整原生回归；clean VM与完整断网依赖、真实压力/睡眠；直接取消按钮和训练live期间跨项目往返尚无有效原生通过记录 | [总账](validation/windows-alignment.md)、[原生UI](validation/windows-native-ui.md) |
| 跨平台与默认切换 | GPU resilience 的 M1 Pro 分项原生回归已记录；其他平台/包身份的验收与公开发布门槛仍开放，legacy 发布默认未切换 | [GPU验证](validation/gpu-backend-resilience.md)、[M1 Pro结果](validation/gpu-resilience-m1-pro-results.md)、[Windows总账](validation/windows-alignment.md) |
| 设计与可用性 | 当前Jan界面的Windows/DPI、原生200%缩放、中英/明暗/compact组合、读屏、forced colors、中文IME、性能对照，以及仍未覆盖的真实失败恢复/重跑、创建取消清理、Restore/Delete、确认/阻塞及诊断/设置失败组合；现行编辑器的跨平台工具/保存/退出/导出组合 | [设计历史](archive/design/frontend-migration-plan.zh-CN.md)、[旧任务](archive/specs/001-frontend-ux-improvements/tasks.md)、[旧验收](archive/specs/001-frontend-ux-improvements/validation-results.md) |
| 公开二进制发布 | 应用许可缺项、各路线独立的对应源码/依赖/权重证据、SBOM审查、安全审查及兼容性矩阵；legacy权重问题和新路线排除LPIPS的政策分别记录 | [发布流程](release-process.md)、[Windows材料](windows-alpha-release.zh-CN.md)、[LPIPS政策](../integrations/brush-macos/LPIPS-AUDIT.md) |

旧Spec的T082/T084和最终`PENDING`保持原记录；归档不会关闭这些事项。交通灯精确几何已有后续分项记录，旧Popover已删除，不重新列为待实现。历史台账的“当前”“最终”“待验”只对该段日期与构建有效；本页负责汇总最新已知状态。关闭事项时，在原始记录追加构建身份和证据，再更新本表。

## 证据和文档维护

- 当前操作、格式、视觉规范分别维护在指南、schemas及Rust类型、[设计规范](design-system.zh-CN.md)；冻结方案和实验见[档案索引](archive/README.md)。
- 新正式报告放`artifacts/verification/<platform>/`，安装包放`artifacts/packages/<platform>/`。来源与许可输入保留所属模块，清理遵循[保留规则](development.md#generated-files-and-cleanup)。
- 历史回执的原路径、构建SHA、计数和失败边界保留；定位旧产物可运行`pnpm artifacts:resolve -- <old-path>`。`exists: false`表示当前没有载荷，不改写当时结果。
- 更新状态时核对所选成功指针与冻结报告；新构建、签名、依赖变化须有独立身份及适用验收，不能沿用旧通过结论。
