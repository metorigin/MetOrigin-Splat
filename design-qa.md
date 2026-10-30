# SuperSplat菜单与场景面板齐边（2026-10-30，当前）

按用户要求，嵌入菜单与下方场景管理器共享24px左边距、320px内容宽度，两侧1px边框一致；菜单项水平内边距改为12px。固定宽度只作用于展开且没有menu-home的菜单，折叠仍按箭头内容收窄，独立带品牌菜单继续自适应。

16项既有主题/准备资产回归、typecheck、Vite及macOS debug app构建、Jan与copied-UI输入校验和31项public/dist来源配对通过；没有新增低影响CSS镜像测试，也未重跑全前端或Rust测试。最终SHA256为`cb215d0b1d7ed4e75f900590632e09ea060e0009d780f94efc5cc9482e686db8`。

精确bundle正常重启后，在2880×1770宽窗深色中文frames编辑器实测：菜单与场景面板外框均从物理x48到x692（右侧exclusive），截图边框像素核对一致；五项菜单与折叠图标完整，实际折叠仅露箭头、场景面板隐藏，重新展开恢复齐边。最终编辑器保持展开、宿主侧栏隐藏，相机信息和性能面板仍关闭；未编辑/保存/丢弃模型或训练，6个保护文件前后大小与SHA256一致。证据见`.test-results/supersplat-menu-alignment/`，其他平台、英文/窄窗原生矩阵及整体迁移/发布范围保持。

---

# 精简SuperSplat嵌入菜单与叠加信息（2026-10-30，历史范围）

按用户圈选隐藏嵌入菜单内SuperSplat标志、名称与相邻分隔线，文件/编辑/选择/渲染/帮助及宿主标题、右下版本、About和许可证保留。相机信息与帧耗时上游本就默认关闭，现有显示来自持久化开启偏好；新增一次性迁移，仅将`camera.showInfo`与`view.perfOverlay`设false，保留其余值和顶层字段，写入成功后记录独立marker。迁移在`registerPreferences`之前执行，之后手动开启继续记忆，独立模式不变。

本轮8项主题/迁移测试与8项prepared资产测试共16项、typecheck、Vite及macOS debug app构建通过，31项public/dist资产来源与配对检查通过；未重跑整套前端或Rust测试。最终二进制SHA256为`1bef6d76f7008f99159316162a8ee0fa863723fbaaa7698d18677715ccff617e`。初候选与文档输入同步后的最终构建分别记录，未混用身份；独立只读代码复核无阻断项。

本机宽窗深色中文frames工程226,803点实机验证：首进三个框选区域均已隐藏；叠加层中手动开启相机信息与帧耗时可用，退出再进仍记忆开启；随后恢复两项关闭。最终精确bundle再次正常启动，重新载入frames并确认菜单无home链接、相机信息/GPU/CPU面板均不显示，应用保持编辑器打开、侧栏隐藏。没有编辑、保存、丢弃模型或启动训练；6个模型/工程/设置保护文件前后大小及SHA256一致。截图/AX与日志见`.test-results/supersplat-embedded-presentation/`。仅本机当前范围通过；其他平台、完整辅助技术/性能矩阵及既有整体迁移/发布验收保持。

---

# SuperSplat 3.7.0 升级（2026-10-30，历史范围）

代码、兼容性、资源来源及macOS debug构建通过；用户确认退出编辑器后，已正常重启精确bundle并完成本机原生验证。当前固定官方v3.7.0/b89029dd…，配套splat-transform3.10.2/e0dab1fa…及新版独立WebP派生链；旧3.4.2来源/载荷保留历史。保存参数适配为保留实际SH阶数，父窗口鉴权、dirty与保存ACK、稳定iframe、相机和Jan主题契约保持。升级没有清空相机信息/帧耗时等用户偏好。

最终43文件438项前端、52项集成/打包测试均通过；包含SH0/1/3的真实bridge→serializer→PLY重读及有限值/变换/删除校验。独立消费者和Python来源验收分别10/25/28项通过（与主门禁可能有重叠，不作唯一总数求和）；原官方codec16项、真实worker、失败清理与配对对照见新固定证据。全量Lint、typecheck、31项prepared/public/dist资源配对、内部alpha许可证据及debug app构建通过，未重跑Rust测试。最终二进制SHA256：`412a32a8c8cbbd2aee4ab3131f98b8d661375d7dddb89135b486cae7d70b9919`。

本机2880×1770宽窗/深色中文原生截图与AX明确显示`SUPERSPLAT v3.7.0`。既有“Jan UI 合成模型（非训练）”512点加载正常；位置X实际走完0→0.25→撤销0→重做0.25→撤销0，随后直接返回工作台，无保存或丢弃。128×128 WebP经原生保存对话框写入本轮exports目录，sips读取尺寸与实图检查通过；此项只证明静态图像导出，不延伸为WASM路径或视频导出验收。结束时回到frames工作台并隐藏侧栏，6个模型/工程/配置保护文件前后字节与SHA256一致，alpha.6设置保留。原生模型保存未操作，视频导出仍未验证；保存兼容性由真实SH roundtrip自动测试覆盖。构建与全部日志见`.test-results/supersplat-3.7-upgrade/`。原生其他平台/紧凑及完整辅助技术和性能矩阵、既有单条原始npm许可缺项与整体发布/迁移验收继续保持。

---

# 移除工作台最近项目菜单项（2026-10-30，历史范围）

**final result: passed（本机macOS宽窗、深色中文的指定菜单移除范围）**

仅移除TitleRunBar操作菜单中的“从最近项目移除”及其无用prop和App传参，项目中心管理动作保留。此前9项TitleRunBar加12项App共21项相关测试、全量ESLint、typecheck与macOS debug app构建通过，未重跑完整前端套件或Rust；本次续验没有重复测试。键盘菜单导航、Esc返焦、Tab关闭与运行时删除禁用断言保留。

用户要求退出编辑器后再重启；主代理先读取最新AX确认已回到frames工作台，再正常退出并从精确bundle启动新版。实际2880×1770原生截图`verified-menu.jpg/.ax.txt`确认菜单只保留“在资源管理器中显示”和“永久删除项目”，指定项消失；没有执行任何菜单动作。Esc关闭并返焦触发器，最后恢复侧栏隐藏、阶段收起与结果预览，应用保持打开。未进入编辑、保存、丢弃、修改模型、启动任务或更改引擎配置。

最终包SHA256为`869aabac058fa2a349dc93a6ae8a242a44363cbf3ee42ced7785a0fd1516d474`；证据在`.test-results/jan-ui-migration/remove-workbench-recent-action/`，初次用户编辑中暂缓重启的记录保存在`pending-before-reload/`。整体迁移、其他平台/原生compact及完整辅助技术/性能、发布验收保持。

---

# 工作台六处精简与质量说明（2026-10-29，历史范围）

**final result: passed（本机macOS宽窗、深色中文的本次工作台调整）**

最终debug app SHA256为`5501e7107e2b1fcb4358d406bc8409139b812a953d65c53ecc37e92b910b3a35`，从精确bundle正常重启并打开frames工程。证据目录`.test-results/jan-ui-migration/workbench-refinement/`保留用户六图、前后原生图、AX、构建身份与日志。

- 顶部不再显示整体进度入口或“查看项目文件”。四阶段完成态仅圆形勾与名称，明细可展开，两个已查子阶段列表均无重跑/“重试并开始”；相机特征提取预览为42,419稀疏点/40相机，训练准备预览为静态226,803高斯。主代理已查看`verified-completed-expanded`、`verified-camera-stage`与`verified-training-stage`实际截图。
- 右侧完成态仅一个标题与一句说明，无满进度条；真实指标为100%注册率、226,803高斯点、0.340px。产物按钮最终为两列：第一行输出目录/PLY，第二行恢复点7。首候选`b566…`在窄Inspector中挤成三行，修复后的候选身份与截图保留在`candidate-b566/`。最终结果预览正常，质量详情可打开并Esc关闭；该详情验证保留AX证据，不计作已查看详情截图。
- before为3024×1770、224px侧栏；重启恢复默认窗口后为2880×1770、240px侧栏，只比较用户指定区域，不声称全图同态像素对照。`final-workbench.jpg/.ax.txt`记录最终侧栏隐藏、阶段全收起及结果预览，应用保持打开。

4文件74项相关测试（ProjectDetail45、TitleRunBar9、App12、QualityReportDialog8）最终重跑全部通过，全量ESLint、typecheck与macOS debug app构建通过；未重跑整套前端或Rust。frames工程project/scene/manifest、7个已存恢复点与settings共11文件前后哈希全部不变，alpha.6配置保留；没有训练、编辑、保存或删除。以上passed只覆盖本机宽窗深色中文，原生compact、其他平台、完整辅助技术/性能及整体迁移/发布验收仍未关闭。

---

# 向导五处微调与恢复点反馈（2026-10-29，历史范围）

**final result: passed（本机macOS宽窗、深色中文的本次五处调整）**

