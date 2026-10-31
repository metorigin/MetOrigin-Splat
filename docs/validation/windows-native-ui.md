# Windows 原生 UI 验证

日期：2026-10-30–31；下文事件时间注明 UTC。本文记录实际安装应用在 Windows 原生窗口中的操作，以及独立读取项目、模型和导出文件所得的结果。照片完整流水线的非 UI 验证见 [windows-core-pipeline.md](windows-core-pipeline.md)。这些结果不改变发布默认值；原生 macOS 回归仍是独立门禁。

## 可执行文件与证据边界

下述早期照片向导、正常关窗与继续、实时预览、六轮查看器／编辑器往返、编辑保存和图像导出，均属于实际安装的应用：

`7348bb36d1a792249faf60e5916478e360a943573d75b2cb4779974d9ccc5407`

其原始构建 EXE 为 `07d66b5e8cf9aded1a83b28e0540cac782b0c19cd40b93aa3041909ae7952db5`。原生启动使用已安装路径、仅含 `System32` 与 `SystemRoot` 的 PATH、刻意无效的开发引擎目录提示；项目冻结的四个引擎 SHA 与实际安装资源一致。使用机器已有 WebView2／运行库，不据此宣称干净机器验收。启动记录为 `target/windows-native-final/launch*.json`。

该应用对应的历史 797 项来源清单 digest 为 `222514f33e064727c45e6479b624811acb8bcc5c0a7e3b3319ddc33a0df80be3`。独立审查发现 71 个仓库直接输入及四个显式主题字体输入未直接收录；锁文件、准备签名和验证器已对其中内容提供间接绑定，但不能把历史清单称为完整直接覆盖。详见 `target/windows-alignment-evidence/source-inventory-797-independent-review.json`。

随后完成的最终候选采用 874 项来源清单，digest `08eb5d854019def159a3988aa3b48c353405b8b4ac873cc05b78fa46f9b52ee0`，以及 451 项独立 bundler 输入清单。原缺项、新打包 helper 和选定的外部工具／安装器资源均已补入并复核。最终实际安装 EXE 为 `53865e80ce7a026fab30da0ce2a4199e809c9a71e97c6882c402c545147dc594`，原始 EXE 为 `d64d74bf1cb3ff7f602ff266fee82e3c2aa63ea2e247f4eed8ee2dd5fb3dd7f4`。新旧原始 EXE 的 24 字节 PE 元数据差异已另行审查；这里仍保留两个不同的精确二进制身份，不将 `7348…` 的 UI 结果改记为 `5386…`。最终来源、NSIS 身份转换、12 个产物校验和 158 个实际安装资源的复核见 `target/windows-alignment-evidence/final-874-independent-review.json`。

## 原生创建、正常关窗与继续生成

通过原生向导导入固定 CC0 James40 原始照片，在中文及空格路径创建项目：

`target/windows-native-final/projects/安装验收 照片 中文 空格.splat-project`

相机重建运行期间实际点击窗口关闭。应用自然退出，项目与 mapping 状态落为 `paused`，项目锁释放；按已采样 PID 与创建时间检查，原应用及已知引擎后代均已停止。这是正常关窗的进程清理证据，范围为已知进程身份。记录为 `normal-active-close.json` 和 `normal-active-close-project.json`。

从原生 UI 重新打开并点击继续，全部 12 个生产阶段完成：

| 项目 | 实测结果 |
| --- | --- |
| 照片注册 | 40/40，100% |
| 稀疏点 | 35,093 |
| 平均重投影误差 | 0.329136 px |
| 最终 Gaussian | 137,369，SH0 |
| 训练 | 3,000 步，960 像素，六个完整 checkpoint |
| 最终发布模型 | 7,693,170 字节，完整 Gaussian 属性及所有数值有限 |

冻结 profile 为 Windows1，实际 DX12 独立 GPU 前向／反向探测成功，八个 Gaussian、32×32、有限正梯度；探测设备身份与训练日志一致。COLMAP 明确采用 CUDA 特征提取／匹配、CPU global positioning 与 Ceres CPU BA。预算为显式候选策略，未把 NVIDIA 总 VRAM 记录为动态可用 adapter budget。

