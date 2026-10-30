# macOS 混合图片输入与失败输入验证

2026-10-27：生产扫描、归一化、独立像素审查，以及 CPU SfM 与去畸变的固定门槛已通过。`4e763b58` 原生包还完成混合正例的 3,000 步训练和最终自动渲染。独立 CLI 与生产适配器均注册 40/40，但点数、track 和误差存在需继续调查的差值，比较验收保持 `quality_delta_review_required`。两个负例后端正确拒绝，原生错误卡片却丢失具体建议；修复与新包复测另行记录。对应主计划 §10.2–§10.3。

## 数据来源与覆盖范围

原始数据为 James/Robson 火山弹摄影测量数据中的固定 40 张照片，来源 DOI 为 <https://doi.org/10.6084/m9.figshare.9120020.v1>，许可 CC0-1.0。来源、官方 Figshare 版本 API 许可证据与原件哈希见 [`james-sample-40.json`](../../packaging/macos-arm64/fixtures/james-sample-40.json)。40 个原件共 116,721,061 字节，保留原始文件。

正样本从每张原片各生成一个受控衍生图，共 40 个不同原始视角。四组各 10 张：人为 EXIF A（1536×1024，50 mm）、人为 EXIF B（1200×800，35 mm 等效字段 80）、无 EXIF 小尺寸（1152×768）、无 EXIF 大尺寸（1536×1024）。标签中的 make/model 明确包含 `MetOrigin TEST DERIVATIVE` 与 `Synthetic identity A/B`。带标签组覆盖 EXIF 方向 1–8，先逆变换像素再写方向，确保标准显示保持正向。

这些标签用于测试分组，**不是实际多相机、不同镜头或物理标定证据**。额外 `orientation-8` 重复同一个视角，专用于方向归一化审查，不计作八张独立 SfM 视图。低纹理数据是 24 张原图均色常量图；低重叠数据是同一原图 6×4 网格中的 24 个两两无源像素交集裁块。这两类是受控合成失败输入，不是现场拍摄的失败样本。

## 已完成的生产阶段验证

运行根目录为 `target/macos-m4/mixed-input-preparation-20261027/`。接受的运行目录为 `core-run-20261027T121316Z-46b7655c/`。外部 evidence harness 调用真实 `MediaValidationStage` 与图片 `FrameExtractionStage`，未配置任何引擎路径；这证明核心阶段行为，不代表完整 orchestrator 或原生 UI 流程。

| 输入 | 实测结果 |
| --- | --- |
| 混合正样本 40 张 | 40 张归一化，四个预期相机组，每组 10 张，逐图分组与尺寸相符 |
| 方向 oracle 8 张 | 八个 EXIF 方向全部按独立像素参考通过 |
| 仅损坏文件 | 2 个无效图片头、0 张有效图、1 个忽略文本；MediaValidation 返回 E-1102 |
| 2 张完整图 + 3 个损坏图 | 第三个 JPEG 头可读但熵数据截断；媒体头检查通过，归一化后不足 3 张，返回 E-1103 `Image Preparation Produced Too Few Frames`；消息包含三个失败文件，未发布 frames.json，frames.preparing 已清理 |
| 3 张完整图 + 3 个损坏图 | 3 张成功归一化，三个损坏输入均进入 skipped_items |
| 低纹理 24 张 | 24 张归一化；零空间像素方差。后续 COLMAP 读取全部 24 张、正常退出，SIFT 总数 0；生产特征阶段返回 E-3010 |
| 低重叠 24 张 | 24 张归一化；裁块源像素两两交集为 0。后续提取 40,498 个 SIFT 特征，匹配进程正常退出但没有有效匹配；生产匹配阶段返回 E-3020 |
| 空目录、仅不支持文件 | 0 张有效图；MediaValidation 返回 E-1102 |
| 普通文件当目录、不存在路径 | 扫描器返回 E-1103 |

合计 11 类输入、99 张归一化图片。独立 Pillow 解码、`ImageOps.exif_transpose` 与无损 PNG 参考覆盖其中 **96 张**：40 张正样本、8 张方向 oracle、24 张低纹理和 24 张低重叠。`corrupt-plus-3` 的三张有效副本仅验证归一化/跳过记录，未另算像素 oracle，因此 99 与 96 不是统计冲突。

产品会重新编码 q92 JPEG，故使用预先固定的像素误差界限，未要求 JPEG 字节相等，也未放宽门槛：

| 指标 | 固定门槛 | 最差实测 |
| --- | --- | --- |
| 平均绝对通道误差 MAE | ≤6 | 1.0624853515625 |
| P99 绝对通道误差 | ≤28 | 6.0 |
| PSNR | ≥28 dB | 44.67825872707762 dB |

独立复核确认 40 个原件、135 个夹具文件与 114 个导入项目的源文件哈希保持一致。该次轻量运行未生成 COLMAP 数据库或 Gaussian PLY；后续重建阶段另行记录如下。

## 证据绑定与历史更正

| 证据 | SHA-256 |
| --- | --- |
| `fixture-manifest-v2.json` | `56667ee77328529aff8d6a3e87c8007681b41f83770da82d4173c2f5bf70bcbf` |
| `core-validation-summary.json` | `f80c173b952b57174d48d7fd6dda2d4977d0fbd53fe7315a47fb6fbbefc7feb4` |
| 接受运行 `execution-receipt.json` | `82c6fb5bd774d0d4354b358f0114a4b771f16ea70c9fbb5187b5e58404964695` |
| 接受运行 `core-output/core-results.json` | `598ec51c0a13c6fe6f1027a82871a2e735d3ceaa9d20e729e21d71cc9f2c6bc0` |
| 接受运行 `pixel-audit.json` | `656a1ce17e99a6c35854708b41342461fbe828f0e2b631c229cec56981478d99` |
| 该运行绑定的根 `Cargo.lock` | `1654226fb7ba31cc2a06bc75403685ed2e75ae61685a0cdbb12d533d81771bf1` |