新版debug app已正常重启，主代理实际查看3024×1770、224px展开的原生截图。证据目录`.test-results/jan-ui-migration/wizard-five-fixes/`保留各处复验；本次仅微调文案、预设选择样式、Mac执行摘要与成功空恢复点反馈，三步业务及目标参数保持。

- `verified-capture-tips.jpg/.ax.txt`确认拍摄建议只保留“素材默认仅在本机处理”，指定上传副文案已移除。`verified-confirm.jpg/.ax.txt`确认指定素材复制副文案移除，名称/位置字段、复制111.3MiB摘要及两种提交按钮仍在。
- `verified-preset-fast.jpg`、`verified-preset-balanced-ready.jpg`及`verified-preset-quality.jpg`确认快速、均衡、高质量均可选，橙色填充、勾选与ring随选择转移。实际Mac摘要保持单行：快速为3,000步/SH0/1280px，均衡和高质量均为7,000步/SH1/1920px；这些是当前后端警告中的实际执行值，预设目标参数没有被摘要替换。
- `verified-empty-checkpoints.jpg/.ax.txt`确认“M4 低纹理 24”工作台不再显示“暂无恢复点”占位，Checkpoint(0)与原失败反馈仍保留。成功空静默未影响载入、刷新、错误、陈旧、部分结果及重试语义。
- 本轮只读分析James40 source目录40张照片，没有提交创建或启动训练，没有更改引擎或模型数据。最后停留第二步高质量预设，`final-preset-quality.jpg/.ax.txt`记录用户可直接查看的状态，应用保持打开。

19项向导加44项工作台，共63项局部回归、全量ESLint、typecheck与macOS debug app构建通过；本轮未重跑完整前端套件或Rust。最终app SHA256为`a422477fb3fe7e26adea1d522784b54d63572d1e4360982b2b0166bb8cfed638`。以上passed仅覆盖本次本机宽窗深色中文；原生compact、其他平台、完整辅助技术/性能矩阵及整体迁移/发布验收继续保留。

---

# 新建项目三步向导精简（2026-10-29，历史范围）

**final result: passed（本次界面与信息层级范围）**

用户选择保留三步流程，先精简界面与信息层级。当前沿用Jan桌面壳、主题和控件，将步骤条压为24px标记并移除重复可见说明，正文最大960px，底部操作固定。导入页仅保留两个明确素材入口，拍摄建议默认折叠；真实照片预览在宽窗排为六列。预检页优先展示三种预设，目标参数与运行环境详情按需展开，检查失败时自动展开环境详情，warnings、blockers和修复入口均在折叠外。确认页使用名称/位置标签行和轻量素材/方案/复制摘要。

- **真实来源及对照**：`.test-results/jan-ui-migration/new-project-review/`包含本轮旧版01–04截图、最终after-01–04和空白final-import-empty；均为3024×1770、深色中文、224px展开。四份comparison按2×等比归一化并排。主代理已打开最终各步骤和导入/预检/确认三个组合输入，照片数据及素材选择相同，无拉伸或伪造素材。
- **字体、间距与控件**：沿用Inter、中文回退和Jan颜色；层级与边界使用已有token。紧凑入口和三预设显式rounded-lg，避免扩展为巨大胶囊；步骤、正文和footer统一齐边，错误/复制反馈不再额外缩进。确认页字段、目录动作与两种提交均可见。
- **内容与图片**：相同James40工程source目录只读分析40张图，六张真实预览完整呈现。路径视觉省略时保留完整title及可访问文本；预设目标次数与Mac实际执行参数继续分别表达。正常环境版本详情收起，实际Mac执行提醒现在可在预检主视区直接读取。
- **交互与安全**：最终包实际走到第三步，查看参数与运行环境详情后正常返回，步骤标题焦点及两种创建按钮保留。只退出本轮检查产生的未提交向导草稿；没有创建工程、复制素材或启动重建任务，主区仍20项。最终停留空白第一步、下一步禁用且应用保持打开。失败自动展开、名称草稿、目录重检、旧响应、预设检查、单飞/取消、任务冲突及退出/IME行为由19项既有向导回归覆盖。

19项向导回归、全量ESLint、typecheck及macOS debug app构建通过；本轮没有重跑整套437项前端测试或Rust，不计作本轮新结果。最终app SHA256为`b2b8c9d5f9044e03b7b9ac97e582531a916ef8933a7c7918d2a66de8169cf5d6`，身份见build-identity.json。初候选0bacdf45…的正常环境详情仍造成长页，原图和身份保存在candidate-0bac；最终折叠详情后重新验证，当前范围未见遗留布局问题。

三步控制器、后端、引擎路径和创建协议保持。原生验证仅当前macOS宽窗深色中文与照片素材，视频/阻断/取消依赖组件回归；本轮未新验原生compact、浅色英文、其他平台及完整辅助技术/性能矩阵，整体迁移和发布验收继续保留。

---

# 移除侧栏最近项目（2026-10-29，历史范围）

**final result: passed（本次移除范围）**

移除宽窗侧栏及窄窗项目抽屉的“最近项目”标题、列表和对应数据/操作props；保留项目中心、底部设置、原有宽度/折叠及模态焦点和安全导航行为。主区照片网格与管理操作保持。43文件437项前端测试、Lint、typecheck和macOS debug app构建通过；App集成测试改由项目中心选择工程，原安全导航、项目隔离、活动任务冲突及不排队断言保留。原生源码未改，本轮未重跑Rust。

证据目录`.test-results/jan-ui-migration/remove-sidebar-recents/`。调试app SHA256为`1cf7d680ff35fedab49fc1491250aeb83038649b0e85a9d17ad16ed25306b915`；正常退出旧版后从精确bundle启动新版。`before.jpg`与`final-home-expanded224.jpg`均为3024×1770、Home/深色中文/224px展开，主代理已打开最终实际截图；`comparison-before-after.png`按2×归一化并排。最终截图和完整AX确认最近项目标题/列表消失、项目中心与设置保持、主区20项仍在；原生隐藏与展开恢复224px。字体、配色、图片、网格和按钮继续沿用现有设计，本范围未发现遗留显示问题。

窄窗抽屉由组件回归覆盖关闭、Esc/遮罩、焦点恢复、设置交接及导航禁用，本轮不称原生compact实测。应用保持最终首页打开；本轮未训练、打开或修改模型，也未更改引擎配置。整体迁移和其他平台/辅助技术/性能及发布验收继续保留。

---

# 移除状态筛选与卡片常驻信息（2026-10-29，历史范围）

**final result: passed（本次macOS宽窗、深色中文项目中心范围）**

按用户最新截图圈选，移除顶部“全部状态”选择菜单、照片下的训练状态行，以及常驻“路径已丢失/重新定位”块。项目中心保留照片与名称，工具栏保留数量、名称/完整路径搜索、打开与新建。状态和路径健康不再筛掉项目；原状态、阶段、完整路径、健康与时间仍在title及无障碍说明中，并继续用于原安全逻辑。恢复动作保留于更多菜单和真正的右键ContextMenu，实际重新定位后的UUID不匹配或错误反馈仍可见。本范围复核没有未解决P0/P1/P2。

- **视觉依据与归一化**：证据目录`.test-results/jan-ui-migration/remove-gallery-metadata/`。`reference-user.png`保留用户三处圈选；`before.jpg`与`final-home-expanded224.jpg`为同态Home、深色中文、224px展开、3024×1770真实截图。`comparison-before-after.png`按2×等比归一化后并排，`comparison-removed-regions.png`检查三处移除区域。主代理已打开最终实际截图和两份比较图，确认无状态菜单、卡片状态行及常驻路径恢复块，照片与名称保持原网格组织，未以改动项目数据改善构图。
- **字体与内容层级**：沿用Jan的Inter与中文系统回退，照片下保留13px项目名；长名称仍可通过title和无障碍描述读取。AX Help中的状态/健康文字是刻意保留的隐藏说明，不代表常驻状态行仍在画面中。
- **间距与布局**：移除三处显示后工具栏与卡片更紧凑，方形真实照片、名称、更多按钮及侧栏5项结构保留。原生隐藏侧栏占位归零，展开恢复224px；没有重设缩略图比例或引入重复打开图块。
- **颜色与控件**：沿用Jan共享主题与焦点token。更多和ContextMenu保留原动作及禁用语义；原生右键恢复菜单仅打开，Esc关闭，没有执行恢复或删除。原生三灯未在本轮变更或重新声明几何验收。
- **图像质量**：照片继续来自工程内frames/source，缺图及位置不可用仍有局部图标。缩略图后端及hook未改，不生成替代照片、不调用引擎或写入模型。
- **文案与交互**：原生搜索“Jan UI”得到1/20，清空后恢复20项；不再叠加状态筛选。菜单恢复入口与全库项目保持，未把隐藏常驻元信息误做删除领域状态。

最终43文件438项前端测试、Lint、typecheck及macOS debug app构建通过。调试app SHA256为`16f62bc00871d7b8566f92c65717babbd2ed6fcc5d743076bb6335394febde9b`。本轮后端及thumbnail hook未改，没有重跑Rust，不将上一轮Rust通过计为本轮新结果。