生成的 `scene.ply` SHA-256 为 `ce675cf4f54135569c3346cd4b46e49693a11c7357e02dfde2780488ce676a56`，与 checkpoint3000 相同，并保全为 `target/windows-native-final/generated-original.ply`。独立 receipt 为 `target/windows-alignment-evidence/native-installed-project-validation.json`；它还逐项核对原始照片和项目 raw 副本、实际安装引擎 SHA、12 阶段状态与锁释放。

训练期间，原生画面实际显示过 1 步／35,093 个 Gaussian 的实时模型，之后显示完成模型。没有据此声称目测了全部 live 帧。完成后的协议残留显示 session 已停止、ACK 至少到 revision6、latest 为 revision7，保留两份快照；最终未 ACK 的发布帧可在训练结束时存在。UIA 为 `uia-training-or-completion-04.json`，协议残留亦收于上述独立 receipt。

## 六轮查看器与编辑器往返

15:25:34.876Z–15:33:02.850Z 完成六轮原生往返，十二份 UIA 均确认 137,369 点。十二个离散资源样本中，七个应用／WebView2 角色的 PID 与创建时间保持一致，未出现 Brush/COLMAP 后代。逐轮 UIA 为 `uia-{editor,viewer}-round-01..06.json`；原始采样及独立汇总为 `resource-samples.jsonl`、`six-round-resource-summary.json`，均位于 `target/windows-native-final/`。

主要进程的离散观察值如下，单位 MiB；RSS／private 分别列示：

| 角色（PID） | editor RSS／private | viewer RSS／private |
| --- | --- | --- |
| 应用（37220） | 55.33–70.33／20.34–34.67 | 56.02–70.32／20.68–34.66 |
| WebView browser（45452） | 154.92–157.34／54.54–56.54 | 147.23–149.76／46.70–48.97 |
| renderer（28264） | 249.62–268.09／182.75–200.50 | 264.56–288.26／204.40–227.78 |
| GPU process（37368） | 224.13–238.19／383.66–391.44 | 153.98–161.60／172.00–267.03 |

GPU PID37368 的 LUID `0x00000000_0x000165DE` dedicated counter 在 editor 为 289.93–295.82 MiB，返回 viewer 后为 99.68–130.64 MiB；TotalCommitted 分别为 342.31–347.22 与 104.42–136.95 MiB。这里记录 Windows per-PID/LUID counter，未独立建立该 LUID 与 WGPU canonical device 的映射，也未将其当作动态可用预算。全局 NVIDIA used-memory 为 1,789–1,991 MiB，只是全机观察。

viewer01 资源点早于其成功 UIA 43.054 秒，属于加载早期，不能作为稳定查看器基线；其余资源点在对应 UIA 后约 5.98–12.32 秒。browser 的 viewer private 从 46.70 增至 48.97 MiB，其余主要进程有起伏。这些单机、短时、离散数据不足以证明无泄漏。RSS 含共享页，不应求和当作独占物理 RAM；private 为进程提交量观察。六轮窗口内没有其他验收训练，NSIS 和 CPU 编译可能并发；稍后的 legacy GPU 测试不属于此窗口。

六轮结束后的边界检查确认原图、项目 raw 副本及生成 scene SHA 未变；没有声称每一轮都独立拍摄过磁盘哈希快照。

## 编辑、受阻保存与重试

在实际 SuperSplat 编辑器将 X 平移设为 `0.05`。验收辅助程序为模型保持只读共享句柄，禁止删除／替换，实际点击保存后失败，旧 `ce675cf4…676a56` 模型保持完整。界面原样显示：

> 保存未完成：DesktopCommandError: 拒绝访问。 (os error 5)

错误反馈含内部异常名与 OS 错误文本；本轮如实记录，没有修改产品代码来掩盖或改善该文案。失败后尝试关窗，未保存保护出现，实际选择继续编辑，编辑内容保留。相关 UIA 为 `uia-edit-before-save-failure.json`、`uia-save-denied-held-reader.json`、`uia-dirty-close-after-save-failure.json`。

释放读句柄后再次保存成功，原生 UI 显示“模型已保存”，见 `uia-save-retry-after-reader-released.json`。保存后的模型仍有 137,369 点，所需 Gaussian 属性齐全、所有 scalar 有限，大小 7,693,026 字节，SHA-256 为 `8deb6759f7ea956b767f5de8fa8178270fe0243a7d30786f1fd748f612859cef`。原始生成模型的保全副本仍为 `ce675cf4…676a56`。这是模型数据保存结果，不代表恢复了训练优化器状态。