首次运行 `core-run-20261027T121041Z-faf7d6ef/` 的核心/像素检查通过，但独立解析的部分传递依赖版本偏离根 lock。该运行仍保留，接受证据改用第二个全新运行：先复制根 `Cargo.lock`，再逐项核对依赖 name/version/source/checksum，差异为零，仅新增 evidence harness 包。

最早 `preparation-receipt.json` 在 shell 未找到 rustfmt 时误写通过；该收据未覆盖或删除。`preparation-receipt-correction.json`（SHA-256 `149ad1887260d38404192fce94a0a396b6b84c315e9efff7aa06f1826afca326`）明确更正，并记录随后用仓库工具链实际运行 rustfmt，退出码为 0。

另一处准备阶段说明也需更正：冻结 README/evaluation-plan 将 24 张负样本解释为避免低于 20 张造成的纯数量失败，但生产代码实际使用 `minimum_registered = total_images.min(20)`，另加 ≥50% 注册率。12 张输入若全部注册，并不因少于 20 张而自动失败。24 张仍覆盖完整的 20 张推荐阈值分支；此前没有执行 SfM，因此不存在受该说明影响的重建结论。旧文件作为历史保留，以本更正为准。

## CPU 重建、去畸变与独立 CLI 对比

同一 target 目录新增 `sfm-harness/`、`run-sfm-validation.py`、`cli_baseline.py`、`sfm_audit.py`、`sfm-preparation-bindings.json` 与 `SFM-PREPARATION.md`。主任务完成原生异常恢复验证并释放重任务槽后，授权串行执行 CPU SfM 与去畸变。harness 已用本地离线工具链编译，`CARGO_BUILD_JOBS=2`；依赖 name/version/source/checksum 与冻结根 lock 的差异为零。任何超时、中断或清理异常均停止整轮后续阶段；13 项正常/故障注入检查覆盖此边界。运行期间没有启动 FFmpeg、Brush 或原生 App。

准备脚本绑定当前 `MetOrigin Splat.app`：应用二进制 SHA-256 `4e763b5864705fd0c91fa5a63a547cb4119552e4a6c9a6113f017ba40a17ef3d`，bundle inventory `243fae560b63c8bef480477f4f434b1707ccfcfd49ed4b5826cc7ff34c57f587`，引擎 manifest `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`。COLMAP 来自包内 `Contents/Resources/resources/engines/colmap/bin/colmap`，SHA-256 `bfd28a4abfc6aad219fbe73e0cc065277604cfa5bdfe68d762c14164478c5443`。每次运行核对完整包清单、冻结生产源码、根 Cargo.lock 与输入哈希，并使用全新输出目录。

CLI 基线按 manifest 分组分别调用 `image_list_path + single_camera=1`，独立建立相机/rig 分区。生产流程继续使用每图提取后的数据库合并，不复用产品相机合并实现。实测双方 40 个文件名形成双射，四个相机组、初始参数、逐图 keypoints/descriptors 字节完全相同，各有 257,871 个特征；完整核对 images、frames、frame_data、rigs、相机与特征表引用。

首轮实测发现，六线程提取按完成顺序分配 image ID，排序输入不能保证数字 ID 相等。经独立审查和主任务批准，改用文件名双射的语义核对，并保留完整 image/frame/camera/rig 数字 ID 映射，未重编号数据库。ID 差异可能影响遍历顺序与随机过程，因此不声明输出确定性，也不将后续差值自动归因于 ID。CPU、六线程、8192 SIFT 参数、SIMPLE_RADIAL、exhaustive block 50、默认随机种子和回退顺序保持等价，固定质量门槛不变。

正样本的预声明门槛仍为 **≥36/40 注册、≥1000 点、平均 track ≥2.5、0 < 平均重投影误差 ≤3 px、最大匹配连通分量覆盖 ≥0.8**。适配器不得降低合格 CLI 的注册数。实际正样本运行是 `sfm-run-20261027T125209Z-ebd5e4e6/`，于 12:54:49 UTC 完成，18 个子命令全部正常退出且未超时：

| 指标 | 独立 CLI | 生产适配器 |
| --- | --- | --- |
| 注册图片 | 40/40 | 40/40 |
| 稀疏点 | 21,718 | 20,530 |
| 观测数 | 108,654 | 98,956 |
| 平均 track | 5.002947 | 4.820068 |
| 平均重投影误差 | 0.241372 px | 0.277029 px |
| 最大匹配连通分量覆盖 | 1.0 | 1.0 |
| 有效匹配边 / 内点总数 | 261 / 174,059 | 263 / 174,086 |
| 选择策略 | 首次 exhaustive/global | 首次 exhaustive/global |

双方均通过固定门槛，适配器注册数未下降。适配器相对 CLI 的差值为点数 −1,188（约 −5.47%）、平均 track −0.182879、误差 +0.035657 px。脚本按预声明保留 `quality_delta_review_required`，因此外层退出码为 1，含义是比较仍待审查，**没有阶段执行失败或超时**。单次结果不足以确定差值原因；未增加容差或豁免，补充共同 pre-match 数据库控制实验尚待单独执行。

固定门槛通过后，独立 CLI 与生产 `TrainingPreparationStage` 均完成去畸变。按各自 `result.json`/选择记录审查模型，两个输出均保留 40 个注册文件名，所有数值有限且 track 引用一致，逐张图片尺寸匹配自身相机，最大边不超过 1280。生产准备指纹与源模型、源图、COLMAP 执行配置及输出均相符。生产四个输出相机尺寸为 1280×851、1208×801、1280×849、1156×768；CLI 尺寸分别为 1280×850、1205×800、1280×850、1157×768。两侧独立求解的内参不同，未假设统一尺寸或要求 JPEG 字节相等；生产额外执行 q92 JPEG 编码。