8个已保存文件与settings完整哈希保持不变，alpha.6路径配置保留；没有启动训练或进行模型打开、变换、保存、Discard。最终应用保持Home、深色中文、搜索空、224px展开。以上passed仅覆盖本机macOS宽窗的本次显示移除及已述交互，原生compact、其他平台、完整辅助技术与性能矩阵继续保留，整体迁移和release验收未关闭。

---

# Meshroom 项目网格验收（2026-10-29，历史范围）

**final result: passed**

用户已选择Meshroom Projects项目区的真实照片缩略图效果。当前实现保留Jan桌面框架和5项侧栏，将主区改为方形素材图、工程名与真实状态的网格；数量/搜索/状态/打开/新建收敛到可换行工具栏。Meshroom仅作视觉参考，没有复制QML或其品牌/赞助区。照片来自工程内frames/source，不生成替代图，不渲染或写入模型。本次通过仅覆盖该桌面项目中心范围，不关闭完整迁移与发布验收。

- 视觉真值：`.test-results/jan-ui-migration/project-center-reference/meshroom-projects-official-pr2724.png`为444×236官方局部PNG；`meshroom-home-official-pr2987.gif`为1449×729官方录屏，使用frame0的Projects区415×711裁片。QML网格195px与图中约175px图片区支持1×参考尺度；原生3024×1770截图按2×归一化1512×885。历史官方图与当前源码共同核对，不声称运行Meshroom或与当前develop逐像素相同。
- 最终实现：`project-gallery/final-home-expanded224.jpg`为真实JPEG3024×1770、Home/深色/中文/224px展开。`comparison-final-before-after.png`为原列表/最终网格完整并排（各1512×885），检查完整窗口分区与工具栏；`comparison-final-reference-projects.png`将官方Projects区与本地首两列按1×、415×711并排，检查照片/名称层级和卡片细节。主代理实际打开两个组合输入及最终完整图。数据不同，照片与名称不作像素相同判定；保留Jan字体/配色、工具栏打开入口和3DGS状态行是用户上下文规定的适配。
- 最终调试app SHA256为`86881ed13c239ac2e857cd665cb5e9de79bf5d3b1620541370ef132b98626518`，源码与构建身份见`build-identity.json`。43文件435项前端测试、138项原生测试/3忽略、Lint、严格类型、Clippy、格式、16项来源检查及debug app构建通过。未新增依赖；原生三灯源码保持原哈希。

## 发现、修复与复验历史

- [P1，已修并原生复验] 首候选`461a51d0…`以受控DropdownMenu承接右键，右键释放落到新出现的永久删除项时误触操作影响预览。主代理立即取消，未点击确认执行。`candidate-right-click-issue.json`与`build-identity-candidate-461a.json`保留原身份；两种完整指针序列在旧实现确定性失败。最终使用鼠标位置锚定的Radix ContextMenu、非主键释放/合成点击保护，更多按钮保留Dropdown，两者共享actions并互斥。最终原生相同卡片右键后仅出现菜单；`verified-context-menu.jpg/.ax.txt`无影响预览，Esc关闭返焦更多按钮，Space仍能打开正常键盘菜单。主代理已打开该右键截图。没有实际执行移除/删除/重新定位。
- [生命周期边界，已修] ready视频工程无抽帧时的null缓存，可能在updated_at不变而训练阶段变化后持续命中。资源键加入status/stage_label，10项hook回归含同时间戳阶段变化后的真实图刷新；仅路径健康generation更新不会重复解码。未改工程时间语义。
- 初次视觉对照`comparison-before-after.png`/`comparison-reference-projects.png`保留首候选图。右键修复后重新构建、原生捕获并打开最终两份组合输入，没有留下未解决P0/P1/P2界面问题。

## 五项视觉表面与交互

- **字体**：沿用Jan的Inter与中文系统回退；照片下13px工程名和12px状态层级清楚，长名称省略且title/a11y保留原名与完整路径。没有引入参考软件字体或徽标。
- **间距与布局**：六列约180px照片在当前窗口下成立；方图、名称、状态上下组织与参考一致，状态/路径恢复行造成的局部增高是必要业务反馈。单行工具栏释放顶部留白，侧栏保持原224px与5项；隐藏占位0，展开恢复224。未照搬首格Open以免重复现有主区动作。
- **颜色与控件**：沿用Jan深色/暖橙token；完成使用低强调图标文字，失败/路径异常有文字及颜色，避免仅靠颜色。主图按钮取消内部暗色胶囊，只保留一层外部悬停反馈；ContextMenu使用相同popover与焦点token。系统控制标识仍遮三灯，本次不作新灯位几何声明。
- **图像质量**：原生实际显示项目内石块和鞋子素材，360px长边JPEG在约180 CSS方图内有足够2×采样。低纹理样本的灰/暗图保留其真实内容；无素材的合成工程使用明确无图图标，缺失路径使用位置不可用图标，未用生成图补齐。
- **文案与内容**：20条真实索引记录、5条侧栏最近项目保持；完整路径仍可搜索。需处理10/20，加“Jan UI”搜索0/20，清除筛选同时清搜索并恢复20。`verified-attention.*`、`verified-search-attention-empty.*`及最终AX可复核。未增加训练性能或完成质量的虚假数值。

八个已保存文件与settings完整SHA均不变，alpha.6配置保留；见`protected-before.json`/`protected-after.json`。原生没有打开/变换/保存/Discard模型或启动训练，最终Home/全部状态/搜索空/224px展开且应用保持打开。55项全库管理、异步路径重试、右键/Control-click释放及缓存边界由组件回归验证，不冒充本轮原生55项或完整辅助技术实测。原生compact、浅色/英文、浏览器console、其他平台和完整性能矩阵本轮未新验，继续保留台账。

本轮实施检查已完成：选定视觉来源、真实只读缩略图、完整网格/筛选/管理连接、失败先复现后修复、最终同态截图对照、原生右键/键盘/筛选/开合、受保护文件核对与代码门禁。

---

# 侧栏与项目中心精简（2026-10-29，历史范围）

**final result: passed（本轮桌面项目导航与项目中心范围）**

按用户确认的精简方案和红框，移除侧栏应用图标与“MetOrigin Splat”品牌行；侧栏只保留项目中心、最近5项和底部设置。项目名称与单枚状态图标保持紧凑，窄窗抽屉同步精简。新建/打开集中到主区；状态通过一个菜单筛选，与名称/完整路径搜索取交集。全库使用两行目录：名称/状态、末两段路径，更新时间靠右；完整路径保留搜索、title及可访问说明，异常恢复与管理行为继续接回原安全handler。

- 最终macOS调试包SHA256为`399811890b00817a8c69722a82aac2195d43080e6f29c582922973a04d996467`，证据位于`.test-results/jan-ui-migration/simplified-project-center/`。41文件407项前端测试、Lint、严格类型、16项界面来源测试和debug app构建通过。快捷键回归发现向导提交后旧首页监听短暂存活，确定性提交时事件先复现失败，再以同步更新监听修复；原有快捷键/IME/退出保护断言保持。
- 用户图`reference-user.png`与原生`before.jpg`为3024×1770@2×；最终`final-home-expanded224.jpg`和`after-hidden.jpg`同为3024×1770@2×、Home/深色/中文。主代理实际打开最终展开与隐藏完整截图，确认品牌行消失、仅5个最近项目、主区名称/短路径分两行且时间靠右；隐藏后正文无侧栏占位，展开恢复224px。没有拉伸或通过修改项目数据改善构图。
- 原生`after-attention.jpg`与完整AX确认需处理10/20；键盘打开异常项目菜单，`after-attention-menu.*`确认显示位置、重新定位、移除及永久删除入口，随后Esc关闭，没有执行这些动作。需处理加“Jan UI”搜索得到0/20与正确空态，清除筛选同时清空搜索并恢复全部20项；证据为`after-search-attention-empty.*`与最终首页。主区保留20项的实际AX；55项全库无截断及末项管理、路径搜索、异步重试暂留与焦点恢复由组件测试证明，不冒充原生55项实测。
- 中间候选`babd9ed5…`使用三行目录，实际查看后压缩为两行；其原图和`build-identity-candidate-babd.json`保留历史身份，不计为最终样式。最终原生图与源文件哈希绑定到当前构建。精确bundle通过CUA正常退出后重新启动；进程表读取受sandbox限制，未提升权限，不声称取得独立PID回读。
- 三个工程共8个已保存文件与settings完整SHA保持不变；alpha.6路径配置沿用用户选择。没有打开/变换/保存/Discard模型或启动训练，原生三灯实现未改。最终应用停留Home/全部状态/搜索空/224px展开并保持打开。
- 字体、主题、图标与焦点样式沿用现有Jan适配；行间距与长中文/emoji/路径在实际原生图中复核，异常路径仍有可见文字与恢复入口。系统紫色控制标识仍遮住三灯，不将这组截图当成新的三灯几何验收。原生compact、浏览器控制台、其他平台/辅助技术和完整性能矩阵本轮未复测；完整迁移与发布许可台账继续保留。