## 图像导出与取消

在同一已保存 X+0.05 模型及相机视图上，经原生图像设置和系统保存对话框实际保存三份文件。分辨率均请求 1800×1415；PNG、WebP 勾选透明背景；JPEG 请求质量90，其透明背景控件隐藏。设置 UIA 为 `uia-png-transparent-options.json`、`uia-jpeg-quality90-options.json`、`uia-webp-transparent-options.json`。

独立 Pillow11.3.0 全量解码结果如下：

| 文件（`target/windows-native-final/exports/`） | 实际格式／模式 | 尺寸 | 字节数 | SHA-256 |
| --- | --- | --- | --- | --- |
| 透明 PNG 中文.png | PNG／RGBA，alpha0–255 | 1800×1415 | 469,052 | `6f78fb094fe225e9ac5e65df284597c7146250a2efa467e3f722456bc05d7992` |
| JPEG 质量90 中文.jpg | JPEG／RGB，无 alpha | 1800×1415 | 38,643 | `871f80e3a10eb5d205e63944a44c9fb10d69e8bcc0d658d346c7faf2a352a10b` |
| 透明 WebP 中文.webp | WebP／RGBA，alpha0–255 | 1800×1415 | 171,404 | `ecd92bbd76eaa91c6ea93e675ad2e76c61bbf68bc75e5fa323df886ce75d2530` |

三份均为非空、非恒定图像。PNG/WebP 均有透明背景及 380,024 个 alpha 非零像素。JPEG90 是原生设置观察，没有从文件元数据反推出固定编码质量。receipt 为 `image-export-independent-validation.json`。

PNG/WebP 解码 RGBA 不完全一致：107,563 个差异像素中，107,413 个双方 alpha 为0；只有150个位于任一 alpha 非零处。alpha 仅一个像素差1级；分别合成到黑／白背景后最大通道差4/255，平均绝对差约0.00004/255。该观察不预设编码模式或渲染确定性，亦不把本对文件称为无损一致；见 `image-export-comparison-supplement.json`。

随后实际打开系统保存流程并取消，未创建第四份导出，三份导出及已保存模型 hash 均保持不变。取消相关记录为 `uia-export-cancel-native-dialog.json`、`uia-export-cancel-complete.json`；后者 accessibility 为 null，不能单独证明取消后的视图结构。取消结果由原生操作观察及文件边界核对共同支持。15:53:22Z 的只读复核再次确认三文件 hash、`8deb…59cef` 编辑模型、`ce675…676a56` 保全模型及全部40份原图／raw 副本未变，并复核编辑模型全量有限。

## 最终874来源／5386应用：重定位后的视频完整生成

以下为随后独立完成的最终应用验收，精确 EXE 身份为 `53865e80ce7a026fab30da0ce2a4199e809c9a71e97c6882c402c545147dc594`，来源清单为上述874项／`08eb5d85…52ee0`。它不沿用 `7348…` 的六轮资源、编辑保存或三格式导出结果。

实际安装载荷连同全部资源移至 `target/windows-install-validation/重定位 最终载荷 中文 空格 6f069c00/` 后，通过该原生窗口新建 `target/windows-native-final/projects/最终 视频 中文 空格.splat-project`。启动仍采用仅系统目录的 PATH、无效开发引擎提示、独立候选 KnownFolder 标识；机器网络保持开启，因此不称为断网验收。

原始 TUM desk AVI 与项目复制源均为 SHA-256 `3faa0fa667fa95d28ecf0d231c3383ddef8695f391f07d48f484af39de43a854`。实际容器20.433333秒；原生 fast 向导本次自动选择2 fps，产生41帧，与前述 core harness 的5 fps／102帧试验区分。全部12阶段完成，41/41注册，1,833个稀疏点，平均重投影误差0.794784 px。初次3,000步生成34,472个 Gaussian，六个 checkpoint 均完整有限，scene 与 checkpoint3000 同 SHA：

`b97184c897b4ff693cbf0589cc3b3bb0e5fda71c33bb231ff368d90a98820455`