负样本在首轮 `sfm-run-20261027T124254Z-49e6bab2/` 实际完成：低纹理返回 E-3010 `Feature Extraction Failed`，消息说明没有提取到特征，并建议检查纹理、格式和日志；低重叠返回 E-3020 `Feature Matching Failed`，消息明确重叠或纹理不足，附有重拍重叠与纹理建议。独立审查确认两者 COLMAP 进程都正常退出，属于数据拒绝，不是崩溃或超时。没有质量 override、去畸变、训练结果或完成 PLY；原生错误呈现仍另行验证。所有执行配置均将 Brush probe 设为 unknown，并禁用 live/resume，未开展新 Metal 探测。

首轮正样本在 CLI 特征提取完成后遇到系统 Python SQLite 对无 sidecar 的 WAL 模式数据库执行只读审查失败，未开始该正样本的匹配。失败运行、主库、WAL/SHM 诊断、v1–v3 脚本与绑定均保留。诊断曾通过读写连接读取计数并产生空 WAL/SHM，主数据库未变化；该操作明确记录为诊断，未用于验收。修订后的验收审查先复制完整 main/WAL/SHM/journal，保留原始副本，再仅在独立工作副本恢复读取；原库从不通过 SQLite 打开，前后哈希均核对，不使用 `immutable=1` 绕过未审查 WAL。

最终绑定为 revision 4，SHA-256 `58e8fbceec4f0dea7457c922c154e9ea981ef327bb87ee4bcfd4b9a6a23435f4`；冻结根 lock 仍为 `1654226fb7ba31cc2a06bc75403685ed2e75ae61685a0cdbb12d533d81771bf1`。运行结束后复核全部原件、夹具、接受项目源文件、新项目源图和归一化图、生产源码及完整包清单不变。进程扫描未发现遗留的 App、COLMAP、Brush 或 harness，重任务槽已交还主任务。

该次 CPU 运行结束时，补充共同输入控制及原生验证尚未执行；后续结果分别记录如下。CLI／适配器比较结论、真实多相机拍摄及现场失败样本保持开放。


## 2026-10-27：相同匹配前数据库的补充 CLI 对照

原生正例和两个负例结束、应用正常退出且主任务释放重任务槽后，执行独立复核过的补充 runner v2。运行目录为 `target/macos-m4/mixed-input-preparation-20261027/sfm-common-input-control-20261027/run-20261027T132803Z-a117f7b3/`；13:28:43 UTC 完成，三个 COLMAP 子命令（匹配、首次 global mapper、model analyzer）全部退出 0，无超时。该补充不调用特征提取、构建、去畸变、Brush 或原生 UI。

输入来自原生产特征阶段、匹配前保留的 `sqlite-audit-snapshots/9826e8436e3e48fbab332c2e343a6bec/source/`。主库 SHA-256 为 `b76bb329dd0b738a9a0b1b9e59fe983751d0dc88d2a58273131ba7f503920de5`，WAL 长度为 0。先保留完整 main/WAL/SHM，再仅在新的工作副本重建临时 SHM；没有重编号或调用产品相机合并实现。执行前核对 matches 与 two_view_geometries 均为空，40 张图、40 个 frame、4 个相机和 4 个 rig；全部 image/frame/camera/rig ID、相机参数与特征字节逐项等于原生产匹配前审查，40 张 processed 图片也逐文件相同。

| 指标 | 原独立导入 CLI（主基线） | 原生产适配器 | 相同输入补充 CLI |
| --- | --- | --- | --- |
| 注册图片 | 40/40 | 40/40 | 40/40 |
| 稀疏点 | 21,718 | 20,530 | 22,972 |
| 观测数 | 108,654 | 98,956 | 114,309 |
| 平均 track | 5.002947 | 4.820068 | 4.976014 |
| 平均重投影误差 | 0.241372 px | 0.277029 px | 0.239715 px |
| 有效匹配边 / 内点总数 | 261 / 174,059 | 263 / 174,086 | 262 / 174,080 |
| 选择策略 | 首次 exhaustive/global | 首次 exhaustive/global | 首次 exhaustive/global |

补充结果通过原有全部固定门槛，三个结果的注册文件名集合一致。补充 CLI 相对原生产结果为点数 +2,442、平均 track +0.155946、误差 −0.037314 px；相对主 CLI 基线为点数 +1,254、track −0.026933、误差 −0.001657 px。与原生产图共有 261 条有效边，其中 174 条的内点数完全相同。因此，即使固定初始数字 ID 和特征数据库，本次仍未复现原生产结果；不能将主基线中的质量差值仅归因于独立提取时分配了不同 ID。

该补充只是一轮 CLI 控制，未重新运行生产适配器，也未估计重复运行分布。图比较在本轮 runner 中限于文件名对与内点计数，不表示全部几何矩阵、内点索引或模型 pose 等价。原独立导入 CLI 始终是主基线，原生产结果的 `quality_delta_review_required` **继续保留**；没有事后容差或验收豁免。

关于种子需明确区分：历史 CLI 收据中的“默认 seed 0”对应 COLMAP 的 `default_random_seed=0`，不代表显式设置了 `TwoViewGeometry.random_seed=0` 或 `GlobalMapper.random_seed=0`。冻结 COLMAP 4.1.0 源码中这两个阶段选项默认为 −1，三条路径都没有覆盖它们；实际 mapper 的 `project.ini` 也记录 `GlobalMapper.random_seed=-1`。几何验证 worker 使用线程本地 PRNG 并从工作队列取图像对，默认种子与六线程本身不保证每对图像使用同一随机序列。该机制需要进一步受控诊断，不能由本次差值直接证明其贡献比例，也不能据此排除尚未核对的实现差异。

补充 v2 绑定 SHA-256 为 `1cc7798c60ce387d327870385a71c36506f8394d8cafb8f0417e94ae60bed2c2`；完成 summary 为 `12e5e350bf7b21b9fcf149bdba5f07f383871b972cd2086ce0ae7b2314d173e8`。原 v1 导入路径阻塞版本及独立复核均保留，v2 修复后仅做导入预检并重新独立复核才获准执行。13:34:56 UTC 归还重任务槽前，145 个绑定文件再次核对一致，完整应用包清单在 runner 完成时通过；进程检查 `remaining_known=[]`，无相关 App、COLMAP、Brush、FFmpeg 或 harness 残留。归还收据 `completion-and-slot-release.json` SHA-256 为 `1594614a686dddf263d715cb035f207a534a68052b134320b589267b4152e9c9`。随后获准的诊断文字修复及重打包属于后续候选，不能回写为这轮冻结对照的输入。