---

# 移除窗口后退/前进按钮（2026-10-29，历史范围）

**final result: passed（本次按钮移除范围）**

按用户红框移除`DesktopTitlebar`的后退/前进按钮、history区域及其占位；页头直接紧接侧栏区域，稳定toggle/header portal保持。App删除相应props与未使用的回调解构；侧栏项目导航、编辑器安全离开与向导退出保护继续由既有控制器拥有。UI来源本地修改说明与现行规范已同步。

41文件401项前端测试、Lint、严格类型和macOS调试app构建通过。新包SHA256为`16392042f4074005b4117e9a3b9d2b42e334e04a09e74231d157c12f97058e0c`，证据目录`.test-results/jan-ui-migration/remove-history-buttons/`。原生Home展开224/隐藏均为3024×1770真实JPEG，AX中两按钮不存在；主代理实际打开`after-expanded224-header.png`和`after-hidden-header.png`，确认标题左移且没有保留导航空位，开合后宽度恢复224。最终Home/深色/中文/224px展开，应用保持打开。原生三灯实现源码未改，本次未重复执行前节原生坐标/全屏验收；系统控制标识仍出现在当前截图中。完整迁移和发布剩余矩阵不由本次局部通过关闭。

---

# macOS 三灯垂直对齐验收（2026-10-29，历史范围）

**final result: passed（当前本机首行对齐范围）**

用户新图确认上一轮`trafficLightPosition.y=24`没有对齐圆心。当前已移除该容器inset，直接通过标准AppKit按钮实际父视图坐标将圆心放到48px首行的24pt中心；原生窗口更新后仅在偏离时重新校正，保留横向位置/尺寸/系统动作，全屏交给系统，Destroyed阻止晚到通知入队。没有伪造HTML窗口按钮或调整WebView图标位置来掩盖偏差。

- 当前证据目录`.test-results/jan-ui-migration/traffic-light-alignment/`。`native-before.jpg`与`verified-after-fullscreen.jpg`均真实JPEG3024×1770、Home/深色/中文/224px展开、2×密度。主代理已实际打开`comparison-native-header.png`（680×180，before上/after下）与`final-header.png`（680×90）；均为1360×180物理裁片等比缩为680×90，没有横向拉伸。before灰灯与after彩灯处于不同活跃外观，比较几何，不将颜色差异当作设计调整。
- 独立测量`measurement-before.json`/`measurement-after.json`使用同ROI、连通域和40–60亮度阈值敏感性检查。三灯圆心由16 CSS px变为24 CSS px，水平中心x16/39/62 CSS px保持；toggle可见glyph中心23.5 CSS px，修后差0.5±1 CSS px（修前7.5±1）。这是图像像素估值，glyph中心不等于DOM点击区中心；32px点击区按48px首行居中在24px。无遮挡after三圆完整可见，未被父视图裁切。
- 当前原生包SHA256为`11454f750b277d1e4016054d9ae8460c66c324c64b7159bc115e6e935b0de09e`，PID48306，身份为`build-identity.json`。显式启用的debug几何回读在静止1秒后独立读取实际按钮rect，PID48306的1440/1512pt非全屏样本均center=24pt、14×14pt尺寸；退出全屏后也保持24pt。fullscreen=true的系统标题栏隐藏坐标不纳入24pt判定。中间版本的16pt回读保留原身份，不算最终通过。
- 原生完成启动、native zoom恢复3024×1770、224px隐藏→展开宽度保持、全屏3024×1898→退出回3024×1770。`verified-final.ax.txt`确认最后Home/224px展开/深色中文、原生控件已恢复，app保持打开。系统控制标识在其他截图中仍遮灯，使用确实无遮挡的`verified-after-fullscreen.jpg`作本次视觉依据；没有修改系统覆盖标识或绕过被拒绝的应用访问。独立跨应用失焦没有取得成功证据，继续未验。
- 本轮desktop原生测试131通过/3忽略、Clippy所有target且`-D warnings`、格式/差异检查及调试app构建通过。前端源码未改，401项前端测试保留上一轮身份，不冒称重新执行。三个工程8个保存文件与settings完整SHA不变，alpha.6字段按用户选择保留；没有模型变换、保存、Discard或训练。
- 最新许可收集`traffic-light-license-evidence-v2`仍缺`react-remove-scroll-bar@2.3.8`原文，`release_ready:false`。原生compact、拖窗位移、其他平台/辅助技术/性能完整矩阵没有由这次局部通过关闭。

| 发现 | 修复与实际复核 |
| --- | --- |
| [P2，已修] 三灯圆心仍在16px，折叠按钮首行中心24px，相差约8px。 | 原生按钮实际frame对齐，无遮挡图像测得24px且完整可见；延后1秒实际rect回读及退出全屏后保持24pt。 |
| [P2，已修] 配置y被误当成圆心坐标，一次容器调整不足以保证后续系统布局。 | 移除inset缓存路径，使用每按钮实际parent转换及窗口更新偏离检查；不再依赖固定标题栏祖先层级。 |

字体、主题、项目内容及三维颜色均沿用此前实现；本轮只改变原生三灯的纵向定位。原始系统圆角和三灯动作保留，当前只检查了布局及全屏返回，不把未点击的关闭/最小化动作算作本轮功能通过。

---

# Jan 窗口首行优化验收（2026-10-29，历史范围）

**final result: passed（已复核的首行分组与行为范围）**

本轮按用户最新红框优化交通灯/侧栏开关/历史按钮一行。固定Jan `b8d58255baf6d9e870025d3f0c60a5b80a63143b`的LeftSidebar在macOS右对齐触发器，HeaderPage在隐藏时将其放入主区首行。本地保持48px桌面布局：展开时开关靠侧栏右缘，后退/前进作为内容页头前缀；隐藏时三按钮连续排列，正文侧栏仍占位0。当前已查看范围未见未解决P0/P1/P2首行视觉问题；无遮挡交通灯精确位置仍未验。

- 用户参考`firstrow-refinement/reference-user.png`为真实PNG3024×1770，2×对应1512×885 CSS；红框仅为标注。原生`before.jpg`与`candidate-expanded224.jpg`均为Home/深色/中文/224px展开、3024×1770真实JPEG。`comparison-header.png`为两个680×90 CSS顶部裁片上下排列（before上/after下）；`comparison-expanded.png`为同密度完整并排（before左/after右，各1512×885）。主代理已实际打开这两个组合输入，确认侧栏开关右对齐、历史按钮位于内容首行；重启后的项目顺序变化不作为排版漂移判定。
- `DesktopTitlebar`保留navigation/history/page-header三个稳定兄弟节点，开合不替换控件或header portal。按钮统一32px圆形点击区、18px图标，图标使用显式size class防止共享Button回退成16px；精确尺寸来自源码，原生截图和点击动作不冒充独立点击区测量。
- 原生`trafficLightPosition`从`{x:16,y:16}`调为`{x:16,y:24}`，依据用户原图灯组相对首行中心偏上约8 logical px，以及锁定tao0.35.3/wry0.55.1的位移实现校准。没有HTML模拟交通灯。新截图的紫色系统控制标识遮挡灯组，不能据此声明无遮挡中心对齐通过。
- 新macOS调试app SHA256为`f69d5765c61018c45d7d164fefd5042dbdbf8002d0f770e7ca261ad2f4518a28`，身份见`firstrow-refinement/build-identity.json`与`native-process-identity.json`。Node22.23.2/pnpm11.12.0的Lint、严格类型、41文件401项前端测试、16项UI来源测试及本机app构建通过。新增5项顶栏回归先在旧区域归属下失败、修改后通过，验证节点/ref/焦点/页头草稿保持、回调/禁用及compact语义，不用jsdom断言像素。
- 原生224/320px展开、隐藏和运行内宽度恢复均复核。展开工作台后退返回Home，隐藏Home前进回同合成工程，隐藏工作台后退回Home；页头与历史禁用状态正确。只读合成编辑器隐藏/展开后，标题/返回/保存仍可见，同iframe URL、512点、Position X0及相机P/T保持；干净返回无dirty确认。没有变换、保存、Discard或训练。
- 主代理已实际打开`candidate-collapsed.jpg`、`final-home-expanded224.jpg`及`final-header-expanded.png`/`final-header-collapsed.png`，确认隐藏正文无空列、展开上下齐边、标题未与按钮重叠。最终恢复本轮起点Home/深色/中文/224px展开、3024×1770，应用保持打开。9张新版原生截图及对应AX见`screenshot-index.json`，动作见`final-observations.json`。
- 三个工程8个已记录保存文件与settings完整SHA不变；alpha.6路径配置按用户选择保留，debug开发目录优先级未改。旧包M7训练及授权单次Discard结果保留原身份，不绑定到新包。最新许可收集仍缺`react-remove-scroll-bar@2.3.8`原文，`release_ready:false`；不以本轮视觉通过关闭发布许可或完整迁移目标。
- 本轮浏览器工具不可用，没有新的浏览器/console通过声明；原生compact、无遮挡交通灯、空白首行拖窗位移、Windows/WebView2/DPI、辅助技术和完整状态矩阵仍待验。保留原生drag-region标记不等于已验证窗口位移。

