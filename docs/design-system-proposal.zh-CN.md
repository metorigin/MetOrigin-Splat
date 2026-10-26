# MetOrigin Splat 设计系统方案

**状态：Proposed / 待实施方案。日期：2026-10-21。**

这套规范面向本地 GPU 驱动的三维重建桌面工作台，采用 shadcn/ui 作为基础组件来源、Tailwind CSS 作为样式实现方式、Magic UI 作为有限动效来源。目标是让素材导入、长任务控制、模型检查和结果保存形成一致、可解释的操作体验。

本文规定目标设计，不代表组件、色值或布局已经落地。现有默认浅色、已保存主题偏好、中英文切换、后端状态与原生文件交互均应保持兼容。色彩对比、缩放表现和动效开销在实施后按文末验收，不能仅凭 token 值宣称通过。

## 产品定位与设计原则

[项目介绍](../README.zh-CN.md)定义的核心工作是将视频或照片通过 FFmpeg、COLMAP 和 Brush 在本机重建为 3D Gaussian Splatting 场景，并在 SuperSplat 中继续编辑。设计重心是场景、任务进展和操作后果。

| 使用角色 | 高频任务 | 界面必须帮助判断 |
| --- | --- | --- |
| 首次使用者 | 导入素材、检查环境、选择预设 | 是否能开始，问题如何修复，原文件是否受影响 |
| 重建操作者 | 运行、暂停、继续、切换查看项目 | 正在处理哪个项目，当前阶段，资源消耗，恢复边界 |
| 内容创作者 | 观察点云和模型、编辑、保存、导出 | 当前产物是否可用，修改是否保存，导出到哪里 |
| 排障使用者 | 查看失败步骤、日志、引擎配置和诊断 | 具体原因、保留产物、可执行的下一步 |

1. 让三维视口获得主要空间；面板承担解释与控制。
2. 每个当前任务区域只提供一个首要动作，次要动作通过位置与样式退让。
3. 当前浏览项目与全局正在运行的项目分别表达；切换页面不暗示任务停止。
4. 展示真实进度与测量值；未知、尚未测量、过期、估算必须可区分。
5. 使用颜色、图标和文字共同表达状态，避免单靠红绿或动画传递结果。
6. 通用控件保持稳定；领域信息通过组合组件表达，不在页面内重新发明按钮、弹窗和状态标签。

## 现有基础与设计缺口

当前已有语义色、深浅主题、键盘焦点和交互状态基础。迁移需要保留这些能力，同时建立可复用的组件与布局契约。

| 代码证据 | 处理方式 |
| --- | --- |
| [tokens.css](../apps/desktop/src/styles/tokens.css)含 57 行主题与表面 token | 保留蓝色识别，映射为 shadcn 语义 token，并补足域语义 |
| [buzz.css](../apps/desktop/src/styles/buzz.css)与[interaction-surfaces.css](../apps/desktop/src/styles/interaction-surfaces.css)合计 1111 行，存在相同选择器覆盖 | 逐模块迁移、逐模块删除旧规则，禁止长期靠加载顺序修补样式 |
| [ModalSurface](../apps/desktop/src/components/primitives/ModalSurface.tsx)与[useModalFocus](../apps/desktop/src/hooks/useModalFocus.ts)处理 Portal、焦点和背景 inert | 替换基础实现时保留初始焦点、关闭、返回焦点和嵌套模态行为 |
| [SettingsDrawer](../apps/desktop/src/components/settings/SettingsDrawer.tsx)第 78、180、197 行附近同时有即时保存、保存按钮及逐字符数值提交 | 用明确的字段保存策略替代混合模型 |
| [buzz.css](../apps/desktop/src/styles/buzz.css)第 217、218、457 行等使用 10px 辅助文字 | 关键状态与操作说明提升至至少 12px；最终可读性通过真实窗口验证 |
| [ModelEditorPage](../apps/desktop/src/pages/ModelEditorPage.tsx)第 131 行嵌入独立 iframe | 外层工作台与 SuperSplat 内部主题分别管理，CSS 不跨 iframe 自动生效 |

以上为代码事实。具体拥挤程度、视口比例和视觉层次应结合页面验收确认，不从源代码推断已经观察到的视觉缺陷。