独立读取验证了重定位后的应用及四引擎 SHA、冻结 profile、已记录的真实 DX12 probe/device 与训练日志、所有模型 scalar、源哈希和无锁状态；没有为审查额外启动 probe 或 GPU。记录为 `target/windows-native-final/final-video-completed-independent-validation.json`。`uia-final874-video-running.json` 实际已显示“重建完成”；同名资源 label `final874-video-running` 的采样时间16:06:26Z晚于16:05:43Z发布，按完成后查看器观察解释，不能当作训练、加载或 live 峰值。

## 最终5386应用：实际强制退出与原生重开继续

完整视频生成后，实际通过 UI 显式恢复 checkpoint500。第一次辅助验收 `crash-final-01` 在已满足 gate 后、执行退出前因 PowerShell GenericList 数组转换报 `Argument types do not match`；记录明确 `app_termination_attempted=false`。生产训练未被终止，随后继续完成为34,236点，scene SHA 为 `6388549fd580611c3f724d0380e6a65fa2ea3edcf6b18291c6b84f10f8576574`。该次辅助失败没有改记为强制退出通过。

失败证据及 `957d4766…` helper 历史副本保留；仅在 ignored 最终 helper 中修复两个 GenericList 投影为 `.ToArray()`，并以非空／空 mock 实际序列化和回读验证。第二轮使用 `2a3925ce…ebb8a` helper，原 `7348…` helper 未改。详见 `crash-final-helper-list-serialization-review.json`。这些是验收辅助程序修正，没有修改产品代码。

再独立通过 UI 恢复500后，`crash-final-02` 在新鲜完整 checkpoint1000出现时执行故障注入：

- 精确应用 PID26152、创建时间、重定位路径及 `5386…` SHA 均绑定；实际 Brush PID33120直接属于该应用，命令明确指向当前项目 dataset，`--start-iter 500`、DX12及 canonical device 参数均匹配。
- 新 checkpoint1000为4,366点，SHA `c3a71b885820a0812d916b4ed180c295ba3b3aacd71f5bbabac8046dc51a18be`，修改时间晚于该 Brush 创建；完整 payload 和全部 scalar 有限。
- helper 只对持有的应用 process handle 调用一次 `Kill()`，未使用整个进程树终止，也未按名字或逐个杀子进程。已知引擎身份均停止；helper前后完整 checkpoint 和保全模型 SHA 不变。
- 强杀后磁盘状态仍为 `running`／`BrushTraining` 且 `.lock` 存在，这是 abrupt exit留下的状态；审查没有修复或手改项目。

即时 after snapshot仍见两个旧 WebView后代，不能声称 WebView瞬间全部退出。16:23:57Z原生只读 PID查询确认六个旧 WebView、旧应用和已知旧 Brush PID均已不存在，仅新应用49060存在；两次观察之间的精确退出延迟未采样。Sandbox查询不可见时所得空列表被明确排除，未当作退出证据。

保全也核对到项目内部的真实归档，而不只核对外部复制件：

| 阶段 | 实际项目归档 | 点数／SHA |
| --- | --- | --- |
| 初次完整生成后恢复500 | `runtime/checkpoint-restores/01a18d96-421b-7d12-a0e0-c1e50f867b1d/output/scene.ply` | 34,472／`b97184c8…820455` |
| 首轮未kill、再次完成后恢复500 | `runtime/checkpoint-restores/01a18d9b-b8a0-7b50-8a10-d0dab5940e79/output/scene.ply` | 34,236／`6388549f…576574` |

两份归档分别与 `generated-video-original.ply`、`generated-video-before-crash.ply` 同 SHA。第二轮边界审查还完整读取12份项目归档 PLY并确认有限，详见 `crash-final-02-independent-validation.json`，原始 before／termination／after JSON均保留在 `crash-final-02/`。

随后通过同一最终重定位应用实际重开，PID49060，Process.StartTime UTC `2026-10-30T16:21:27.8479145Z`。原生打开项目自动 reconcile为已暂停，显示保留两个恢复点、最近1,000步／4,366点画面，见 `uia-final874-crash-project-reconciled.json`。点击继续后实际完成3,000步，UI显示32,545个 Gaussian、六个 checkpoint，见 `uia-final874-after-crash-resume-status.json`。