后续只读审查进一步确认：原生产与相同输入 CLI 的 780 条 `matches` 原始记录（包括匹配索引 blob）完全一致，但 `two_view_geometries` 有 259 / 780 条记录不同；三个 mapper 实际 `project.ini` 中除路径外的 51 项参数完全相同。因此差异已出现在几何验证阶段，不能把最终模型差异仅归于 mapper。线程队列与 PRNG 是待控制因素，尚未证明全部差值的因果归属。独立复核 `independent-result-review.json` SHA-256 为 `5471988b383e9941c1f9c3f2c8c5f0e1e2595e58ea60354ee31f0613cf073e18`；诊断与两对四次默认配置重复方案另存于本次 run 目录，重复实验尚未执行。

## 2026-10-27：4e76 原生混合图片完整生成

原生运行证据位于 `target/macos-m4/native-mixed-input-20261027/`。应用通过实际图片选择、预检与创建向导新建 `M4 混合输入 40`，使用快速预设 3,000 步／SH0，全部 12 阶段各执行一次，无缓存跳过或重试。原生选择器从所选图片的父目录导入，因此本次使用保留全部原始字节的 40 张平铺副本；它验证混合尺寸、EXIF 与分组，**不验证仅含四个子目录的根目录选择支持**。

四个实际数据库相机组各含 10 张图片，归一化的 40 个文件与此前核心参考逐名逐字节相同。40/40 注册，21,203 个稀疏点、103,204 次观测、平均 track 4.867424、重投影误差 0.242959 px。去畸变后四组尺寸分别为 1280×851、1205×800、1280×850、1157×768，模型引用、双向轨迹和图片尺寸一致；此项没有另外执行 native 模型的独立 CLI 逐像素去畸变对照。

原生捕获了 716 和 2,189 步实时预览，完成后自动显示 121,334 个高斯，最终 PLY 为 6,795,204 字节，SHA-256 `e147d8ca2ae7061152e33f5abd39d5b21774d50b47c1ba6ef90d8831aa426061`。六个检查点及 scene 所有标量有限，最终检查点、导出、manifest 与训练指纹一致；原始照片、夹具、导入源文件都保留。`sparse-pending.*` 文件名沿用捕获意图，但实际画面已进入 TrainingPreparation，不作为 sparse 发布前占位证据。

独立审计 `independent-audit/audit-result-attempt03.json` 通过 9,407 项检查并绑定 945 个文件，SHA-256 `034f770e1611ff2304b41ca77b66360727d722f668b21b31f0061a6e97c0d9ee`。正常退出后收尾审计 `independent-audit/closeout-receipt.json` 通过 17,045 项检查，SHA-256 `05e76cd2f476998416b2b6a094c3a8693bb13c374a1d4788b379217b5a2b06a3`。155 个资源样本均为 normal；资源边界见[资源记录](macos-m3-resources.md)，原生呈现见[桌面记录](macos-native-ui.md)。只绑定 4e76、本机 32 GiB 和进程级禁网范围，不代表全系统离线、Finder 启动或完整 M4 通过。

## 2026-10-27：原生失败素材与待修复诊断

随后在相同包中通过向导分别新建 `M4 低纹理 24` 与 `M4 低重叠 24`。前者读取 24 张图但特征总数为 0，在特征阶段返回 E-3010；后者提取 40,498 个特征但有效匹配为 0，在匹配阶段返回 E-3020。两个 COLMAP 进程正常退出；生产校验拒绝继续，训练等下游阶段仍 pending，没有 scene.ply，源文件和归一化结果完整保留。

两张实际失败页面均只显示通用“处理引擎执行失败，请检查引擎状态并查看日志”，没有纹理、重叠或补拍建议。原因是英文 AppError 文案经 `localized_for_ui` 变成按类别统一的中文信息，随后 StageState 仅保存 Display 字符串，独立 suggestions 不进入卡片。**后端拒绝通过，原生诊断验收未通过**；不能沿用核心 harness 的英文建议声称 UI 已可操作。

证据 `native-negative-summary.json` SHA-256 为 `7f05fd567e202eb172b129e6ff942a910fb2ccb5671bc3889547262264f998e5`，原生操作和视觉观察收据 `native-ui-observation.json` 为 `1ebb095141840eede6995b802b7af77bf5503b54f4951f50573f25639e5682fa`。应用于 13:27:02 UTC 正常退出 0，`remaining_known=[]`。已授权的后续修复限于 COLMAP 校验分支的具体诊断和回归测试，保留错误码、算法、阈值及现有持久化格式；修复后需新包原生复测，旧失败证据保持不变。

## 2026-10-27：d91c 新包失败诊断复测通过

诊断修复仅改 `splat-engine-colmap` 的 `feature.rs` 与 `matching.rs`：在实际 SQLite 统计分支提供中文标题、数量及恢复步骤，并将可操作建议写入 `user_message`，使现有 `localized_for_ui` → Display → StageState.error 路径保留完整信息。部分图片提取失败继续显示实际数量及最多八个缺失文件名；未改变错误码、类别、retryable、数据库判定、成功逻辑、算法参数或质量门槛。新增八项真实 SQLite 回归覆盖无图片特征、零特征、部分处理及文件名上限、无匹配和成功返回；COLMAP crate 146 项测试及 domain 错误测试 7 项通过，根 Cargo.lock 未变化。针对性收据位于 `target/macos-m4/native-mixed-input-20261027/diagnostic-fix-validation-20261027/targeted-test-receipt.json`，SHA-256 `b5d4e0dbdad0d2724a42e5af824c373df272db35a394af7252f0e078e7bf273c`。