| 发现 | 修复与验证 |
| --- | --- |
| [P2，已修并原生复核] 三个导航按钮全留在左列，展开时开关未贴侧栏右缘，历史动作的区域归属不符合Jan。 | 左列只容纳开关，后退/前进进入内容首行前缀；224/320/隐藏截图、真实历史导航及稳定节点测试通过。 |
| [P2，源码修正，精确视觉待验] 用户原图灯组相对48px首行按钮中心偏上。 | 原生y16→24按依赖位移实现调整；新包已运行，但系统标识遮灯，保留无遮挡位置验证。 |

五项视觉表面：字体与既有主题未变，标题/长中文内容层级保持；相同密度组合图确认区域归属和留白；中性控件、焦点和禁用色沿用共享token；Lucide与OS原生灯组未加入伪功能资产；真实项目记录/异常状态保持。对交通灯遮挡和原生compact的限制单独登记，不将局部passed扩展为完整矩阵通过。

---

# Jan 侧栏隐藏修复验收（2026-10-29，历史范围）

**final result: passed**

用户截图指出收起后仍有184px空列，主体图标居中而设置靠左。固定Jan源码的LeftSidebar显式使用offcanvas，收起占位为0；旧本地适配误将顶栏控件安全宽度延伸成正文图标轨道。已改为隐藏整个正文侧栏、保留顶栏展开入口，并补齐窄窗抽屉动作与设置关闭返焦。最终包的原生Home隐藏/展开已实际复核，本报告当前侧栏布局范围无未解决P0/P1/P2视觉问题；辅助技术/平台全矩阵不由本报告关闭。

- 视觉问题来源：用户`codex-clipboard-0dc38d6b-8b72-4ad9-9944-17c37d7fe083.png`（3024×1770@2×，1512×885 CSS）；红框仅为用户标注。原生同态before为`.test-results/jan-ui-migration/sidebar-hide-bug/before-collapsed.jpg`，真实JPEG3024×1770，Home/深色/中文/收起；主代理已实际打开。
- 最终实现为`sidebar-hide-bug/final-home-hidden.jpg`及`final-home-expanded-224.jpg`，均真实JPEG3024×1770@2×（1512×885 CSS）、Home/深色/中文。原生zoom恢复相同窗口尺寸后捕获，没有横向拉伸。`comparison-native-hidden.png`为同密度完整并排（before左/after右，3024×885）；`comparison-native-hidden-top.png`为两块600×220 CSS顶部裁片上下排列（600×440）。主代理已实际打开两份组合输入与展开图，确认空列/竖分隔/孤立齿轮消失，展开224仍上下对齐。重启后的真实索引行顺序有变化，比较的是容器与排版，不把不同项目位置当成像素漂移。
- 最终本机调试app SHA256为`fe2151c3cabcf840ee989b3bfd9c94b2c58a2c48382c4ac9ef8d5b2bed6da8a3`，身份见`sidebar-hide-bug/build-identity.json`。Node22.23.2/pnpm11.12.0本轮Lint/类型/40文件396测试通过，UI来源16项通过，调试app构建通过；真实原生截图不以这些命令替代。
- 完整原生动作、15张JPEG真实尺寸/哈希与收尾索引为`sidebar-hide-bug/final-observations.json`；最终收起图为`final-home-restored-hidden.jpg`。主代理已实际打开该最终图，确认与初次after一致，app停留干净Home并保持打开，没有继续抢回用户前台。
- 原生editor纯隐藏→展开过程中，512点画面持续可见、iframe URL与相机P/T值不变，无载入提示；干净Back直接返回工作台，没有dirty确认或模型保存。最终`final-home-restored-hidden.jpg`与AX确认Home/深色/隐藏、原3024×1770尺寸、运行内宽度记忆224。三个工程共8个保存文件与settings完整哈希均未变，alpha.6配置保留。
- compact原生验证未完成：右边缘与角点拖动后截图实际仍为3024×1770，没有进入1120px断点；相关`final-compact-*.jpg`仅为尝试记录，不能凭文件名算窄窗通过。已停止该项操作，不用后台/Tauri窗口控制绕过工具限制；compact四入口与返焦由本轮组件/真实App行为测试覆盖，不冒称原生实测。
- 行为真值：固定Jan `b8d58255…` 的LeftSidebar `collapsible="offcanvas"`、Sidebar收起gap `w-0`及HeaderPage仅首行避让macOS窗口控件。保留本地AppContext/安全导航，不复制Jan聊天或下载业务。
- 本轮IAB浏览器工具不可用（独立会话库存为空），没有新的浏览器截图或控制台通过声明；本轮以原生复验和行为回归为主，前轮浏览器结果保留其原时点。

| 发现 | 修复与验证 |
| --- | --- |
| [P1，已修并原生复验] 收起只缩成184/112px图标栏，未按Jan完全隐藏，浪费整列并造成设置图标错位。 | collapsed/compact不渲染aside，正文占位0；顶栏导航按内容自适应、背景与主区一致；84px交通灯安全区仅在48px首行。App回归先失败、修改后通过，重新展开恢复320px且页面输入与DOM未重挂载；原生同态组合图确认隐藏完整，展开224上下齐边。 |
| [P2，行为已修] 隐藏整个侧栏会连带藏住嵌套的compact Drawer及设置入口。 | Drawer移为隐藏面板的兄弟；保留项目中心、新建、打开、设置真实动作。12项抽屉回归通过，含焦点trap/菜单/Esc/关闭及动作禁用边界。 |
| [P2，行为已修] 从Drawer打开设置，停留跨两帧后关闭，焦点落BODY。 | 顶栏toggle稳定id，SettingsShell复用既有ModalSurface返回fallback。真实App回归先失败、修后通过，未改通用ModalSurface。 |

五项视觉表面：字体/字号与原主题不变，长中文与路径仍有层级且未挤压主操作；同态组合图确认隐藏0占位、展开同宽及主背景连续；没有孤立齿轮或遗留品牌轨道，原生交通灯仍由OS提供（系统紫色控制标识覆盖其精确位置的限制保留）；文案/数据使用真实项目记录，compact动作均有实际handler。没有通过删减异常记录或伪造模型来改善构图。

本次检查清单：已完成Jan固定源码对照、同态原生before/after组合复核、Home隐藏/展开宽度、editor画面保留、保存文件不变及全量前端门禁；compact原生尺寸、其他平台/辅助技术仍保留未验。本次修复不关闭完整迁移目标的剩余矩阵。

---

# Jan 桌面布局与全界面视觉验收（历史范围，2026-10-29）

**final result: passed**

桌面四区构图与最后两处编辑器遮挡问题已通过最终包原生复核，当前已检查范围没有未解决的P0/P1/P2视觉发现。真实训练A→B→A曾报告黑画面，复核保存截图与操作次序后确认模型在Reset点击前已自行可见，撤回“持续黑屏/Reset才恢复”的结论。全量训练、平台与辅助技术矩阵仍分别登记，不由本报告关闭。旧报告的passed只代表其历史范围。

## 当前证据与归一化

证据目录：`.test-results/jan-ui-migration/`。用户视觉真值 `reference-desktop-four-regions.png` 为3024×1770物理像素，按2×归一化为 `reference-desktop-four-regions-1x.png`（1512×885 CSS像素）。红框是分区标注，未复制到产品。

- 浏览器最终构图：`desktop-four-regions-dark-en-1512.jpg`，1512×885@1x；`desktop-workspace-dark-en-1512.jpg`为运行工作台。参考与项目业务内容不同，比较的是窗口导航/侧栏、页头/内容关系，不比较聊天内容与项目行数量。
- 原生本轮构图：`native-home-light.png` / `native-home-dark-en.png`，2880×1770@2x，归一化1440×885。实际17条既有记录，包括长中文、空格、emoji与失效路径；没有将历史Running记录写作本轮活跃训练成功。
- 已实际打开组合输入 `comparison-desktop-after.png`（3024×885，源左/实现右等宽）及 `comparison-native-four-regions.png`（2952×885，1512px源左/1440px原生右等高无拉伸）。顶部重点对照为 `comparison-desktop-top-after.png`，1512×320，两个160px裁片按1 CSS像素比较。
- 修正前组合输入 `comparison-desktop-top-before.png` 已打开；`before-desktop-correction-dark-1512.jpg`保留初轮Jan浮动面板。不能用两张分开的截图冒称组合比较。
- `desktop-home-dark-en-1024.jpg`、设置与Inspector/检查点截图用于最小窗口；`wizard-preflight-blocked-reflow-dark-en-512.jpg`检查512×384 CSS重排。后者不等于已执行原生200%缩放。
- 最终Node22预览另以`final-node22/home-light-zh-full-recheck.jpg`复查：DOM与完整截图均为1440×1024、1×，控制台warn/error为空。较早`home-light-zh-1440.jpg`实际只有1440×810，属于截图裁切，不能作为1440×1024完整图证据。
- M7视觉候选二进制SHA256为`d9ec7abacf474efeddf5bf73aef795a08d3ad73d8d4a4c792ec0dc918e9873ae`；`native-final-editor-language-hidden.png`、`native-final-editor-perf-data-clear.png`与`native-final-editor-reset-host-zh.png`均2880×1770@2×。主代理已实际打开，确认重复语言行隐藏、性能文字不被面板/工具栏遮住，以及Reset后宿主中文保持一致。
- 诊断脱敏修复后的最终包SHA256为`6b3a7fb76c9b06d80c08f45d43bd7d79c4c2ee251e37b148d013bc3b8ca1db3e`。最终原生`native-m7-postfix-final-visible.jpg`为真实JPEG、2880×1770@2×（1440×885 CSS），浅色/跟随系统语言/240px侧栏；主代理已实际打开，81,439点视频重建模型可见。新旧前端哈希资产与SuperSplat输入相同，训练/循环证据仍保留原候选身份；新包实际诊断导出与可见壳另记`native-m7-postfix-observations.json`。
- 原生CUA截图沿用`.png`后缀的文件可能实际为JPEG字节；本报告按实际可解码尺寸/图像进行视觉复核，不以文件名证明PNG编码。真正模型图像导出的PNG/JPEG/WebP另有解码与内容验证，不与UI截图混用。