独立事后核对确认：全部12阶段完成、无项目锁；`training/result.json` 明确 `resumed_from_iteration=1000`、`optimizer_state_restored=false`；最终scene及六个 checkpoint均完整、所有 scalar有限，checkpoint3000与scene同 SHA：

`532e33b12a45163373268eef5317e888a3463635347bb56799f02f8c8e5cb562`

TUM原／复制源、实际重定位引擎身份、前述两个真实归档及其保全副本均保持不变；500和被强杀时的新1000也保持原 SHA。记录为 `final-video-post-crash-resume-independent-validation.json`。这是实际 PLY几何 warm start，优化器明确重新初始化；不同完成尝试的点数不是数值确定性或质量等价证明。

## 最终5386应用：中型副本的直接 UI 控制

为补充任务面板与训练预览的实际交互，先精确复制完成项目到 `target/windows-native-final/projects/交互验收 视频 中文 空格.splat-project`。41帧副本从500继续后完成较快，第一次暂停影响确认生效前已完成；确认保护拒绝“项目状态已变化，尚未执行任何操作”。该次只证明状态变化后的安全拒绝，不算暂停成功。

随后将原307帧中型项目精确复制到 `target/windows-native-final/projects/交互验收 中型 中文 空格.splat-project`。1,015个文件、44个目录、306,406,690字节逐文件SHA一致，内部 project/profile/fingerprint/name/ID均未修改；原项目完整基准清单保存在 `ui-controls-medium-source-inventory-before.json`，复制证明为 `ui-controls-medium-copy-preparation.json`。16:58:29Z前的独立完整核对再次确认原项目全部1,015个文件和 TUM原／副本视频未变。

副本保留原ID及可见名称“Windows1 中型视频 中文 空格”。最近项目索引按ID／路径去重，前端部分状态也按ID选择；原目录与同ID副本不能当作两个独立项目进行训练中的来回切换。实际操作使用明确副本路径；拟进行的跨项目检查必须另用不同ID的照片工程，本轮未完成该检查。后端文件操作及活动 worker仍绑定显式目录；没有为本轮验收改生产代码或项目内部身份。

### 实际暂停与继续

原生点击暂停任务并确认影响后，`uia-final874-controls-medium-pause-confirmed.json`（16:56:53.153Z）显示已暂停／继续按钮、四个恢复点（500–2000），最近live画面为1,664步／79,931点。同期 observer seq227–285在16:56:52.911Z–16:57:50.911Z的59个样本全部为 project paused、BrushTraining paused、`.lock`不存在、该live session `running=false`。

原始59行及来源prefix绑定在 `ui-controls-medium-pause-observer-excerpt.{json,jsonl}`；关联receipt为 `medium-controls-pause-observer-correlated-receipt.json`。Observer不读取PLY或枚举checkpoint，不能从它声称暂停时已有四份payload哈希。四个保留文件随后独立全量读取，分别为35,639、47,355、70,814、89,656点，所有scalar有限，mtime均早于暂停；这些稍后的hash与同期状态／UIA分开记录。审查实际到达磁盘时已继续完成，`medium-controls-paused-boundary.json`明确标记 `not_paused_at_disk_capture`，没有用较晚完成状态冒充暂停快照。

在该暂停点实际点击继续，从2000步继续至3000步完成，原生UI显示133,607点和六个checkpoint，见 `uia-final874-controls-medium-resume-completed.json`。这次直接按钮暂停／继续有独立证据，不依赖此前正常关窗或强杀恢复结果。

### 两次独立训练中的预览 off 与 live 请求

以下是两次独立恢复训练、两个不同session的试验，不合并成一次连续session的off／on记录。结构化范围见 `ui-controls-medium-preview-observer-findings.json` 与 `ui-controls-medium-live-on-observer-receipt.json`；第一段observer完整900行的最终SHA为 `a1bb9b000c775ed0e95dcaa3b602cb6ffad13cff95773d3fecda7d32565038d5`。