新包主程序 SHA-256 为 `d91c49edcf382212a4c29e11b85fdd21bf9b721959d109dcb6852946ba55758b`，包清单为 `34c16db42c8b7376d5c71a9683d82f2a3284460a401f70a318a1166ddc5912b4`；COLMAP 仍为 `bfd28a4abfc6aad219fbe73e0cc065277604cfa5bdfe68d762c14164478c5443`。新原生证据集中在 `target/macos-m4/native-diagnostics-fixed-20261027/`，独立绑定新包与新启动收据后，实际向导创建两个新项目，未重用或编辑旧通用错误项目。

| 新项目 | 真实引擎与数据库结果 | 原生错误卡与恢复指导 |
| --- | --- | --- |
| M4 诊断修复 低纹理 24 | 24 张均读取；数据库 24 张、0 特征；引擎退出 0；特征阶段 E-3010 | 完整显示 24/24/0，以及检查可读取性、清晰度、足够纹理，必要时补拍后重新提取 |
| M4 诊断修复 低重叠 24 | 24 张、40,498 特征、0 有效匹配；提取和匹配引擎退出 0；匹配阶段 E-3020 | 完整显示 24/40498/0，以及增加相邻照片重叠、保留纹理并补拍清晰照片后重试 |

两个案例的实际持久化错误均逐字匹配修复后的分支文案，并完整出现在 AX 的错误与恢复区。主任务原生观察及独立截图复核均确认文字无裁切；没有把侧栏项目名称或旧核心错误建议当作指导证据。所有下游阶段保持 pending、没有开始事件或训练/导出产物；24 张源文件、归一化结果、项目文件及新应用在各自只读审计前后保持哈希一致。SQLite 仍仅在完整私有副本中恢复读取。

两案例聚合 `native-negative-summary.json` 状态为 `both_fresh_native_negative_diagnostics_passed`，SHA-256 `e8d83848eb247a07e060470276da2f65053fbe69bdfbaa403c1e32a4da571684`；独立视觉收据为 `independent-visual-texture.json`（`ff927b6f35fb7af1ab17c00f8ca0532c43ea34f4c494eb0c86f0183e89f309f0`）及 `independent-visual-overlap.json`（`59f3799ba620f115e6b3d121828286d746b7e2ddf32f42beddb39a607caa5321`）。该结果关闭新包上这两个受控失败案例的诊断缺口；它们仍是人工构造的负样本，不代表现场失败数据验收，也不豁免原独立 CLI／适配器的质量差异。

新应用于 14:10:40 UTC 正常退出 0，启动助手记录 `remaining_known=[]`。退出后独立收尾核验确认两负例各 83 / 85 个项目文件与各自验收审计完全一致。此前 4e76 正例的原件及仅用于查看的副本各 220 个文件，也与 `positive-view-copy.json` 的原始逐文件哈希零差异；新应用、包清单、修复源码及全部审计绑定仍一致。收尾证据 `post-exit-closeout.json` SHA-256 为 `471e98116c63bdc1726e6612070c8c52a6ea36e987a7682bd182cc3737ba095e`，并核对主任务 `root-native-observation.json`（`ca820b9e76d07492d985f40fe0f551adda91cada97f9ffa2df818bbb908356d7`）及其 14 项 AX／截图证据。

正例副本在 d91c 的 Spark 中显示清晰岩石及支撑面、121,334 个高斯；进入 SuperSplat 后数据已载入，但初始视图及 Reset Camera 仅见网格。选择 `scene.ply` 并执行 Frame Selected 后模型可见，再返回 Spark 成功。此次没有编辑保存或重新生成，不能计为新包正例生成验收；SuperSplat 初始自动取景问题仍开放，手动框显后可渲染不等于自动取景通过。初次将 `project.json` 选为目录被拒，随后选择 `.splat-project` 目录才成功打开的过程也保留在主任务观察收据中。

## 2026-10-27：默认参数的两对四次固定输入复跑

本轮在 d91c 原生诊断验证正常退出并释放重任务槽后，按预先固定顺序运行 **pair1 CLI → pair1 adapter → pair2 adapter → pair2 CLI**。目录为 `target/macos-m4/default-paired-repeat-preparation-20261027/run-20261027T141705Z-90a579f4/`；14:17:05 UTC 开始，14:21:00 UTC 完成，执行器退出 0，状态为 `completed_diagnostic_review_required`。构建使用离线依赖、两个 Cargo jobs，耗时 36.779 秒，依赖与冻结根 lock 无差异；随后所有计划子命令退出 0，无超时、重试或替换案例。没有提取新特征、去畸变、启动原生 UI 或训练。

每例从接受的 core 项目、同一个匹配前数据库及相同 processed 图像建立全新副本。匹配前逐项核对 image/frame/camera/rig ID、相机参数和特征字节，matches 与 two_view_geometries 均为空。CLI 独立构造命令，adapter 调用真实生产 `ColmapMatchingStage`／`ColmapMappingStage` 的输入校验、执行及输出校验，不走阶段缓存。两条路径均为 CPU 六线程、exhaustive block 50、guided=0、global mapper 禁用 GPU；没有显式覆盖阶段随机种子。每次匹配完成后、建图之前保留完整数据库副本及全部表字段／blob 哈希。

以下括号是相对**原独立导入 CLI 主基线**的有符号差值；主基线仍为 40 张、21,718 点、108,654 观测、平均 track 5.002947、误差 0.241372 px。全部新结果都选择首次 exhaustive/global，最大连通分量覆盖为 1.0，注册数及文件名集合保持 40/40。

| 固定案例 | 注册数（Δ） | 点数（Δ） | 观测数（Δ） | 平均 track（Δ） | 误差 px（Δ） |
| --- | --- | --- | --- | --- | --- |
| pair1-cli | 40 (+0) | 22,449 (+731) | 112,487 (+3,833) | 5.010780 (+0.007833) | 0.237680 (-0.003692) |
| pair1-adapter | 40 (+0) | 22,738 (+1,020) | 113,327 (+4,673) | 4.984036 (-0.018911) | 0.240380 (-0.000992) |
| pair2-adapter | 40 (+0) | 22,493 (+775) | 109,056 (+402) | 4.848442 (-0.154505) | 0.244350 (+0.002978) |
| pair2-cli | 40 (+0) | 20,975 (-743) | 97,508 (-11,146) | 4.648772 (-0.354175) | 0.234852 (-0.006520) |