## 对照发现与修复历史

| 发现 | 改动与实际复核 |
| --- | --- |
| [P1，已修] 首轮Jan的8px外间距、浮动sidebar/inset和大圆角呈网页式框架；页标题仍落在导航左区。 | 改48px共同首行、左上/左下同宽、右上/右下同宽，移除外围gap和inset圆角。修改前/后顶部组合输入均已打开，最终全图与原生组合输入确认240px分区连续且标题位于内容列。 |
| [P2，已修] 工作台运行栏叠成第二页头，向导也重复title。 | compact TitleRunBar与editor返回/保存进入首行右区，进度详情由可访问Popover保留；向导只保留窗口title，安全退出留footer。工作台截图与进度Popover键盘回归已核对。 |
| [P2，已修] 512CSS下固定示例徽章覆盖创建按钮。 | fixture改22px占位状态栏；向导错误/复制进度移进主体滚动。浏览器实测Continue底边346px，viewport384px，不被状态栏覆盖；正常创建按钮与退出确认也已实查。 |
| [P2，已修] 活动日志初次失败被`[]`初值当作成功空结果并显示“上次成功”。 | 改未加载null状态，初读失败显示错误+重试，真正成功后才可呈现空结果；9项回归通过，`activity-first-read-error-dark-en-1440.jpg`来自修复后的真实浏览器。 |
| [P2，已修] SuperSplat PerfOverlay在压缩canvas后与Scene Panel重叠；Preferences Language隐藏状态被更具体上游display:flex覆盖。 | 版本化补丁移动性能浮层，并增加精确hidden规则；最终包的`native-final-editor-language-hidden.png`和`native-final-editor-perf-data-clear.png`已目视确认。`native-final-editor-reset-host-zh.png`确认Reset后宿主和内部仍为中文，iframe未重载。 |
| [已撤回，未确认故障] 真实训练A→B→A后曾报告“持续黑屏、Reset才恢复”。 | 主代理与操作代理重新打开`native-m7-photo-live-after-b-black.jpg`确认18:06:40Z/2950step模型已可见，且保存发生于Reset之前；原文件名误导。较早工具画面未保存字节，不能复核2753step瞬态原因。撤回持续故障和相机归因，不修改代码；后续跨项目加载瞬态继续观察。 |

## 五项视觉表面复核

| 表面 | 实际结论与有意适配 |
| --- | --- |
| 字体与排版 | 外部参考是聊天产品；本应用保留Inter与中文系统字体回退，14px正文/13px导航和紧凑单行窗口标题。组合顶部图显示标题与按钮共享基线；原生长中文、重音与emoji可见，名称/路径省略不挤压状态与日期。未复制Jan授权不明的字体。 |
| 间距与布局 | 本节原时点为48px首行、240px展开列，浏览器键盘224/320及拖动272时上下同宽；当时采用112/184px收起列。后续用户指出这段空列不符合Jan隐藏逻辑，现已由顶部当前报告的offcanvas零占位修复替代。主内容齐边、向导/设置阅读宽度仍保留。 |
| 颜色与token | 保留Jan中性表面、暖橙方向，而非复制Claude品牌色。浅色主填充采用较深橙配白字，深色橙配深字；同源对比度测试覆盖主色/hover、文字、输入边界和焦点。专业3D颜色与导出图像不被主题重染。没有据此宣称所有透明叠加或完整WCAG合规。 |
| 图片、图标与资产 | 真实MetOrigin标志、Lucide图标与原生窗口控件；没有CSS模拟交通灯，也没有复制参考的账号/聊天/分享图标充当伪功能。GPU实测使用本轮合成模型，截图和界面fixture分别有明确来源。系统紫色控制标识遮住交通灯，精确位置不能由截图确认。 |
| 文案与内容 | 项目名、路径、任务状态与恢复入口保持业务语义；模型/质量/影响示例明确标记。首次日志失败不再假报空成功；错误去掉内部类名并保留安全摘要/重试。参考聊天、账号、分享业务未加入应用。 |

## 本轮交互证据与限制

- 浏览器：完整路径搜索后Museum身份正确，Back→Forward保持身份；调宽、折叠/抽屉、设置、向导预检阻断/退出取消、检查点当前保护、质量decision与影响预览后取消均已查看。所有fixture不能证明原生GPU、创建或训练。
- 最终浏览器预览选择跟随系统时，系统深色媒体查询与DOM解析主题均为dark；随后恢复light/system语言，关闭设置并reset临时viewport至默认1280×720。旧1420任务标签已关闭，1422最终预览保留；记录为`final-node22/browser-final-observations.json`。这不代表已验证运行中系统外观切换事件的完整矩阵。
- 原生：当前已经真实完成512点GPU编辑、主题/语言/折叠保留变换、保存写回、重开、PNG/JPEG/WebP导出及原生保存取消。Video只查看参数和兼容警告，Publish只到需账户错误，不称视频生成/云发布成功。
- M7候选d9ec还实际完成James40照片和照片派生MP4的创建→40帧→COLMAP→Brush→Gaussian预览，分别135,130和81,439点；主代理已打开照片缩略图、训练中可见图及`native-m7-video-complete.jpg`。照片在TrainingPreparation与Brush1500各暂停并继续，500检查点GPU预览/当前1500保护已实查；继续1500是PLY几何续训，优化器重置。真实质量报告和活动日志搜索也已查看，完整细节见迁移记录10.7与独立素材/模型审计。
- 实测诊断发现旧后端system.disk_path绕过脱敏，已通过真实ResourceMetrics回归修复；新包经原生导出及主代理独立ZIP校验，4项JSON/JSONL有效、无用户/工程绝对路径或媒体，CRC与SHA通过。原失败包保留，没有上传。此次复验收尾窗口保持打开，light/system语言/240px侧栏已确认。用户后续明确选择保留alpha.6路径配置，现有字段已只读核对，不猜测或恢复未知原值。
- 自动化与原生构建的本轮结果见迁移记录第10.5节；最后CSS补丁已进入最终包。SuperSplat输入签名`2d6f93df30ab480560f91d28c7712b7ff44d7911f3093b382ce7b9273efb4c6f`与32项资产清单均已登记。
- M7候选d9ec完成20次Home→512点Spark工作台→Home；主代理打开第1、4、20次截图确认模型显示。证据`native-m7-20-cycles-summary.json`记录每次时间和同一模型哈希；这是视口进入退出检查，不证明GPU对象释放预算或训练性能。
- 首次原生Discard因缺少明确授权被自动审批拒绝，当时保存后安全退出；后续用户明确允许仅合成测试工程丢弃一次临时变换。已在新包原生执行Position X=0→0.5→Back→“丢弃并离开”，返回工作台后重开X0/512点可见，主代理打开`native-m7-discard-reopened.jpg`与AX确认。三个工程全部8个已记录保存文件及settings完整SHA不变；alpha.6配置按用户明确选择保留。证据为`user-approved-closures-file-validation.json`及迁移记录10.9。本次进入时dark/224px偏好未改，前一轮light/240px记录仍只代表其原时点。
- Windows/WebView2/DPI、无覆盖交通灯、窗口拖拽位移、读屏、forced-colors、实际200%/中文IME、M0/M7同模型性能比较仍待验。

## 实施检查清单