## Token 架构与主题

Token 分为基础值、界面语义、业务语义三层。组件使用语义 token；只有主题文件可以直接引用色值。Tailwind 的 `bg-background`、`text-foreground`、`border-border` 等映射到同一份 CSS 变量，避免维护两套颜色源。

保留 [useTheme](../apps/desktop/src/hooks/useTheme.ts)的 `light | dark | system`、存储键和默认浅色行为。Tailwind 的 dark variant 直接映射已有 `data-theme`，不另建 `.dark` 状态或第二个主题 provider。

### shadcn 语义颜色

以下 HEX 是方案的可读基准，实施可等值转换为 OKLCH。`--input` 表示输入控件边框，不表示输入背景；危险按钮前景色作为本项目明确扩展保留。

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--background` | `#F6F7F9` | `#111318` | 页面画布 |
| `--foreground` | `#1F2937` | `#E8EDF5` | 主要文字 |
| `--card` | `#FFFFFF` | `#1D212A` | 静态面板 |
| `--card-foreground` | `#1F2937` | `#E8EDF5` | 面板文字 |
| `--popover` | `#FFFFFF` | `#242A35` | 菜单与浮层 |
| `--popover-foreground` | `#1F2937` | `#E8EDF5` | 浮层文字 |
| `--primary` | `#2563EB` | `#8AB4FF` | 首要操作 |
| `--primary-foreground` | `#FFFFFF` | `#102246` | 首要按钮文字 |
| `--secondary` | `#EEF1F5` | `#292F3A` | 次要控件表面 |
| `--secondary-foreground` | `#344154` | `#DFE6F1` | 次要控件文字 |
| `--muted` | `#EEF1F5` | `#292F3A` | 低层级表面 |
| `--muted-foreground` | `#596579` | `#AFB9C9` | 辅助文字 |
| `--accent` | `#E9F0FF` | `#243B60` | 选择与交互底色 |
| `--accent-foreground` | `#1D4ED8` | `#B5CEFF` | 选择状态文字 |
| `--destructive` | `#B52B3C` | `#FFA0AD` | 危险操作 |
| `--destructive-foreground` | `#FFFFFF` | `#40101C` | 危险按钮文字 |
| `--border` | `#DEE3EB` | `#353D4A` | 非交互分隔线 |
| `--input` | `#8692A5` | `#748196` | 控件识别边框 |
| `--ring` | `#2563EB` | `#8AB4FF` | 键盘焦点 |
| `--chart-1` | `#2563EB` | `#8AB4FF` | GPU 或主指标 |
| `--chart-2` | `#18744A` | `#7DD5A6` | 内存或次指标 |
| `--chart-3` | `#8A5A08` | `#F2C879` | 存储或第三指标 |
| `--chart-4` | `#7545B5` | `#C9A4F5` | 比较指标 |
| `--chart-5` | `#147987` | `#79CCD6` | 比较指标 |
| `--sidebar` | `#F0F2F5` | `#171A21` | 全局导航 |
| `--sidebar-foreground` | `#344154` | `#D5DFEE` | 导航文字 |
| `--sidebar-primary` | `#2563EB` | `#8AB4FF` | 导航主动作 |
| `--sidebar-primary-foreground` | `#FFFFFF` | `#102246` | 导航主动作文字 |
| `--sidebar-accent` | `#E1E9F7` | `#263950` | 当前导航项 |
| `--sidebar-accent-foreground` | `#1D4ED8` | `#B5CEFF` | 当前导航项文字 |
| `--sidebar-border` | `#DEE3EB` | `#353D4A` | 导航分隔线 |
| `--sidebar-ring` | `#2563EB` | `#8AB4FF` | 导航焦点 |

### 业务颜色与视口