四例均通过既有固定门槛和“不低于主 CLI 注册数”的检查；这些检查没有把点数、track 和误差压成单一质量分数。尤其两次 adapter 的平均 track 都低于原 CLI，pair2 adapter 的误差也高于原 CLI；pair2 CLI 本身的点数与 track 亦低于原 CLI。不得挑选较好一轮覆盖原比较。原 adapter 的 20,530 点、4.820068 track、0.277029 px 和相对主 CLI 的不利差值继续保留，`quality_delta_review_required` **仍开放**。

六组完整比较如下。差值方向统一为**左列案例减右列案例**；注册数差值六组均为 0。每组 `matches` 的 780 条完整记录和 blob 全部相同，几何差异指 `two_view_geometries` 的完整行／字段对照，不只是内点计数。

| 左案例 − 右案例 | 关系 | Δ点数 | Δ观测数 | Δtrack | Δ误差 px | 几何相同行 / 不同行 |
| --- | --- | --- | --- | --- | --- | --- |
| pair1-cli − pair1-adapter | 同对 | -289 | -840 | +0.026744 | -0.002700 | 523 / 257 |
| pair1-cli − pair2-adapter | 跨对 | -44 | +3,431 | +0.162338 | -0.006670 | 523 / 257 |
| pair1-cli − pair2-cli | 同路径复跑 | +1,474 | +14,979 | +0.362008 | +0.002828 | 521 / 259 |
| pair1-adapter − pair2-adapter | 同路径复跑 | +245 | +4,271 | +0.135594 | -0.003970 | 522 / 258 |
| pair1-adapter − pair2-cli | 跨对 | +1,763 | +15,819 | +0.335264 | +0.005528 | 522 / 258 |
| pair2-adapter − pair2-cli | 同对 | +1,518 | +11,548 | +0.199670 | +0.009498 | 526 / 254 |

CLI 自身两次的几何表有 259 行不同，adapter 自身有 258 行不同；同对比较分别有 257、254 行不同。因此本轮明确观察到同路径的匹配几何也会变化，建图输入在优化之前已经不同。结合已核对的线程队列与 PRNG 源码，这为继续分离几何验证与 mapper 提供依据；不能证明随机调度是全部差值的唯一原因，也不能据此证明两条路径质量等价或不退化。两次／路径仅作描述，不估计统计显著性、不设置事后容差。

八个主要 matcher／mapper 子进程均捕获到实际 argv；只规范化 database_path、image_path、output_path 后，同子命令的其余参数与顺序全部相同。四个实际 mapper `project.ini` 的 51 个非路径字段相同，包括 `default_random_seed=0`、`GlobalMapper.random_seed=-1`、`GlobalMapper.num_threads=6`。另有三次附带子进程观察抛出未含 traceback 的 `AssertionError()`：pair1 adapter mapping PID 307、pair2 adapter matching PID 666、pair2 adapter mapping PID 786。八个主要命令捕获不受这些记录影响，但没有证据确认三条错误的具体原因，也不声称所有短暂 model analyzer 进程都被观察或观察器零错误。

独立复核重新读取八份历史数据库的私有工作副本、比较六组完整匹配表，并独立解析四个稀疏模型，核对指标、文件名、有限值和双向轨迹引用。审计初版额外加入“同一 track 每图最多一次”断言；实际每个模型的 point tracks 中有 276–304 条来自重复 image_id 的额外观测（point2D 索引不同），这些数值不是受影响 track 的数量。修订审计分别报告 `(image_id, point2D_index)` 元组唯一、互反引用一致和重复图像观测数量，保留初次检查及修订记录，不修改模型。固定上游 commit `fa8e3b3ff591552855f8ad2806723c80f963f69c` 的 `global_mapper.h:63–64` 明确设置同 track 同图观测的像素距离上限（默认 10），`global_mapper.cc:197–216` 在距离检查后仍逐个加入同图不同 feature 的观测；`Reconstruction::IsValid` 检查引用而不要求 image_id 唯一。因此“每图最多一次”并非该实现的格式／结构契约。但本次源码核对没有对最终模型逐一复算这些重复观测的距离或几何一致性，引用结构通过不等于几何质量合格，后者仍待审查；没有扩大原质量验收结论。

本轮绑定 d91c 主程序 `d91c49edcf382212a4c29e11b85fdd21bf9b721959d109dcb6852946ba55758b`、包清单 `34c16db42c8b7376d5c71a9683d82f2a3284460a401f70a318a1166ddc5912b4`，COLMAP 仍为 `bfd28a4abfc6aad219fbe73e0cc065277604cfa5bdfe68d762c14164478c5443`。冻结绑定包含 1,623 个文件及三棵受保护输入树，执行结束检查和独立审计均一致。14:21:02 UTC 进程检查 `remaining_known=[]`、`root_process_review_required=false`，主任务已接回重任务及源码槽；之后 SuperSplat bridge／测试的修改属于后续工作。旧收据中的发布 bundle 路径是当时位置，后续打包会替换该路径；历史输入按哈希及新增归档映射追溯，不能把后来同路径内容回填到旧收据。

d91c 完整 bundle 后续归档到 `target/macos-m4/release-package-editor-framing-20261027/previous-candidate/MetOrigin Splat.app`。新增 `historical-bundle-archive-mapping.json` 将本轮旧 app／COLMAP 路径映射到该副本，独立复算 4,751 个内容、模式及内部 symlink 清单条目，以及应用与 COLMAP 二进制哈希，均与本轮冻结值相同。归档方收据 `previous-candidate.json` SHA-256 为 `76d4779751836320c9711cdc2dc7294fee038fc887b99b9abd0e0011ed75bf1a`。原 DMG、绑定、运行记录及原生验收保持历史状态，不转移为后续新包验收。