1. **关闭预览后保持训练，最终模型接替。** 独立从500恢复的 session `01a18dc2-414f-7742-a9b8-729411188b8f` 中，17:01:49.912Z–17:01:55.912Z有七个off且训练仍running的样本。该窗口latest始终为revision3／iteration2137，mtime `17:01:43.026131Z`，latest JSON SHA始终为 `9d5d5fc85488bd6a0c82406705ca0a22d9baf236d77427bf490ac658b247b5e7`。这是所采窗口中无新发布的证据，不能把七秒观测扩展为全程无瞬时活动。训练继续完成，17:03:52.718Z的 `uia-final874-controls-medium-off-final-takeover.json` 显示145,496点、高斯渲染和重建完成，记录最终模型接替预览。
2. **新session先off、随后实际live请求发布新帧。** 下一独立 session `01a18dc6-cbeb-74b1-a0ee-4180e9ad0166` 在17:06:19.914Z–17:06:34.913Z有16个off且无latest样本。实际live请求mtime为17:06:34.955177Z，随后17:06:35.091383Z发布revision1／iteration1632／80,110点；日志继续记录revision2／2253／111,083点和revision3／2903／145,463点。

第二次试验的首份on UIA时间为17:06:35.187Z，文本当时仍为等待首帧；它不能单独证明1632帧已经显示。后续UIA确有2253步／111,083点的训练实时预览文本。请求、发布JSON、UIA和训练日志共同给出有限时序证据，observer不检查渲染像素或PLY，不据此声称每份发布都被目测、消费或ACK。保全训练日志为 `ui-controls-medium-live-on-training-log-preserved.log`，记录训练循环17:06:19.685Z开始，17:06:54.678Z Done，17:06:54.914Z exit0；17:06:55.913Z首个样本已completed、解锁、session停止。

### 尚不能记为取消成功的确认竞态

以上较早的取消确认均未取得“实际运行中取消成功”的证据。例如 `uia-final874-controls-medium-cancel-impact.json` 时间17:06:55.020Z已晚于真实Done约0.34秒，尽管UI还显示此前2253步live状态；这是UI滞后，不能证明该时刻引擎仍running。17:07:22.005Z确认时保护明确拒绝状态变化，并提示当前无活动处理。之后第三次直接取消也发生竞态：17:10:47Z打开影响对话框时尚在进行，17:11:01Z确认时已完成为145,461点，因此仍不是取消成功。原生41帧暂停竞态、这些取消竞态以及仅显示“正在执行”的中间画面均不计为暂停／取消成功。

本轮已经停止额外UI尝试。后续两次UI接管未形成有效的新UIA或状态变化；原生跨项目live切换与运行中直接取消仍未取得通过。本节只确认上述暂停／继续、独立off与下一session的live发布，不把文件名、确认中间态或Done后的竞态拒绝当作成功取消。

## 控制补验停止后的最终保全

最终 `5386…` 应用的本轮窗口（PID48332，创建时间 `2026-10-30T16:47:01.6757074Z`）已由原生UI正常关闭。关闭前新抓取的 `uia-final874-controls-closeout-observed.json`（17:32:10.467Z）显示中型副本重建完成、145,461点、六个checkpoint的状态信息；当时仅作相机／稀疏点预览，没有编辑模型，该UIA不作为最终Gaussian像素显示证据。17:35:14Z独立原生CIM核查确认该PID不存在，本次创建时间范围内的专属 `webview-final874` WebView及指定包／控制副本路径引擎均无匹配残留。查询未终止任何进程；不据此声称全机所有进程或采样助手均退出。

`target/windows-native-final/controls-final-closeout-independent-validation.json` 记录以下最终只读核对：

- 原中型工程全部1,015个文件和目录集合仍与准备基准一致；原“最终 视频 中文 空格”工程全部224个文件和目录集合亦保持一致。两个原项目没有被副本控制验收改写。
- 照片工程已保存的 `8deb6759f7ea956b767f5de8fa8178270fe0243a7d30786f1fd748f612859cef` 模型保持不变。TUM原视频及相关原项目／控制副本的复制源均仍为 `3faa0fa6…3a854`。
- 中型控制副本当前为completed，无项目锁，live session已停止；最终scene为145,461点、8,146,318字节，SHA `b6507098cda25086337f755b26672755621b89990bd48d5aeca445f84c8629a1`，与checkpoint3000一致。全部六个checkpoint及scene完整、所有scalar有限；结果记录为从500几何warm start到3000，优化器未恢复。
- 多次显式恢复后，中型控制副本现有五个真实 `runtime/checkpoint-restores/` 归档，其中一个由精确副本继承，四个为本轮新增。所有既有归档文件哈希保持，五份归档scene及该树全部29份PLY完整有限；没有只检查外部复制件。短视频控制副本的既有真实归档也保持并通过完整读取。
- 原生KnownFolder中的正式应用 `com.metorigin.splat` 两份基准文件 `settings.json`、`recent-projects.json` 仍均为absent。候选专用配置与正式应用配置分开，不将其正常验收记录变更误称为正式配置变化。