| Token 或语义组 | Light | Dark |
| --- | --- | --- |
| `--success` / `--success-soft` | `#18744A` / `#EAF6EF` | `#7DD5A6` / `#19392B` |
| `--warning` / `--warning-soft` | `#8A5A08` / `#FFF4DA` | `#F2C879` / `#3D3120` |
| `--danger-soft` | `#FDECEF` | `#44262F` |
| `--info` / `--info-soft` | `#1D4ED8` / `#E9F0FF` | `#B5CEFF` / `#243B60` |
| `--input-background` | `#FFFFFF` | `#171D26` |
| `--primary-hover` | `#1D4ED8` | `#A6C6FF` |
| `--primary-active` | `#1E40AF` | `#76A5F5` |
| `--overlay` | `#10182866` | `#00000099` |
| `--viewport-background` | `#11161C` | `#11161C` |
| `--viewport-toolbar` | `#1E242C` | `#1E242C` |
| `--viewport-foreground` | `#D8E1EE` | `#D8E1EE` |
| `--viewport-muted` | `#AAB7CB` | `#AAB7CB` |
| `--viewport-border` | `#586779` | `#586779` |
| `--viewport-selection` | `#8AB4FF` | `#8AB4FF` |

`pipeline-running` 引用 info，`pipeline-completed` 引用 success，`pipeline-paused` 引用 warning，`pipeline-failed` 引用 destructive。资源图表颜色只区分数据系列；超过阈值才引入 warning/danger，并说明阈值含义。

视口保持独立暗色观察环境。工具栏、错误覆盖层和焦点环采用视口 token，不直接套用浅色主题。不得改变模型自身颜色来配合界面主题。图表始终保留图例、数值和非颜色区分方式。

## 字体与数值

| 角色 | 字号与行高 | 字重 | 使用范围 |
| --- | --- | --- | --- |
| 页面标题 | 24px / 32px | 600 | 项目中心、创建标题 |
| 区域标题 | 16px / 24px | 600 | 面板、设置分组 |
| 正文 | 14px / 22px | 400 | 表单、说明、错误恢复 |
| 紧凑正文 | 13px / 20px | 400 | 列表、工具栏、密集面板 |
| 标签与辅助文字 | 12px / 18px | 400 或 500 | 状态、单位、路径说明 |
| 摘要数字 | 24px / 30px | 600 | 完成汇总、概览 |
| 日志与技术值 | 12px / 18px | 400 | 日志、命令、详细参数 |

主字体沿用 `Inter Variable, Microsoft YaHei UI, Segoe UI, sans-serif`；日志用 `JetBrains Mono, monospace`，中文继续回退系统字体。正文不使用负字距；按钮 500，标题 600，避免任意字重扩散。

实时数值启用 `tabular-nums`，为百分比与单位预留宽度。二进制容量写 `MiB/GiB`，使用 `1024` 换算；若写 `MB/GB`，必须按十进制换算。容量默认一位小数，利用率默认整数，温度写 `°C`，迭代数带千位分隔。

未知值显示 `—` 并提供“尚未测量”等上下文；无效值不能回退成 `0`。耗时采用稳定的 `hh:mm:ss` 或本地化时长，时间戳保留精确时间详情。估算明确标注“预估”，单位和数字之间使用不换行空格。

## 间距与组件尺寸

空间基准为 4px，允许 2px 用于描边和图标微调。允许的间距为 `2、4、8、12、16、20、24、32、40、48、64px`；Tailwind 任意值只用于确有约束的视口尺寸和动态数据。

| Token 或规格 | 数值 | 规则 |
| --- | --- | --- |
| `--radius` | 8px | 全局基准 |
| radius-xs / sm / md / lg / xl | 4 / 6 / 8 / 12 / 16px | 小标记 / 控件 / 卡片 / 对话框 / 特殊外壳 |
| control-sm / md / lg | 32 / 36 / 40px | 工具栏 / 默认 / 创建主表单 |
| button padding-x | 12 / 14 / 16px | 随尺寸变化 |
| icon button | 32 或 36px 正方形 | 图标默认 16px；必须有名称 |
| input padding-x | 12px | 错误图标另预留空间 |
| list-row compact / default | 36 / 44px | 多行说明时允许增高 |
| table-row compact / default | 32 / 40px | 列头至少 36px |
| panel padding / page padding | 16–20 / 24px | 同级区域保持一致 |
| panel gap / section gap | 16 / 24px | 标题与内容间距 12px |