关键证据均在本轮目录中：

| 文件 | SHA-256 |
| --- | --- |
| summary.json | `a5e4bd97c44934423dc6e050837c396e4b64da9e65779a8e4663998663ec8ac4` |
| frozen-bindings.json | `c0dc23c5bf31d5fbb3c045822ba28387e2a065b4de79208894a403dd8da731e0` |
| independent-result-review.json | `4fb72c4d5805dc5963b965b2921c50e7d97e56a92c076406cd80a923572f1df1` |
| executor-result-interpretation.json | `47070b4bd1b431589ab81f0265bf46480a60fab2b2f4e93bf97d7981dfea4b88` |
| completion-and-slot-release.json | `f682209b39b9e517002ebab23614e49f83a6f48a9a1ed1347f2e0e75d64f47a4` |
| historical-bundle-archive-mapping.json | `9aeb113fca237de0d23518425ebd115499c1d939fc45e67f6be3e4df6e379f4e` |
| track-contract-source-review.json | `3ff0f4480ae0f1796aee648bcac3e873b3b80af68cd1ad20db183e1f12b3bdbb` |

有区分力的下一步准备稿位于 `target/macos-m4/mapper-only-common-postmatching-plan-20261027/plan.json`（`80bb18d9b0caac0325ffaf4ea8a732c74b5068fcd833b1c7d8fd7b7e2cba2c38`），**尚未编译或执行**。它按固定顺序取本轮第一个 postmatching 快照（主库 `31ab00095cdef5a76cc844ea7b8dbe34774f34e12f2afd77537fca84b8e20bcc`），为四次 mapper-only 调用复制完全相同几何输入，使用独立 CLI 对照生产 mapper builder／ProcessRunner，最多四次后停止。完整 MappingStage 可触发补匹配，因此该诊断明确限定为 mapper builder／runner，不冒充完整阶段验收。新方案需要独立准备审查和单独重任务授权；没有更改原计划 §10.3 的“不降低独立 CPU CLI 基线质量”要求。

## 2026-10-27：固定匹配后数据库的 mapper-only 对照

上述准备稿随后落实为 `target/macos-m4/mapper-only-common-postmatching-preparation-20261027/`。28 项准备检查、13 项独立纯进程内检查及 rustfmt 检查通过后，冻结 3,680 个文件、两棵受保护输入树及归档包的 4,751 个内容／权限／symlink 清单条目；实际链接的三个 crate 及根 Cargo 文件共 38 个，仍与此前冻结源码一致。准备期间没有编译或启动引擎。独立预审 SHA-256 为 `5beea1fc8f4b0de7f35f84a72f2d6e32a58b78a3bae8f2b87270be123cb3da35`，绑定 SHA-256 为 `c645d6b9ac20df0d57f02ca6f079d2e5780ea8817a707ab3195252e9ac0d7074`。

9e25 原生应用于 15:02:59 UTC 正常退出且无已知子进程残留后，主任务另行释放唯一重任务槽。执行授权保存在 `root-slot-release-20261027T1503.json`（`87866491acdc9208c82b47dfe28966026c26407709124acb1e1d29dc822dc66d`）。新 runner 再次通过实时进程检查后，于 15:06:14 UTC 建立唯一运行 `run-20261027T150614Z-1905202e/`，按 **CLI → adapter → adapter → CLI** 固定顺序执行，无重试或替换案例。一次离线 harness 构建退出 0，耗时 28.672 秒；四次 global mapper 分别耗时 29.837、27.497、26.946、26.751 秒，均退出 0，无超时。全轮于 15:08:56 UTC 完成，执行器退出 0，状态为 `completed_diagnostic_review_required`。

本轮 adapter 仅调用真实生产 `ColmapMapper` 命令构造器和 `ProcessRunner`，每例恰好一次 `global_mapper`。CLI 独立构造命令。没有调用 `ColmapAdapter` 探测、完整 `ColmapMappingStage`、匹配、特征提取、model analyzer 子进程、去畸变、训练或原生 UI；模型通过纯二进制解析审计。因此该结果仅覆盖 mapper 命令／运行器对照，不能当作完整阶段、独立导入或原生新包验收。

共同输入按既定顺序选取上一轮第一个 postmatching 快照，而非按质量分数挑选。四例均从主库 `31ab00095cdef5a76cc844ea7b8dbe34774f34e12f2afd77537fca84b8e20bcc` 和相同 processed 图像建立全新副本。每例建图前后，在私有恢复副本中核对完整 SQLite schema、所有表、全部标量与 blob，均等于共同输入，逻辑 SHA-256 为 `ad6f2923c1dd0a76cd4dbd4f5e370a43121fac891a6c9bb3491793e9559c194d`。原库及 sidecar 原件没有被 SQLite 打开或改写。

四个主要进程均完整捕获实际 argv，观察错误为零。仅替换三类案例路径后，其余参数及顺序相同；生产命令没有环境覆盖。四例继承相同父环境，七项线程相关环境变量均与历史控制值相同。四个实际 `project.ini` 的 51 项非路径参数逐项等于冻结控制，包括 CPU 六线程、GPU 禁用、`default_random_seed=0`、`GlobalMapper.random_seed=-1`；没有搜索种子或线程设置。

| 固定案例 | 注册图片 | 稀疏点 | 观测数 | 平均 track | 平均重投影误差 px |
| --- | --- | --- | --- | --- | --- |
| mapper-pair1-cli | 40/40 | 22,449 | 112,487 | 5.0107799902000085 | 0.23768011544781000 |
| mapper-pair1-adapter | 40/40 | 22,449 | 112,487 | 5.0107799902000085 | 0.23768011544680906 |
| mapper-pair2-adapter | 40/40 | 22,449 | 112,487 | 5.0107799902000085 | 0.23768011544472759 |
| mapper-pair2-cli | 40/40 | 22,449 | 112,487 | 5.0107799902000085 | 0.23768011544613982 |