该receipt digest为 `6aa66747669274fa5bf78d65b99170b20f04c8ddaafb5ac0f00b1dc5d28f846f`。独立核对只读取文件及精确范围的原生进程身份，没有启动GPU、GUI或引擎，没有修改项目、产品源码或包。本轮直接取消／跨项目原生交互的未验收状态随收尾保留，不再追加尝试。

## 普通启动预检修复（新 877 输入候选）

用户安装历史 `5386…` 候选后直接打开，在新建向导遇到泛化的“训练 GPU / 运行验证不可用”。只读核对确认该实例没有 `METORIGIN_BRUSH_BACKEND` 或 `METORIGIN_BRUSH_DEVICE_ID`，版本与能力命令成功，但旧代码在启动计算 probe 前要求外部 backend 配置。这是应用默认选择的缺陷，不能归因于用户显卡或素材；此前带覆盖变量的测试没有覆盖普通启动条件。

修复后，仅 Windows1 在 backend 覆盖不存在时选择 DX12；高级覆盖依旧可选，无效值返回独立配置错误。真实计算、规范设备身份、后续训练绑定和失败阻断仍保留。桌面端为预检失败保存有界本地诊断，并向用户区分配置、引擎响应及计算阶段失败。

2026-10-30 18:34:01Z 从独立工作区目录启动新的 NSS 应用载荷，SHA-256 为 `57e582c7658316fd8e9322f85242599f22e8d3fd40736e3f7abf52de6e90a989`，PID46264。它对应 877 项来源摘要 `af1adea96d6651c689c16ea7f2b85fe290f393be4be162038f8d786dd13bf158`。该 EXE 是 Tauri 打包期间复制的实际 NSS 字节；这是独立载荷运行，并未安装新版。159 个复制资源逐文件哈希和集合与冻结清单一致，其中包含安装辅助资源，区别于既有158个引擎／许可证文件的计数。

启动器只对自己创建的子进程移除 backend、device 和两个开发引擎提示，PATH 仅含系统目录，使用独立 WebView 数据目录，没有修改用户或机器环境变量。原生向导读取固定 TUM desk AVI 后，18:35:38Z–18:35:40Z 的版本、能力和真实计算 probe 全部退出0。返回 DX12、RTX5080 Laptop 的规范设备身份；8高斯、32×32 forward/backward 有限，gradient L1 为 `0.036350282141938806`。UI 的训练 GPU 项明确显示 Gaussian 渲染与反向传播检查通过／就绪，「继续」按钮可用；候选参数及动态预算未知的既有提示仍存在，不是阻断错误。

证据位于 `target/windows-startup-fix/native-default-launch-b0a9edf1/`：`launch-receipt.json`、`resource-verification.json`、`preflight-ui.json` 及三份 `probe-logs/`。没有确认创建项目，没有训练或编辑既有项目。关闭向导触发未保存选择确认时，选择继续编辑，随后正常点击测试窗口标题栏关闭；18:38:04Z 原生CIM确认该测试应用及指定路径后代无残留。用户原有D盘安装实例PID4976仍为原创建身份，安装EXE仍为 `5386…`，没有替换或关闭。`closeout.json` 保留这次边界。该结果只覆盖新应用的无后端配置预检；旧二进制的照片、视频、编辑和恢复结果仍按各自身份保留。

18:40:08Z 再按测试PID／EXE路径及专属WebView命令行核对，无匹配残留，见 `related-process-closeout-filtered.json`。之前宽泛命令行查询只匹配了检查命令自身，原记录保留；后续过滤显式排除observer。最终新stamp安装器为 `20261030T182838204Z-b0a9edf1`，SHA `daeb24969beb4cf4783296973a327bd3e18510d077278eefefc69de1e77443ab`，877来源和451工具构建前后不变，12产物校验和与NSIS长度／CRC通过。最终raw→NSS预期身份精确对应本节实际运行的 `57e582…`；新版实际安装仍与这次复制载荷的预检分别记录。