第一阶段只建立默认密度和组件级 compact 变体，不新增全局密度偏好。compact 不缩小正文至 12px 以下；触控输入设备的主要点击目标应扩大到 44×44px。Tailwind 的 radius 语义必须显式映射到表中数值，不直接依赖生成模板对单个 `--radius` 的默认加减公式。

静态面板默认无投影。popover 使用 `0 8px 24px #1018281F`，dialog 使用 `0 20px 64px #10182833`；深色分别采用 `#00000066`、`#00000088`。投影不能替代边框识别。

根层级为内容0、sticky10、页面popover30、模态overlay40、dialog50。Dialog 内的 Select/Menu/Popover 挂到当前模态容器并高于其内容，不复用页面popover30而被遮罩盖住。嵌套模态由统一管理器相对父层增加10；toast与tooltip相对活动顶层分配，不硬编码一个会被后续模态遮住的全局值。背景页面的tooltip/menu随模态打开而关闭；不能用随机增大z-index解决焦点问题。

## 桌面布局与页面规范

[Tauri 配置](../apps/desktop/src-tauri/tauri.conf.json)当前默认 1440×1024，最小 1024×768。下面尺寸采用 CSS 像素；必须同时测试 Windows 缩放后的真实 WebView 可用面积，不能把物理窗口尺寸当作可用内容尺寸。

| 区域 | 默认规格 | 空间不足时 |
| --- | --- | --- |
| 全局侧栏 | 240px，折叠 56px | 优先折叠，入口保留 Tooltip |
| 工作区顶栏 | 最小 56px | 操作进入更多菜单，标题可截断 |
| 项目运行栏 | 64–88px，允许两行 | 仍保留运行对象、状态和主操作 |
| 系统状态栏 | 28px | 次要硬件信息进入详情，错误入口保留 |
| 右侧 Inspector | 默认 320px，可调 280–400px | 切换为 Sheet，保存用户显隐选择 |
| 视口 | 宽度目标至少 560px，高度目标至少 360px | 切换布局，不用压缩文字换取空间 |
| 日志区域 | 默认折叠；展开默认 240px | 可调高度，与视口共享可用空间 |
| 普通 Dialog | 480 或 640px | `max-width: calc(100vw - 32px)` |
| 设置 Dialog | 760px，目标高 640px | 高度受可用视口约束，正文滚动 |

响应以内容可用空间为依据：1440 级完整布局；1200 级压缩次要留白；1024 级折叠侧栏并可隐藏 Inspector。低于可用布局阈值时继续提供可滚动/切换的内容，不能直接隐藏主操作。优先使用容器查询承接侧栏和面板拖动造成的变化。

### 项目中心

主内容展示最近项目、搜索和当前运行任务；新建项目是首要操作，打开项目是次要操作。最近项目行包含名称、来源或路径、状态、更新时间和更多操作。运行环境作为次级区域，故障时提升优先级。

无项目、搜索无结果、加载失败、显示缓存列表分别有独立文案与动作。列表记录存在而本地目录丢失时显示“需要重新定位”，不能混同重建失败。首屏不以大面积装饰卡片挤压项目列表。

### 创建项目

保留“选择素材 → 分析与检查 → 确认创建”三步。步骤条和底部操作区稳定，正文独立滚动；内容最大宽 1120px，默认主内容加帮助侧栏，空间不足时帮助内容折叠。

素材选择后展示可读文件范围、数量与预览。warning 允许继续，blocker 明确阻止继续并提供修复入口。返回上一步保留已选素材与参数；参数改变后，旧预检结果不能继续作为当前有效结论。

最后一步明确项目名、实际保存路径、磁盘预估、预设和是否立即开始。复制过程中显示真实字节进度、取消状态与结果；关闭时延续现有未完成创建保护，不把后台取消过程误报为已取消。

### 重建工作台

顶部显示项目身份、当前状态和运行控制；四个阶段摘要位于视口上方，12 个具体步骤按需展开。Inspector 放阶段产物、质量结果与资源指标。日志承担排障，不占据默认主视觉。

查看非运行项目时，全局任务摘要标明正在运行的项目，并提供“返回运行项目”。开始新任务受现有单任务约束，冲突提示说明占用项目，不能创建并不存在的后台排队体验。