四例均通过原固定门槛，保留全部 40 个主基线文件名，每例只有预期的 `0/` 模型。相对原独立 CLI 日志中的主基线，四例都是点数 +731、观测数 +3,833、平均 track 约 +0.007833、平均误差约 −0.003692 px；这只描述本轮共同几何输入上的结果，不能替换原独立导入比较。

六组逐字段比较确认：camera/image/point/frame ID 集合、相机类型与尺寸、图像名称及相机引用、全部 2D 观测坐标与 point3D 关联、点的 track 元组及其存储顺序、RGB、frame 的 rig／data 关联均相同，rig 文件字节也相同。另一方面，每组的四个相机参数记录、40 个图像姿态记录、22,449 个点记录和 40 个 frame 姿态记录均存在浮点字段差异，完整模型语义哈希不相同；同路径复跑也存在这些差异。

| 六组比较中的最大差异 | 描述性实测值 |
| --- | --- |
| 相机参数的绝对分量差 | 2.7284841053187847 × 10⁻¹² |
| 图像平移向量 L2 差，模型原生单位 | 3.1691228240619765 × 10⁻¹⁵ |
| 点坐标 L2 差，模型原生单位 | 9.13296818471321 × 10⁻¹¹ |
| 单点存储重投影误差绝对差 | 2.1469704236665166 × 10⁻⁸ px |
| 平均重投影误差绝对差 | 3.0824232055692846 × 10⁻¹² px |

坐标比较未做相似变换对齐，模型原生单位不解释为米。最大单点误差与平均误差分别报告，不能用平均值掩盖单点差异。四例都包含 304 条来自重复 image_id 的额外观测，涉及 256 个 point track；这些观测的最大同图像素间距为 5.368449305814579 px，超过上游 track 建立默认 10 px 参数的成对观测数为零。该统计仅作描述，不新建质量门槛，也不证明全部几何质量。

独立结果审计重新核对四个模型、四个当前数据库的私有恢复副本、全部绑定输入、归档包、实际 argv、INI 与固定门槛。另一个独立 struct parser 对六组主要拓扑及 30 项标量差异最大值重新计算，均与字段比较收据一致，并复核 20 个模型文件哈希；L2、旋转角、frame 及 track 存储顺序等补充计算经过源码复核，收据区分了独立重算与源码审查的范围。

本轮使用已归档 d91c app 内的 COLMAP，路径为 `target/macos-m4/release-package-editor-framing-20261027/previous-candidate/MetOrigin Splat.app/Contents/Resources/resources/engines/colmap/bin/colmap`。应用、包清单及引擎哈希仍分别为 `d91c49edcf382212a4c29e11b85fdd21bf9b721959d109dcb6852946ba55758b`、`34c16db42c8b7376d5c71a9683d82f2a3284460a401f70a318a1166ddc5912b4`、`bfd28a4abfc6aad219fbe73e0cc065277604cfa5bdfe68d762c14164478c5443`。后续 SuperSplat bridge／前端测试修改不是该 harness 的依赖，不能把本轮证据转移为 9e25 原生生成验收。

结束时冻结输入和归档包未变；15:08:58 UTC 实时进程检查可用且 `remaining_known=[]`，`root_process_review_required=false`，重任务／源码槽已归还主任务。随后又独立核对全部 3,680 个绑定文件无变化。该固定四例研究到此结束，没有自动追加重复运行。

本轮把几何验证输出固定后，观察到相同拓扑和上述浮点差异，未复现此前千点量级的跨运行点数差。但这不足以证明此前全部差值的唯一原因、统计等价性或原始质量不退化。**原独立 CLI／原 adapter 的 `quality_delta_review_required` 仍开放**；不增加容差，不修改主基线，也不放宽原计划 §10.3 的质量要求。

以下文件均位于本轮 `run-20261027T150614Z-1905202e/`：

| 文件 | SHA-256 |
| --- | --- |
| summary.json | `eaca5e93a49bec130052f68123dd16d0aaeff33d357d3efbcd231087bd09cd71` |
| completion-and-slot-release.json | `2c506636d1bf1f75b0c76762bd58be21d523963082f27848d55332e842d63d49` |
| independent-postexecution-review.json | `16cf4cd0b919e6b600333c146658ebb215b528992c5f3b32cf8ccc198f36c075` |
| model-field-comparison.json | `19078f235469d4d657bc16298d3cc95e50d5cc61696c4c91d1ae159af3f81e3b` |
| independent-field-comparison.json | `785b9786920ac298e4a3d633a2596a2f0e0f3c0bb30dd1349410e6291b7256c4` |
| independent-field-crosscheck.json | `dc6ed0e175e8a7611e2d8e2870bdbd40ebada584811eae89a0dabe8d752da8cc` |

## 2026-10-28：主基线质量差异的限定处置

综合独立导入主基线、固定匹配前输入的四次对照及共同匹配后输入的四次 mapper 对照，当前诊断链结束。已核对范围内未定位到需要修复的产品参数遗漏、命令差异或 mapper 实现缺陷：几何验证输出在同路径复跑中也会变化，而固定该输出后四次 mapper 的拓扑相同。线程调度与 PRNG 是合理待控因素，但现有证据不能证明它们是原差值的唯一原因。

预声明的绝对门槛及“不降低合格 CLI 注册数”均已通过；整体相对质量“不退化”仍未闭合，多指标判定和运行波动处理规则尚需明确。原 adapter 的 20,530 点低于后续四次复跑的最低 20,975 点，原平均误差 0.277029 px 高于其最高 0.244350 px，因此不能声称后续波动范围已经解释原差值，也不能宣称质量等价。保留 `quality_delta_review_required`，原主基线与不利结果不被较好复跑替换。

本轮不再追加重复运行、搜索种子或为消除差值修改源码，不新增事后容差；其他验收工作继续按各自缺口推进。限定只读分析及证据绑定见 [质量差异处置收据](../../target/macos-m4/primary-sfm-quality-disposition-20261027.json)，SHA-256 为 `34e7012e75294c6ae0930fdb451bfcb19f8b505ae5e689e4e008d56f7dbcc07c`。