## 高质量实际参数与确认页（879输入修复候选）

Windows固定3000步／SH1／960px覆盖已移除。前端以预检响应的preset和effective_training显示实际执行；不同预设或正在检查的响应不能授权继续／创建。450个前端测试包括预设切换、错／缺preset响应、Mac受限参数并列请求值及确认页一致性。

第一份879候选 `86fb1737` 的实际复制NSS为 `80dbb96f1a5d77979230a26f55580906f9d80a5f0e23025fa03128407c893a1f`，来源摘要 `9e9747d248e833cc1e2df9ebc257561fc046ca973343207f640fe9e84fa16b3e`。独立目录159资源逐文件核验。原生TUM新建向导先显示快速实际3000步／SH0／1280px，切换高质量后选中卡、预检摘要及确认页均为实际30000步／SH2／2560px。两次真实DX12计算probe退出0，未点击任何创建按钮。证据为 `target/windows-preset-fix/native-quality-launch-86fb1737/`，独立复核为 `independent-native-ui-review.json`。

公开TUM的30000步生产核心运行在另一全新工程中完成，但其harness后置尺寸断言未考虑去畸变裁边，原测试退出101。独立产物复核确认82/82注册、训练及完成指纹30000／SH2／最大2560px、所有最终高斯有限；这与原生向导验证分别记录，不把后置断言失败改写为ignored test通过。详见[实施记录](windows-alignment.md)的预设质量参数修复及 `independent-quality-output-review.json`。

随后只修正该测试文件的尺寸断言和结果状态记录，三项非GPU回归通过，最终原生工作区742通过／0失败／22忽略。879清单中仅此测试文件变化，其余878输入保持，delta证据为 `harness-only-source-delta.json`。最终新stamp `5283428e` 来源摘要 `e8f7b57c8b428b5bc9eb148f0312098d75c215c07c354518617c880da6597e13`，实际复制NSS为 `320f8d50f701b06c944cd122fa59f30503d07aebbfd512e9c582271e722f7505`。新旧NSS仅24字节PE元数据不同仍保留精确身份；未从相同源码推定新应用通过。

最终 `320f…` 已另行在原生窗口实际重复高质量预检及确认页，两页均为实际30000步／SH2／2560px。启动无backend/device及开发引擎覆盖、仅系统PATH、独立WebView目录；159资源按最终879清单全量核验。未创建项目，PID12680正常标题栏关闭，20:07:35Z原生CIM确认该PID、专属路径及WebView命令行无残留。用户PID49052仍为原创建身份，安装EXE仍为 `57e582…`，原无人机scene仍为 `ce3f7fdfc3bf6e4dbca1e2d156d19ff02aed795b9e315254b2e40a6102f1f03b`。新证据为 `target/windows-preset-fix/native-quality-launch-5283428e/`，包括copy-resource、launch、quality-preflight、quality-confirmation、closeout与六份计算诊断日志。这仍是复制载荷原生向导验证，不是最终NSIS实际安装或原生完整重建验收；用户模型的漂浮伪影／编辑器取景未在本次修复。

最终安装器 `5283428e` SHA为 `9841982eb474f15e880d67e38e0dfbee4eefd5e4febb66175895c6009ea39dd7`，12产物、NSIS长度／CRC32 `1d1f00bd`、879来源及451工具前后核验通过，最终expectedNSS与实际新窗口的320f精确一致。独立UI复核为 `target/windows-preset-fix/independent-final-native-ui-review.json`，SHA `d06d7929a7af4fe73d73cd07a8351c6cb6e2168ec1d8fa23ae59ba4118b1c938`；仅按launch记录声明覆盖变量缺省，不虚构应用退出后的环境读取。原80db、两个stamp和首次harness失败证据均保留。

## 仍未覆盖的门禁

真实 Windows 内存压力和系统睡眠／唤醒未在本文列为通过。用户已明确选择将睡眠／唤醒保留为待验收、先收尾其余 Windows 项，无需再次询问；这不构成该项通过。原生 macOS回归仍独立待验，当前缺少原生执行条件。最终 `5386…` 的视频创建、显式恢复、强制退出、重开 reconcile和继续生成已有上述证据；早期照片六轮、受阻保存与三格式图像导出仍严格归于实际执行它们的 `7348…` 应用身份。