视口顶部提供视图模式、重置视角和必要显示选项；底部显示交互提示与产物更新时间。更新模型时保留现有画面和相机状态，失败时尽可能保留最后可用结果。

### 模型编辑与设置

编辑页保留项目名、返回、保存状态和保存按钮，最大化画布。外层负责加载、初始化失败、未保存退出和保存回执；内部 SuperSplat 的组件更换需要独立评估。不能把“外层已换主题”算作编辑器内部完成迁移。

设置使用“常规、引擎、性能与存储、外观、诊断”五类。语言和主题归外观；默认重建预设与创建后启动归常规；引擎路径与检测归引擎。可见分类文字与无障碍名称完全一致。

## 组件层次与 API 契约

`components/ui` 存放 shadcn 基础组件，`components/domain` 放跨页面领域组合，`components/motion` 承接项目动效封装。迁移期间保留现有 `shell/settings/workspace` 业务边界；最终目录按[迁移方案](frontend-migration-plan.zh-CN.md)逐模块收敛，不同时再建职责重复的 patterns 层。

| 组件 | 关键 API | 默认外观与行为 |
| --- | --- | --- |
| `Button` | `variant: default/secondary/outline/ghost/destructive/link`；`size: sm/default/lg/icon`；标准按钮属性 | 默认 h36；loading 由应用封装提供，不伪称 shadcn 原生属性 |
| `ActionButton` | `pending`、`pendingLabel`、`disabledReason`、`onAction` | 保留宽度；pending 不重复提交；原因可被键盘用户读取 |
| `IconAction` | `label`、`shortcut?`、`pressed?` | Tooltip 与 accessible name 同源；默认 32px |
| `Field` | `label`、`description?`、`error?`、`required?`、`controlId` | 说明与错误关联控件；不靠占位文字替代标签 |
| `NumericSetting` | `value`、`min`、`max`、`step`、`unit`、`onCommit` | 本地编辑草稿，确认后提交，不逐字符写后端 |
| `StatusBadge` | `tone`、`label`、`icon?` | h24，12px；图标与文字共同表达含义 |
| `PipelineStatusBadge` | `status: ProjectStatus`、`reason?` | 统一映射，页面不可自行改写同一状态名称 |
| `ResourceMeter` | `value: number/null`、`max?`、`unit`、`freshness` | 真实数值为主；未知不画成零；阈值由领域配置提供 |
| `AsyncBoundary` | `resource`、`onRetry`、`empty`、`children` | 首次加载骨架，刷新保留内容，过期显示时间与重试 |
| `PathField` | `path`、`onBrowse`、`onReveal?`、`validation` | 保留原生选择器；长路径可复制、查看完整值 |
| `SceneViewport` | `artifact`、`loading`、`error`、`updatedAt`、`onRetry` | 容器统一，渲染器生命周期保持独立 |
| `PipelineTimeline` | `snapshot`、`selectedStage`、`onSelectStage` | 四阶段概览与12步骤来自现有定义 |
| `ActionResultNotice` | `result`、`onDismiss`、`action?` | 成功可短暂提示；失败保留到用户处理 |

基础映射：ModalSurface → Dialog/AlertDialog；侧向补充信息 → Sheet；手写菜单 → DropdownMenu；分类 → Tabs；折叠详情 → Accordion/Collapsible；选择预设 → RadioGroup 或 Select；即时开关 → Switch；勾选确认项 → Checkbox。

布局映射：Inspector 与日志 → Resizable；稳定滚动区域 → ScrollArea；阶段百分比 → Progress；可恢复错误 → Alert；操作成功回执 → Sonner。Sonner 不能承担唯一的阻断错误或删除影响说明。

设置窗口虽然现名 `SettingsDrawer`，目标形态是 Dialog；不要为了名称机械选 Sheet。保留 `WorkspaceActionDialog`、`DeleteProjectDialog`、`CheckpointDrawer`、`ActivityWorkbench` 等业务边界，替换其内部基础组件。

所有可交互组件统一支持 default、hover、focus-visible、active、disabled；异步组件再支持 pending、success、error。选中状态与 hover 分开，loading 与 disabled 原因分开。图标来源统一 Lucide，默认 16px、stroke 1.75；不再暴露实际不生效的 `weight="fill"`。