- [x] 按用户最新参考完成四区齐边、单行页头，保留Jan主题与真实项目业务。
- [x] 打开相同密度的源/实现完整与顶部组合图，复核五项视觉表面。
- [x] 原生明暗/英文、窄窗/重排及错误/空/陈旧/确认等适用状态进行本轮检查。
- [x] 编辑器最后两处P2修复后，重建并实际打开最终原生截图复核。
- [x] 核对真实训练跨项目返回的可见图与Reset时序，纠正误报；无依据的相机修复未执行。
- [x] 修复实际诊断导出的路径脱敏缺口；新包原生重导出与最终桌面/模型截图复验，旧候选证据身份保留。
- [x] 用户明确授权后，仅合成工程单次Discard→重开X0，保存文件独立哈希核对不变；保留用户选择的alpha.6路径配置和本轮进入时外观偏好。
- [ ] 全量J01–J24跨主题/语言/尺寸/状态矩阵及平台/辅助技术/真实训练验收；缺口持续记录，不以本报告局部视觉结果关闭全部目标。

---

# 桌面窗口导航与项目库视觉验收

日期：2026-10-28。最新范围：依据用户新增的 AFFiNE、Claude 红框参考，将窗口控制、侧栏开关与真实前进/后退整合为一体工具栏。下方保留前轮项目库与侧栏重设计记录；最新状态以本节和 `.test-results/window-toolbar/` 证据为准。

**final result: passed**

已实际打开源与实现的合并截图、原生明暗截图和英文窄窗截图，当前比较范围没有未解决的 P0/P1/P2 视觉问题。交通灯被 macOS 紫色控制状态标识遮挡，不能由截图确认其精确位置；拖动、GPU 与完整原生平台矩阵仍未验证。

## 最新视觉依据与归一化

截图目录：`.test-results/window-toolbar/`。

| 证据 | 尺寸、状态与用途 |
| --- | --- |
| `reference-affine.png` / `reference-claude.png` | 两张用户提供的新红框参考，均3024×1770物理像素；2×归一化副本分别为`reference-affine-1x.png`、`reference-claude-1x.png`，1512×885 CSS像素。 |
| `native-light.png` / `native-dark.png` | 最新本机 macOS 调试 .app，2880×1770物理像素；2×归一化为`native-light-1x.png`、`native-dark-1x.png`，1440×885 CSS像素。中文项目中心、17条真实记录，失败和路径丢失状态保留。 |
| `native-light-restored.png` / `native-light-restored-1x.png` | 收尾后恢复浅色与跟随系统语言的原生窗口，分别为2880×1770与1440×885 PNG；主代理已打开归一化副本确认，设置面板已关闭。 |
| `comparison-top.png` | 1512×570，三个190px高的顶部裁片依次为AFFiNE、Claude、实现；均按1 CSS像素比较，较窄的实现没有横向拉伸。已打开这一合并输入检查控件基线、间距、表面衔接和重复标题。 |
| `comparison-full.png` | 2952×885，Claude参考左、1440px宽原生实现右；相同高度并排，无拉伸。已打开检查整体框架与顶部对项目库的影响。 |
| `browser-1024-en-dark.png` | 1024×768、1×，英文深色浏览器预览。顶部导航、64px图标栏、项目库搜索和主操作均可见；示例数据标记保留。 |
| `native-collapsed.png` / `native-zoom.png` | 分别为2880×1770折叠状态和3024×1772双击缩放状态。交互记录由主代理验证；缩放成功不等同于拖动已验证。 |

业务和窗口宽度与参考不同，不能将文档标签页、Claude模式开关或空白项目卡片数量当作逐像素目标。最新目标是两图共同的窗口级工具栏：交通灯与导航共用顶部一行、侧栏色块上延、主内容背景连续、首页不重复标题。没有添加无业务支撑的标签页、伪按钮或新的应用框架。

## 最新发现与修复

| 发现 | 修复与结果 |
| --- | --- |
| [P2，已修] 前轮独立标题条显示重复“项目中心”，侧栏开关仍在下一行，和新参考的一体顶部关系不符。 | `DesktopTitlebar`改为40px工具栏，28px按钮在同一基线上排列；macOS预留左84px原生区域，其后是侧栏开关、后退、前进。去掉整条底边框及重复标题，侧栏背景按240/64px宽度延伸到顶部。`comparison-top.png`确认顶部现在自然衔接主内容，sidebar不再有第二个折叠按钮。 |
| [P1，预览验收中已修] 预览打开非主项目时，项目和pipeline仍可能返回Courtyard身份，导致前后退验证显示错误项目。 | `open_project`按`path`选择fixture，`get_pipeline_state`按`projectPath`选择状态；未知显式路径报错而非静默替换。7项预览身份单测通过，主代理手工确认Museum → Back → Forward身份保持一致。本问题属于开发预览数据，不声称修改了真实项目记录。 |
| 当前复核 | 合并顶部图、完整构图、原生浅/深色与1024px英文状态未见新增P0/P1/P2。控件没有相互挤压，禁用前后退有弱化状态，顶部空白保持可用的窗口拖拽表面。 |

## 最新五项必查表面

| 表面 | 实际观察与结论 |
| --- | --- |
| 字体与排版 | 不再在窗口栏重印页面标题；品牌留在侧栏，主内容标题仍为18px。项目名14px、路径12px和侧栏13px的既有层级保留。中英文窗口导航由图标表达并有翻译名称，英文主操作没有被截断。 |
| 间距与布局 | 顶部40px，按钮28px、间距4px，图标16/17px。与两张参考一致地将窗口级操作集中在首行。装饰背景独立于按钮布局，折叠为64px时前后退仍可延伸到主区；`browser-1024-en-dark.png`中主操作完整。源图标签页和模式切换属于参考业务，不复制。 |
| 颜色与token | 顶部左侧延续sidebar色，右侧延续当前页面background/card，没有新增横贯窗口的分隔线。浅色和深色都保持同样结构；正常/禁用按钮为中性色，hover和focus沿用共享组件。没有引入新的硬编码装饰色或透明材质假象。 |
| 图片、图标与资产 | 使用现有MetOrigin品牌与Lucide PanelLeft/Chevron图标；交通灯继续是原生控件，没有CSS模拟。源图的其他品牌/模式图标和多标签页不是目标应用功能，因此没有伪造替代资产。系统紫色标识属于截图环境，不能作为应用设计元素验收。 |
| 文案与内容 | 顶部只提供真实侧栏、后退、前进功能；无重复“项目中心”。项目标题、路径、异常和日期仍来自真实记录，浏览器示例仍明确标识。创建向导作为瞬态流程不伪装成可恢复的历史草稿。 |

## 最新交互与验证证据

- 页面历史最多50项，同页不重复入栈，后退后普通跳页截断forward；重新定位同步历史路径，移除项目清除对应历史。创建向导不写入历史，安全退出到原目的地保留forward，创建完成后Back不会返回空向导。
- 顶部导航在创建向导及历史跳转等待期间禁用；reducer也拒绝向导期back/forward。编辑器导航先等待`editor.leave()`确认和关闭成功，再更新历史，防止绕过dirty/忙碌保护。
- App统一控制compact断点和抽屉开关；宽窗按钮折叠侧栏，窄窗同一按钮打开项目抽屉。按钮始终挂载，现有ModalSurface保留返回焦点策略。桌面浏览器及Windows/Linux也呈现应用导航栏，只有原生macOS加交通灯预留，避免其他平台失去唯一开关。
- `.test-results/window-toolbar/frontend-tests.log`确认38个测试文件、333项测试通过。随后新增`uiPreview.test.ts`的7项单测单独通过；它们不是一次340项全量运行。TypeScript和ESLint通过。
- `.test-results/window-toolbar/native-build.log`确认Vite前端生产构建以及`pnpm tauri build --debug --bundles app`成功。产物是本机调试`.app`，不能称为签名、公证或发布安装包验收。
- 主代理实际验证原生项目后退/前进、侧栏折叠和标题栏双击缩放；浏览器验证Museum → Back → Forward。截图复核覆盖原生明暗主题、长中文名称、路径、emoji和英文1024px窄窗。
- 主代理已将原生窗口恢复浅色与跟随系统语言，并关闭设置；最终证据为`native-light-restored-1x.png`。浏览器已恢复system语言/light主题并reset viewport，本轮临时预览tab已关闭，真实原生窗口保持打开。

## 最新限制与实施清单

- [x] 一体40px窗口工具栏、28px按钮、主题背景连续、移除重复标题和侧栏重复开关。
- [x] 真实历史与创建/编辑器安全保护；受控compact抽屉；预览项目身份修复。
- [x] 源与实现合并顶部/全图对照，以及原生浅/深色和1024px英文截图复核。
- [x] 本轮333项全量前端测试，随后7项预览单测；类型、Lint和调试原生构建验证。
- [ ] 无系统覆盖时确认交通灯精确位置，实测拖动；Windows/Linux原生与跨设备WebView矩阵。
- [ ] 真实GPU训练、重建恢复、200%缩放、读屏和长时资源验收。本轮未以截图或测试耗时冒充这些结果。

## 前轮项目库重设计记录（历史）

以下保留上轮验收与修复证据，其中“最终”仅指当轮状态；本轮窗口导航的最终状态以上节和`window-toolbar/`截图为准。

### 前轮视觉依据与归一化