## 任务状态与数据新鲜度

当前 [ProjectStatus](../apps/desktop/src/types/project.ts)是 **11 个项目状态**，[StageStatus](../apps/desktop/src/types/pipeline.ts)是 **10 个步骤状态**；**12** 指具体步骤 ID 数量。设计直接复用这些类型，不引入新的运行状态框架。

| 项目状态 | 中文显示 | 视觉语义 | 操作规则 |
| --- | --- | --- | --- |
| `creating` | 创建中 | info + 进度 | 只暴露现有创建取消能力 |
| `starting` | 正在启动 | info + pending | 防重复启动，等待权威回执 |
| `ready` | 就绪 | neutral | 可开始，仍受环境与全局任务约束 |
| `running` | 运行中 | info | 按已有能力暂停或取消 |
| `pausing` | 正在暂停 | info + pending | 不提前显示“已暂停” |
| `paused` | 已暂停 | warning | 有效恢复条件满足后可继续 |
| `cancelling` | 正在取消 | info + pending | 等待进程停止与保留结果确认 |
| `cancelled` | 已取消 | neutral | 展示保留数据及允许的恢复方式 |
| `recovering` | 正在恢复 | info + pending | 防重复恢复，显示当前恢复步骤 |
| `completed` | 已完成 | success | 查看、编辑、导出有效结果 |
| `failed` | 失败 | destructive | 显示原因、失败步骤、重试或修复 |

步骤状态的 `pending/preparing/running/pausing/paused/cancelling/cancelled/completed/failed/skipped` 分别显示“待处理/准备中/运行中/正在暂停/已暂停/正在取消/已取消/已完成/失败/已跳过”。`skipped` 是中性缓存复用结果，不能用相同成功图标冒充执行完成。

四组12步骤按 [projectTimeline.ts](../apps/desktop/src/pages/projectTimeline.ts)和后端实际事件排序渲染；分组名称可审查调整，但不能仅改显示顺序伪造真实执行顺序。

| 分组 | 具体步骤 ID | 展示内容 |
| --- | --- | --- |
| 素材准备 | `MediaValidation`、`FrameExtraction`、`ImagePreprocessing` | 素材有效性、帧数、准备产物 |
| 相机重建 | `ColmapFeatureExtraction`、`ColmapMatching`、`ColmapMapping`、`ColmapValidation` | 匹配、相机、稀疏点云与质量 |
| 高斯重建 | `TrainingPreparation`、`BrushTraining`、`ModelValidation` | 训练进度、可用快照与模型校验 |
| 结果输出 | `PreviewGeneration`、`Export` | 预览和输出有效性；执行顺序以实际事件为准 |

进度已知才设置 `aria-valuenow`；未知使用 indeterminate。0% 与未知不同，显示来源阶段和最后更新时间；暂停/失败保留真实最后进度。只把已完成任务显示为100%，不得使用时间驱动的假进度补齐。

[AsyncResource](../apps/desktop/src/types/async.ts)与任务状态正交：任务仍可运行，而某块资源数据已经过期。复用已有 freshness/completeness 元数据，不把接口刷新失败改成任务失败。

| 资源状态 | 显示规则 | 动作 |
| --- | --- | --- |
| `idle` | 等待条件满足，不显示错误 | 提示所需前置条件 |
| `loading` | 首次加载用对应结构 Skeleton；操作处可 busy | 不遮挡无关区域 |
| `success` | 显示当前内容 | 正常操作 |
| `refreshing` | 保留内容，局部弱提示更新中 | 避免重置滚动和焦点 |
| `stale` | 保留最后成功内容，显示更新失败和时间 | 提供局部重试 |
| `error` | 没有可用内容时显示 ErrorNotice | 给出重试或修复入口 |

`completeness: partial` 显示缺失范围，不让完整可用的区域一起消失。高频进度变化不逐条播报；辅助技术只播报阶段变化、暂停完成、失败、完成和需要用户行动的事件。

## 表单保存与危险操作

主题、语言和简单偏好即时保存，界面保留“保存中/已保存/保存失败”的局部结果；失败不默默丢掉用户选择。数值、路径组合和依赖多字段的配置使用本地草稿及“应用”提交，校验后一次保存相关字段。

数值允许暂时清空和输入中间值，提交时检查有限数、整数要求及 min/max。不能将空串经 `Number("")` 直接保存为0。请求按字段组串行或带版本控制，旧回执不能覆盖更新的选择。

“应用”在无修改时禁用；成功后清除 dirty，失败保留草稿与可重试动作。关闭有未应用草稿的设置分组时提示继续编辑或放弃。已即时保存的设置不再附一个语义不明的总保存按钮。

危险操作使用 AlertDialog：标题写具体动作，列出项目名、完整路径、影响产物、不可撤销性及保留项。默认焦点落在取消；主按钮写“永久删除”等实际动词，不写笼统“确定”。

沿用 [WorkspaceActionDialog](../apps/desktop/src/components/workspace/WorkspaceActionDialog.tsx)的影响预览与可执行性校验。预览过期或作用对象变化时重新获取并提示，不使用旧预览执行；执行中阻止重复提交和误关闭，完成后展示真实结果。

删除与从最近列表移除必须分开命名；取消重建与删除项目不能共享一个危险按钮。错误结果留在原上下文，展示实际保留/删除结果，不通过动画或成功 toast 推测成功。

## Magic UI 与动效规范

Magic UI 只作为白名单组件来源。业务页面通过应用封装使用，不能直接复制任意动效并自定时长。shadcn 负责控件交互，CSS 负责简单状态过渡，Motion 只负责需要生命周期控制的入场与退出。

| 动效类别 | 实现方式 | 时长与限制 |
| --- | --- | --- |
| hover、focus、pressed | CSS transition | 100–120ms；仅颜色、边框、opacity |
| Popover、Dialog、Sheet | 基础组件 data-state + CSS，必要时统一 Motion | 160–200ms；位移4–8px；不能双重播放 |
| 页面初次内容入场 | Magic UI BlurFade 的应用封装 | 160–200ms；只播放一次，blur关闭，位移不超过4px |
| 低频完成汇总数字 | Magic UI NumberTicker 的应用封装 | 最多400ms；仅任务完成汇总，禁用于进度、GPU、VRAM、日志计数 |
| 有限结果通知 | Magic UI AnimatedList 的应用封装 | 最多3条，单条160ms；不用于原始日志流 |
| 真实未知进度 | Progress 或 Spinner | 与真实请求生命周期绑定 |

统一 easing 为 `cubic-bezier(.2,.8,.2,1)`；尺寸调整优先直接响应，不用动画追赶拖动。禁止动画改变视口相机、模型颜色或精确数据含义。不要同时用 CSS 与 Motion 控制同一元素的 transform/opacity。

工作台白名单不包含 BorderBeam、ShineBorder、Meteors、Particles、Marquee 等持续装饰效果。任务完成无需彩纸庆祝；一次有限的完成反馈足够表达结果。