- 源视觉真值：`.test-results/affine-design-comparison/01-affine.png`。用户提供的 AFFiNE 深色桌面截图，3024×1770 物理像素，按 2× 密度归一化到 1512×885 CSS 像素。归一化副本：`01-affine-1x.png`。
- 最终原生实现：`.test-results/affine-design-comparison/07-native-dark-final.png`。本地 macOS 调试 .app，2880×1770 物理像素，按 2× 密度归一化到 1440×885 CSS 像素。归一化副本：`07-native-dark-final-1x.png`。
- 最终浅色实现：`.test-results/affine-design-comparison/13-native-light-final.png`，2880×1770@2x，即1440×885 CSS像素；已恢复用户原浅色偏好。
- 全屏辅助证据：`.test-results/affine-design-comparison/12-native-fullscreen.png`，3024×1898@2x，即1512×949 CSS像素；单独检查全屏布局，不与窗口态作逐像素比较。
- 原生状态：中文、深色/浅色、项目中心、17 条真实最近项目记录、11 条已完成；记录含中文、空格、emoji 与长路径。路径丢失、失败、暂停等状态来自现有记录，没有为截图隐藏或改写。
- 完整视图对照：`.test-results/affine-design-comparison/08-comparison-full.png`，2952×885。两张归一化图直接并排，源左、实现右；相同高度，宽度分别为1512与1440，没有拉伸。
- 侧栏细节对照：`.test-results/affine-design-comparison/09-comparison-sidebar.png`，488×460，源左、实现右。
- 行细节对照：`.test-results/affine-design-comparison/10-comparison-rows.png`，652×380，源上、实现下。
- 浏览器辅助证据：`.test-results/affine-design-comparison/05-browser-1024-en-dark.png` 与 `06-browser-workspace.png`，均1024×768，按1×截图检查。使用明确标记的示例数据，分别为英文深色项目库和工作台。

源与实现的业务、窗口宽度及内容不完全相同。用户授权的是将 AFFiNE 的桌面整合、紧凑密度、中性表面和层级原则用于三维重建项目库，不是复制文档、标签、收藏、标签页或某一文档列表。因此没有用逐像素误差或相同行数判定设计质量。

### 前轮对照发现与修复历史

| 轮次 | 发现与影响 | 修复及复核证据 |
| --- | --- | --- |
| 原始基线 | [P1] 大标题、统计块、固定环境列与重复侧栏元信息挤占真实项目；缺少桌面顶部整合。 | 取消大概览与常驻环境列，环境集中在设置；单一搜索/打开/新建工具区；60px 项目行；正常32px侧栏行；原生 Overlay 标题栏。原始 `02-metorigin.png` 与最终 `07-native-dark-final.png` 可追溯，最终层级在 `08-comparison-full.png` 确认。 |
| 初次原生启动 | [P1] 调试版自动打开 WebInspector，实际内容被压到近半窗口。 | Rust debug 启动仅在 `METORIGIN_OPEN_DEVTOOLS=1` 时打开 Inspector；重建 .app 后 `03-native-light.png`、`07-native-dark-final.png` 均没有 Inspector 占用。此项是原生界面占位缺陷，不以重编译本身算视觉通过。 |
| 首轮布局 | [P2] 有缺失路径的项目在侧栏扩成三行，多个真实异常连续出现时重新降低导航密度。 | `03-native-light.png`、`04-native-dark-before.png` 记录修复前状态；compact 改为32px标题+24px异常/修复同一行，总高56px。`07-native-dark-final.png` 及 `09-comparison-sidebar.png` 确认异常仍明确、修复入口可见，且不再三行展开。 |
| 分隔线检查 | [P3] 侧栏右边框和内容左边框相邻叠加。 | 已合并为单条分隔线，最终全图与侧栏细节未见双线。 |
| 最终复核 | 无新增 P0/P1/P2。 | 同时检查08完整构图、09导航、10行细节，以及05/06的1024×768英文状态、13最终浅色和12全屏状态；没有主操作被裁掉、文字碰撞或关键区域比例失衡。 |

### 前轮五项必查表面

| 表面 | 实际观察与结论 |
| --- | --- |
| 字体与排版 | `10-comparison-rows.png` 中标题与辅助路径的层级清楚：项目名14px/500、辅助路径12px，主标题18px，侧栏13px。本地 Inter 配合 macOS 系统/PingFang SC 回退；中文、拉丁字母、重音字符与emoji均可见。长名称单行省略，不挤压状态/日期；完整名称、路径保留title及相应无障碍描述。没有发现字重失衡、字形缺失或异常换行。字体并未声称与AFFiNE同源，只保留其清楚的层级。 |
| 间距与布局 | `08` 中项目列表占据主内容宽度，原大概览和280px环境列消失；240px侧栏、40px macOS顶栏与连续画布形成稳定框架。`09` 正常32px、异常56px；主行60px符合已选56–64px目标。源文档摘要行与目标项目路径行是不同内容，密度接近而非逐行复制。`05` 的64px图标栏、搜索、打开与新建均在1024px宽度内可见。 |
| 颜色与token | 最终深色画布为中性炭灰，hover/selected为中性灰，主要操作使用有限蓝色；正常状态低强调，失败与路径风险保留红/黄文字或图标。源AFFiNE更深且有材质差异，属于已接受的产品主题适配。最终浅色13显示相同层级，hover有可辨识中性底色，不依赖切换深色掩盖结构问题。没有宣称全部透明叠加状态已通过WCAG量测。 |
| 图片、图标与资产 | 保留真实MetOrigin应用图标和已安装Lucide图标，没有引入伪造缩略图、装饰插画或用CSS画面冒充项目预览。源AFFiNE工作区图标与目标品牌不同是有意适配。项目名中的emoji是用户真实内容，不是新增装饰。`06` 示例预览显式说明sample，不能当作真实模型渲染证据。 |
| 文案与内容 | 首页保留项目名称、路径末段、状态和更新时间，内容符合三维重建应用；硬件信息迁至设置，引擎不可用仍有入口。中文真实数据与英文预览均无明显截断的主操作。正常状态不反复占据侧栏多行；异常“路径已丢失/重新定位”没有因压缩而隐藏。保留真实异常，不将旧记录误写成成功或零。 |

### 前轮交互与构建证据

执行记录由主实现代理完成，本次独立复核额外读取了源文件、Tauri本地实现与原生构建日志：

- 搜索完整路径、打开/新建、侧栏菜单、折叠与抽屉、异常路径检查/重新定位、编辑器离开保护仍保留；相关自动化测试通过。
- 本轮相关40项测试通过；导航/侧栏/抽屉14项、Home9项、Settings10项分别验证，Settings新增未知磁盘值与有效零值区分。分批数字不汇总为一次全量运行。
- TypeScript与ESLint通过。完整前端构建及 `pnpm tauri build --debug --bundles app` 成功；实际日志为 `.test-results/affine-design-comparison/native-build.log`，产物为 `target/debug/bundle/macos/MetOrigin Splat.app`。
- 实际原生主题切换成功并恢复用户原浅色偏好；全屏进入、退出成功，12截图中主操作与侧栏可见。原生项目菜单打开后按Esc关闭并回到原trigger焦点已验证。标题栏双击后 `11-native-titlebar-zoom.png` 为3024×1772，而初始为2880×1770，证明窗口缩放响应。
- Tauri源码确认 macOS 专用标题栏配置不会移除Windows/Linux装饰；新增窗口权限对应内置拖拽与双击命令。这是实现检查，不等同于Windows/Linux实机验证。
- 浏览器已检查项目库与工作台渲染；主实现代理读取的控制台warn/error为空。临时viewport override已reset，浏览器恢复system语言和light主题后关闭临时预览tab；保留真实原生窗口。

### 前轮已接受差异与剩余限制

- 保留三维重建业务的任务状态、异常路径恢复和项目路径，不引入AFFiNE文档功能；不复刻AFFiNE品牌、暗色材质或绝对黑背景。
- 原生截图左上角有macOS控制状态紫色标识覆盖交通灯，不能确认交通灯精确视觉位置；不能把标题栏双击缩放证明写成拖拽已验证。
- 本轮未执行真实GPU训练、项目创建/重建恢复、Windows/Linux原生、跨设备WKWebView、读屏、forced-colors、200%缩放、长时资源测试。
- 浅色 `03-native-light.png` 是异常行修复前记录，最终紧凑行的浅色复核使用13；深色使用07。

### 前轮实施检查清单

- [x] 统一桌面壳与中性选择态，取消主页面外框卡片。
- [x] 合并首页主操作，移除大统计及固定环境栏。
- [x] 侧栏保持正常32px、异常56px，保留异常恢复入口与完整信息访问。
- [x] 主列表60px，长中英文名称/路径稳定截断，状态/日期对齐。
- [x] 打开源与实现合并图、侧栏/项目行细节图，完成五项表面检查。
- [x] 1024×768英文项目库与工作台截图检查，以及原生最终浅色、全屏和菜单Esc焦点恢复检查。
- [ ] 无系统覆盖时复核交通灯位置、实际拖拽和完整原生平台矩阵。
- [ ] 正式发布前完成真实任务、GPU、读屏与缩放验收。