全局动效策略读取 `prefers-reduced-motion`、`document.visibilityState` 和当前实际训练/预览状态。CSS 媒体查询不能替代 Motion/JS 动画的显式停止。NumberTicker 源码需要适配当前 locale、语义文字色和静态辅助文本；`MotionConfig reducedMotion="user"` 不能单独覆盖 blur、数字滚动等所有效果。[NumberTicker源码](https://magicui.design/r/number-ticker.json)、[Motion无障碍说明](https://motion.dev/docs/react-accessibility)。

- reduced-motion：禁用位移、缩放、blur、数字滚动和列表重排动画；直接显示最终值，保留静态忙碌说明。
- 页面隐藏：停止装饰循环与入场计时；返回时读取当前状态，不补播错过的动画序列。
- 训练或持续渲染：装饰动画预算为0；只保留必要操作反馈，不用动效争抢 GPU 合成资源。
- 高频数据：文本按数据更新，界面按合理节流展示；进度过渡不得积压或落后于最新真实值。
- 首次加载后不得因轮询、语言切换或窗口 resize 重放整页入场。

动效验收比较关闭与开启白名单动效的 CPU/GPU、长任务和视口帧时。预算是设计限制，性能改善需实测；稳定性不足时删除动效，不降低模型预览质量补偿。

## 无障碍与中英文本

普通文字目标对比度至少4.5:1，大字至少3:1；必需的控件边界、状态图形和焦点指示目标至少3:1。`focus-visible` 使用2px ring与2px offset；以上色值尚需在实际相邻背景、hover和选中状态下测量。

本次按sRGB相对亮度公式计算了12种基础文字/背景组合的明暗两套值，共24组，最低5.17:1，均超过4.5:1。范围涵盖正文、卡片、浮层、主/次/危险按钮、弱文字、选择态、侧栏及视口；不涵盖透明叠加、禁用态、图表、控件边界与最终渲染，因此不能据此宣称完整WCAG合规。计算结果保存在本地审查目录的 `token-contrast.json`。

所有操作可用键盘完成。Tabs/菜单采用基础组件的键盘模型，避免保留另一套手写 roving focus；Dialog 由同一个焦点管理器负责 trap、Escape、返回焦点和背景隔离。原生文件对话框关闭后焦点回到触发按钮。

图标按钮必须有可读名称；Tooltip 作为补充说明。禁用动作的原因在附近可读取，不能只依赖不可聚焦的 disabled 按钮 Tooltip。图标若只作装饰则隐藏于无障碍树。

错误通过文本与 `aria-describedby` 关联字段；提交失败聚焦首个错误或错误摘要。非紧急更新用 polite，阻断失败用 assertive；进度值、日志和资源数字不持续打断阅读。

中英文继续沿用 [现有本地化机制](localization.md)。文案完整进入翻译资源，不拼接依赖中文语序的片段；时间、数字、复数按 locale 格式化。可见 label 与 accessible name 共享同一翻译值。

按钮预留英文增长空间，不给“开始重建”等操作写固定窄宽度；路径允许断行或中间省略，并提供完整值和复制。中文标点与英文句式分别维护，错误技术码保留原值。

布局验收覆盖200%文本/页面缩放下的可达性：允许折叠、滚动和重新排布，关键按钮与错误说明不能永久消失。支持 forced-colors；状态不能依赖背景色或 box-shadow 单独表达。

## 组件治理与验收

每个基础组件必须有用途、允许变体、尺寸、键盘模型、状态示例和禁止事项。新增变体先判断能否复用既有语义；不为单个页面增加 `special-blue` 等样式接口。

shadcn 与 Magic UI 引入的源码记录来源、获取版本和本地修改。只导入需要的组件，更新时审查差异；业务代码不直接依赖上游示例目录。基础组件与业务组件之间通过明确 props 连接，不引入新的状态框架。

建立组件展示页或等价可复现 fixture，覆盖明暗主题、中文英文、默认紧凑尺寸和所有交互状态。设计 token 是唯一来源；新增原始色值、任意 z-index 和全局元素规则必须说明理由。

| 验收对象 | 必须通过的场景 |
| --- | --- |
| 基础控件 | default、hover、focus、pressed、disabled；异步控件含 pending/error |
| 工作台状态 | 11项目状态、10步骤状态、12步骤定位与实际产物对应 |
| 数据状态 | 首次加载、后台刷新、stale、partial、无数据、局部失败 |
| 窗口与缩放 | 1024×768与1440×1024；Windows125%/150%；200%可达性 |
| 语言与内容 | 中英文、长项目名、长路径、大数字、缺失指标 |
| 浮层与键盘 | 菜单→Dialog、嵌套模态、Escape、返回焦点、原生文件选择 |
| 表单 | 中间输入值、越界、保存失败、并发回执、dirty退出 |
| 危险操作 | 影响预览过期、对象变化、重复点击、部分失败和真实回执 |
| 三维视口 | 调整面板尺寸、切项目、更新快照、加载失败与最后可用画面 |
| 动效 | reduced-motion、隐藏页面、训练中、长时间运行 |
| 性能 | 与迁移前同场景基线比较，隔离UI开销和渲染器开销 |

迁移完成的标准是所有实际使用页面遵循这套语义与组件契约，并清理对应旧样式；安装三个库不等于完成设计系统。SuperSplat 内部、真实原生文件交互与 GPU 预览需要各自的集成验收，不能用纯浏览器示例替代。
