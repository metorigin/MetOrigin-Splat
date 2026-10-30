# MetOrigin Splat 设计系统

> 2026-10-29 实施更新：当前主题和组件基于 Jan 固定提交 `b8d58255baf6d9e870025d3f0c60a5b80a63143b`，同源设计值位于 `integrations/jan/theme.json`。用户最新桌面红框参考优先于 Jan 浮动容器：采用左上窗口导航/左下全高侧栏、右上项目页头/右下内容四区齐边结构，不使用网页式外边距和大圆角页面卡片。NumberTicker/Magic UI 与 Motion 已移除，结果数值静态本地化显示；内嵌编辑器通过静态适配和受校验主题协议迁移内部 UI。以下此前章节中的蓝色、浮动壳、Magic 动效或“编辑器未迁移”描述为历史基线，当前实现及未验限制以迁移记录第 9–10 节为准。


历史范围：以下第 1–8 节保留 2026-10-28 的宿主界面实现与验证事实，其中“当前”“实际”等表述均指当时版本；第 9 节为现行 Jan 规范。原生平台、读屏、缩放和性能验收仍以[迁移记录](frontend-migration-plan.zh-CN.md)为准。

当时后续规划的 Jan 全页面迁移目标主题、布局及 SuperSplat 内部适配见[前端迁移方案第 9 节](frontend-migration-plan.zh-CN.md)。以下历史章节继续描述当时实现；现行规范以第 9 节为准。

系统面向本地三维重建桌面工作台：shadcn/ui 提供可维护的基础组件源码，Tailwind v4 表达样式，Magic UI 仅提供完成汇总数的有限动效。页面围绕素材、真实任务进展、模型检查与保存后果组织，不以持续装饰抢占三维预览资源。

## 1 实际结构和设计原则（历史）

应用采用连续的桌面工作区、紧凑导航、中性悬停与选择态、少量蓝色主要操作，以及独立暗色三维视口。侧栏和内容以单条轻分隔线区分，取消包围主页面的圆角边框卡片。本地 Inter 与 JetBrains Mono 保留，中文在 macOS 使用系统 PingFang SC 回退。主题沿用 `light | dark | system` 及既有存储键，默认浅色，`html[data-theme]` 是唯一生效源。

1. 三维视口获得主要空间，Inspector 解释产物和资源，日志按需打开。
2. 当前浏览项目与全局活动项目分别表达，切页不暗示停止任务。
3. 数值与进度来自真实状态；未知、过期、失败和部分可用不能伪装为零或成功。
4. 状态同时使用文字和必要图标，颜色只是补充。
5. 通用交互复用基础组件；原生任务、文件与 renderer 继续由原服务边界管理。

实际组件分为 `components/ui`、`components/magicui`、`components/motion`，业务组合继续放在 `shell/settings/workspace/feedback` 与页面中。没有为未使用的抽象创建 `ActionButton`、`Field`、`ResourceMeter` 等第二套接口。

## 2 Token 与主题（历史）

[app.css](../apps/desktop/src/styles/app.css)是宿主唯一入口；[tokens.css](../apps/desktop/src/styles/tokens.css)提供语义色；[workspace.css](../apps/desktop/src/styles/workspace.css)提供阶段、活动、视口等领域布局规则。CSS 层为 Tailwind 的 theme/base/components/utilities，旧全局按钮/表单样式已经删除。

Tailwind `bg-background`、`text-foreground`、`border-border` 等映射到同一 CSS 变量。`--bg-panel`、`--text-secondary` 等保留的 renderer/domain 别名也引用这份变量，不构成第二套主题。

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--background` | `#F7F7F8` | `#1D1E22` | 应用画布 |
| `--foreground` | `#25262B` | `#EDEDF0` | 主文字 |
| `--card` | `#FFFFFF` | `#242529` | 面板 |
| `--card-foreground` | `#25262B` | `#EDEDF0` | 面板文字 |
| `--popover` | `#FFFFFF` | `#2B2C31` | 菜单与浮层 |
| `--popover-foreground` | `#25262B` | `#EDEDF0` | 浮层文字 |
| `--primary` | `#2563EB` | `#8AB4FF` | 主要操作 |
| `--primary-foreground` | `#FFFFFF` | `#102246` | 主要操作文字 |
| `--secondary` / `--muted` | `#F0F0F2` | `#303137` | 次级表面 |
| `--secondary-foreground` | `#41434B` | `#DEDEE3` | 次级操作文字 |
| `--muted-foreground` | `#686B75` | `#A8A9B3` | 辅助说明 |
| `--accent` | `#EEEEF1` | `#34353C` | 中性悬停与选择背景 |
| `--accent-foreground` | `#25262B` | `#E0E0E8` | 选择文字 |
| `--destructive` | `#B52B3C` | `#FFA0AD` | 危险与错误 |
| `--destructive-foreground` | `#FFFFFF` | `#40101C` | 实色危险面的文字 |
| `--danger-soft` | `#FDECEF` | `#44262F` | 危险按钮与提示的柔和背景 |
| `--border` | `#E6E6E9` | `#37383E` | 分隔线 |
| `--input` | `#8692A5` | `#748196` | 输入边框 |
| `--input-background` | `#FFFFFF` | `#222327` | 输入背景 |
| `--ring` | `#2563EB` | `#8AB4FF` | 焦点 |
| `--success` / `--success-soft` | `#18744A` / `#EAF6EF` | `#7DD5A6` / `#19392B` | 成功与可用 |
| `--warning` / `--warning-soft` | `#8A5A08` / `#FFF4DA` | `#F2C879` / `#3D3120` | 暂停、风险与待处理 |
| `--sidebar` | `#F5F5F7` | `#1E1F23` | 导航背景 |
| `--sidebar-foreground` | `#41434B` | `#D5D5DD` | 导航文字 |
| `--sidebar-accent` | `#E8E8ED` | `#303137` | 当前导航项 |
| `--sidebar-accent-foreground` | `#25262B` | `#E0E0E8` | 当前导航文字 |

三维视口不随浅色主题变白：`--viewport-background: #11161C`、toolbar `#1E242C`、foreground `#D8E1EE`、muted `#AAB7CB`、border `#586779`、selection `#8AB4FF`。这些颜色用于宿主控件，不修改模型本身颜色，不穿透 SuperSplat iframe。

不得新增无语义的页面专属颜色。尚未使用的 chart token、全局密度设置和其他主题值不预先添加，按真实需求审查。

## 3 字体、间距与控件尺寸（历史）

| 角色 | 当前约定 |
| --- | --- |
| 页面标题 | 项目库 18px semibold；其他页面按内容层级使用 18–24px |
| 面板标题 | 14–16px，semibold |
| 正文/表单 | 14px，必要时 13px 紧凑正文 |
| 状态/路径/日志 | 通常 12px；侧栏紧凑修复按钮 11px；重要错误保留完整说明与恢复入口 |
| 数值 | 使用 `tabular-nums`；时间、整数按 locale 格式化 |
| 容量 | 1024 换算时写 MiB/GiB；0 是有效数值，未知显示说明 |
| 空间基准 | 4px；常用 8/12/16/24/32px；项目库行高 60px，侧栏正常行 32px、路径异常行 56px |
| 圆角 | sm 6px、md 8px、lg 12px、xl 16px；`--radius` 基准 8px |
| Button 高度 | xs 24px、sm 32px、default 36px、lg 40px |
| 图标 Button | 24/32/36/40px 对应 icon-xs/icon-sm/icon/icon-lg；窗口导航使用28px触发器、16–17px图标；必须有名称 |

默认字体为本地 `Inter Variable, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei UI, Segoe UI, sans-serif`；技术值为 `JetBrains Mono, monospace`。按钮文字避免固定窄宽度，保留英文增长空间。长路径可换行或省略，完整值必须能在上下文获取。

基础层提供可见焦点描边，组件可在此基础上使用 ring。Dialog/Menu 层级由 Radix 的 Portal 与本地容器上下文组合，不能随意追加 z-index 修复焦点问题。模态中的 Tooltip/Menu 必须挂在当前模态容器内。

## 4 基础组件契约（历史）

完整来源及改动见[ui-sources.json](../apps/desktop/ui-sources.json)和[组件维护说明](../apps/desktop/src/components/ui/README.md)。

| 组件 | 实际接口或约定 |
| --- | --- |
| Button | `variant=default/secondary/outline/ghost/destructive/warning/link`；默认 `type=button`；标准 disabled/aria 属性；pending 由业务状态驱动 |
| Input / NativeSelect / Label | 保留原生输入、选择和 IME 行为；label 与控件通过 id 关联 |
| Checkbox / Switch | Radix 状态；确认事项用 Checkbox，即时布尔偏好用 Switch |
| Badge | `success/warning/destructive` 等语义变体，显示真实文字；不能靠颜色区分任务结果 |
| Progress | 将真实 value 传到 Radix；未知为 null，视觉范围限制 0–100；不能用未知值伪造 0% |
| Tabs / Collapsible | Radix 键盘和展开状态；用于设置分类、活动筛选、阶段详情和帮助 |
| DropdownMenu / Tooltip | Radix 行为；嵌套模态 Portal 通过 OverlayContainerContext 指定容器 |
| Alert / Card | 内容结构与语义样式；阻断错误应保留到用户处理 |
| Dialog / ModalSurface | Radix 负责 focus trap；应用适配负责 busy、初始焦点、返回目标、危险操作外部关闭限制 |
| Resizable | 对 react-resizable-panels 3.0.6 的本地适配；panel 节点稳定，不借拖动重新创建 renderer |

AlertDialog、Sheet、Separator、Skeleton 已作为源码基础组件纳入；当前业务模态主要通过 `ModalSurface` 使用 Dialog，不为了目录名称机械换成 Sheet。当前未引入 Sonner、ScrollArea、自定义 Select、RadioGroup 或 Accordion。

同一弹层只能有一个焦点管理器，旧焦点 hooks 已删除。`ModalSurface` 关闭时恢复 opener，失效时使用调用点的 fallback；busy 禁止 Escape/外部关闭并保持可用焦点。`role=alertdialog` 阻止点遮罩取消。删除、恢复和重跑仍由原业务确认流程决定是否执行。

DropdownMenu 在 Radix 默认行为基础上，通过 `DesktopMenu` 保留桌面键盘约定，例如 ArrowUp 进入末项和 Tab 退出。全局快捷键忽略输入及活动弹层，防止菜单打开时触发背景命令。

## 5 页面组合（历史）

| 页面/区域 | 当前布局与关键约束 |
| --- | --- |
| 项目中心 | 单一搜索/打开/新建工具区，60px 最近项目主列表；标题14px/500，辅助路径12px；总数与完成数为小字；环境集中在设置，引擎异常仍在首页提醒 |
| 创建向导 | 选择素材 → 预检与参数 → 确认创建；主体滚动、底部动作明确；返回保留草稿，参数修改使旧预检失效 |
| 外壳 | 40px一体窗口导航，侧栏开关/后退/前进使用28px按钮；macOS叠加原生交通灯，侧栏色块延伸至顶部；240px侧栏可折叠为64px，窄窗开关打开受控项目抽屉；正常项目一行、异常路径增加一行可操作提示 |
| 工作台 | 四阶段摘要与展开步骤；场景、Inspector 使用可调面板；窄窗详情为独立模态，视口节点不跟随迁移 |
| 活动/日志 | 独立可滚动区域；Tabs 筛选、搜索 debounce、后端 cursor 分页、选择详情、自动跟随与回到最新 |
| Checkpoint | 共享模态、真实检查点与恢复条件；未满足条件不能用样式假装可恢复 |
| 设置 | 常规、引擎、性能与存储、外观、诊断；Dialog 内容滚动；可见分类名即无障碍名称 |
| 模型编辑 | 宿主返回/保存/错误/离开保护统一；内部 SuperSplat UI 保留固定上游实现 |

原生默认窗口 1440×1024、最小 1024×768。`DesktopTitlebar` 在各平台呈现40px应用导航；macOS为原生交通灯预留左侧84px，Windows/Linux保留系统标题栏且不增加这段空白。28px侧栏/后退/前进按钮与空白拖拽区域分离；顶部不重复页面标题，也不再使用横贯窗口的底边框。顶部左侧背景跟随240/64px侧栏宽度，右侧跟随当前页面background/card；按钮不受64px折叠轨道宽度约束。调试版不再默认打开 WebInspector，需要时设置 `METORIGIN_OPEN_DEVTOOLS=1`。设置窗口当前最大 800px 宽、720px 高，并受 viewport 留白限制；工作台在 1120px 及以下切换 Inspector 呈现。页面应允许缩小、折叠和滚动，不能隐藏主操作；这些源码约束还需配合真实 WebView/DPI 与 200% 缩放验收。

数值设置在本地保存草稿，日志上限验证 64–4096，缩略图缓存验证 64–8192，显式保存后再采用后端回执。即时偏好和主题语言使用既有保存机制；保存失败保留上下文供重试，不将输入中间态写入后端。

窗口导航使用最多50项内存页面历史，同页不重复入栈，后退后普通跳页截断forward；移除项目清理历史，重新定位更新历史路径。创建向导是瞬态流程，不入历史，保留自己的草稿与安全取消出口；向导中工具栏导航禁用。编辑器前后退必须经过`editor.leave()`并在确认关闭后更新历史。App持有compact断点和抽屉状态，确保顶部开关、侧栏与焦点恢复使用同一状态源。

## 6 任务、异步与错误语义（历史）

继续复用已有 ProjectStatus、StageStatus、TaskProgress 和异步资源类型。项目创建、运行、暂停中、暂停、取消中、取消、恢复、完成和失败的展示由后端状态与现有派生函数决定，不另建 UI 状态机。

- `loading` 显示载入说明；`refreshing` 保留既有数据；`stale` 明确上次成功数据与重试入口。
- 暂停中/取消中不是已暂停/已取消，成功回执必须来自后端结果。
- warning 可继续的路径与 blocker 阻止的路径分别表达。
- 字段错误有文本及关联；操作错误使用 ErrorNotice，不能只靠暂时消失的通知。
- 诊断文本沿用脱敏规则，原始引擎输出不在 UI 中随意泄露。
- 事件查询以 query generation 同时保护显示数据、cursor 与 refs，旧请求不能覆盖新筛选结果。
- Progress 只显示有分母的真实进度；没有数据时显示未知说明，不用装饰动画生成百分比。

模型更新失败尽可能保留最后有效模型和用户相机；编辑会话的 dirty、保存和离开检查不因主题、语言或布局迁移而改变。UI 预览中的模拟任务数据始终明确标记，不能当成实际 GPU 或原生任务结果。

## 7 Magic UI 与减少动效（历史）

白名单当前只有 **NumberTicker**，唯一业务入口是 `ResultNumber`。它用于项目中心“已完成项目数”的真实变化，首次渲染静态显示，动画最长 350ms。Motion 按需 lazy 加载，动画可停止并正确清理监听器。

| 情况 | 行为 |
| --- | --- |
| 完成汇总数发生变化且可动画 | 从上一真实值到当前真实值，350ms |
| `prefers-reduced-motion: reduce` | 直接显示最终值，卸载数字动画 |
| 页面隐藏 | 停止动画；重新显示不补播旧变化 |
| 实际重建任务活动 | 不启动数字动画，保留静态最终值 |
| 首次载入、语言/策略切换、重新进入 | 不重播历史变化 |
| 读屏 | 始终读取静态最终数字，动画文本 aria-hidden |

CSS 的 hover/focus 以颜色和边框变化为主，弹层使用组件内有限过渡；全局减少动效媒体查询约束 CSS animation/transition。数字动画另有 JS 策略，不能仅靠 CSS 查询暂停。

禁止把 NumberTicker 用于训练进度、GPU/VRAM、温度或日志计数。未使用 BlurFade、AnimatedList、BorderBeam、ShineBorder、Meteors、Particles、Marquee；后续新增需独立说明业务用途、持续时间与停止条件。没有 CPU/GPU 实测前不能宣称动效无开销或提升性能。

## 8 无障碍、本地化与验收（历史）

基础控件使用语义标签和 Radix 键盘模型。图标按钮必须有名称；Tooltip 只补充说明；disabled 原因应在邻近上下文可读取。状态通知沿用 StatusAnnouncer，避免轮询与连续资源数字反复打断读屏。

文字、数值、日期继续采用既有中英 i18n/locale。可见 label 与 accessible name 使用同一翻译值。错误消息完整展示，长路径和英文按钮保留扩展空间。普通文字目标对比度 4.5:1，必要控件边界/焦点目标 3:1；这些是验收目标，最终组合和透明叠加仍需测量，不能继承旧 token 评估就宣称当前完整 WCAG 合规。

当前已通过的单元/交互测试覆盖模态、菜单、Tabs、创建草稿与取消、设置失败、日志乱序、渲染生命周期及减少动效策略。完整生产构建和 Spark/Three/SuperSplat 集成回归已通过。浏览器在 1440×1024 与 1024×768 实查中文浅色首页、向导第一步、工作区、设置、项目菜单和窄窗弹层，并检查英文深色设置，控制台无 error/warn。后续桌面壳重设计还完成了原生调试 .app 构建与 17 条真实记录截图对照，涵盖中文、长路径、空格与 emoji，以及原生明暗主题、全屏进出和菜单 Esc 焦点恢复；英文深色 1024×768 项目库与工作台主操作可见。视觉对照、已修问题与原生控件验证限制见 [design-qa.md](../design-qa.md)。本轮新增的窗口导航还通过333项全量前端测试，以及之后独立运行的7项预览身份单测；原生后退/前进、折叠和双击缩放已检查。最新两张红框参考与实现的合并对照位于`.test-results/window-toolbar/`。具体数量与构建状态见[迁移验证记录](frontend-migration-plan.zh-CN.md#6-已执行验证与限制)。

发布前仍需按目标平台完成键盘全路径、读屏、forced-colors、200% 缩放、Windows DPI/WebView2、macOS WKWebView、原生文件选择、真实任务/恢复/保存、GPU 资源和长时间运行验证。SuperSplat 内部独立验收，不能用宿主换肤推断其内部已迁移。

## 9 Jan 现行规范（2026-10-29）

- **桌面框架**：共用48px窗口首行。展开时左上与左下全高侧栏同宽，默认240px、可调224–320；左上只保留原生交通灯安全区和靠右的侧栏开关，内容页头紧接侧栏区域，按用户要求不呈现后退/前进按钮或其占位。隐藏采用Jan LeftSidebar的offcanvas语义：正文侧栏占位为0，隐藏内容退出焦点序列，展开恢复先前宽度；首行开关位于macOS 84px安全区之后，页头随其内容宽度紧接，使用主区背景且无竖分隔。侧栏开关为32px圆形点击区、18px图标；稳定节点和header portal在开合时保留。原生macOS三灯由AppKit标准按钮提供：移除仅调整容器的`trafficLightPosition`配置，在主队列完成布局后把实际按钮圆心对齐至首行24pt；按内容/父视图坐标转换，仅调整纵向位置，保留系统横向间距、尺寸和动作。窗口缩放/焦点/主题/DPI变化以及原生窗口更新后仅在偏离时重新校正，全屏时交给系统；Destroyed使排队任务永久失效并移除观察器。compact抽屉在隐藏侧栏之外，统一提供项目中心和底部设置入口；新建/打开集中在项目中心主区工具栏。没有网页式外边距、浮动页面大圆角或重复标题，OS窗口圆角保留。
- **项目导航**：侧栏与窄窗项目抽屉均移除“最近项目”标题及列表，仅保留“项目中心”与底部“设置与引擎”。侧栏继续沿用宽度、折叠与安全导航行为，窄窗抽屉保留关闭、焦点及模态保护；项目数据与管理操作集中在主区网格。
- **项目中心**：用户选定Meshroom Projects的照片网格组织方式，保留Jan桌面壳及主题。数量、搜索、打开和新建集中在可换行的单行工具栏，不增加重复“打开项目”图块。按用户圈选移除“全部状态”菜单、照片下的训练状态行和常驻路径异常/重新定位块；主区使用180–220px照片方格，图下只显示项目名。搜索仅匹配名称及完整路径，不因训练状态或路径健康隐藏项目，全库不受导航组件默认50项限制。训练状态、阶段、路径健康、完整路径和更新时间保留在title及无障碍描述，并继续用于原安全逻辑。项目更多菜单与真正的右键ContextMenu共享原管理和安全导航流程；右键释放不执行动作，Esc返焦更多按钮。重试检查与重新定位留在菜单，仅实际操作后的UUID不匹配和重新定位错误反馈在卡片中显示。成功打开项目才前移最近顺序，后台状态更新保序；本次侧栏移除不改变主区网格。
- **项目照片来源**：缩略图代表项目内真实输入素材，优先frames中的首张图片，再回退source中已复制的照片，不冒充重建渲染。只读命令校验项目身份、项目内路径与普通文件，限制扫描、文件大小和像素，返回最长边360px的JPEG或null；不调用引擎、抽视频帧或写磁盘缓存。前端靠近可见区时加载，并发2、48项内存LRU，按项目ID/路径/updated_at及状态/阶段隔离；缺图或读取失败只显示该项目的局部占位反馈，不生成替代照片。Meshroom仅作视觉参考，未复制QML代码，也未增加依赖。
- **主题**：唯一来源 `integrations/jan/theme.json`，宿主生成tokens，编辑器构建消费同源数据；light/dark/system仍由原useTheme拥有。浅色主填充`#be4c30`+白字，深色`#f17455`+深字；侧栏`#f1f1f1`/`#171717`。正文14px，`--font-size-base:16px`；Inter+中文系统回退，技术数值JetBrains Mono。没有复制Jan字标或授权不明字体。
- **组件**：保留本地props、Radix交互、Portal scope、默认button type、busy/focus保护及有限状态语义；Jan视觉与shadcn MIT来源并列保留。结果数量静态本地化，不加载Magic/Motion数字动效。
- **设置**：设置仍是稳定壳上的双栏浮层，232px分类与独立滚动正文，60px为设置内部标题高度；主页面保持挂载。
- **创建向导**：保留素材、预检与参数、确认创建三步流程，共用48px窗口页头。步骤条使用24px紧凑标记，去掉卡片背景及重复的可见“下一步”说明，正文最大960px，底部操作与安全退出位置不变。素材选择使用紧凑入口，移除大虚线及上传伪区域；拍摄建议默认折叠，仅保留“素材默认仅在本机处理”的本机说明，最多6张素材预览按2/3/6列重排，目标元数据保留。参数页先呈现桌面三列预设，选中项使用default主色橙色填充、primary-foreground文字及勾选/ring，未选项为outline，aria-pressed及业务切换不变。重复的预计帧数、分辨率和目标迭代汇总收进默认折叠的“参数详情”；下方统一环境检查，正常“运行环境详情”默认折叠，can_continue为false时由本地展示状态自动展开。warnings、blockers及设置修复入口位于折叠区外，直接可见；已知Mac执行提示只从当前后端警告提取实际数值，简写为如“本次 Mac：7,000 步 · SH1 · 1920px”，完整原提示保留title，未知警告原样呈现。确认页采用标签行表单与轻量摘要，移除额外素材复制说明，摘要中的copy方式保持。失败/复制反馈随步骤正文滚动；hook、后端、引擎及参数协议、目录重检、预检门禁、复制取消与退出确认沿用原业务控制。
- **工作台页头**：共用首行的compact运行栏保留项目名、适用的任务控制、编辑与操作菜单，移除状态/进度入口及完成项目的独立“文件”按钮；文件定位仍在操作菜单。非compact完整运行栏继续显示路径、整体进度、状态、当前阶段、适用的实际工作量与最近更新，任务冲突和启动/暂停/继续/取消/重试行为不变。
- **工作台阶段导航**：桌面四大阶段使用单行数字或完成勾、阶段名、细连接线及展开箭头；完成态不再逐格重复“已完成 · 100%”，运行和异常态保留简洁真实状态，完整状态/进度保留在title与无障碍名称。预览所选阶段轻量高亮，可展开子阶段并使用键盘选择预览；子阶段移除重跑/重试按钮及其导航回调，选中阶段的错误说明继续显示。真正的失败重试和质量阻断修复仍由Inspector原恢复入口处理。
- **工作台Inspector**：完成态只保留一个“重建完成”标题及一句结果说明，不重复展示完成标签、100%数值或满进度条；运行、暂停、取消与失败态继续显示对应进度和恢复反馈。质量区域称“重建质量”，其中COLMAP结果明确标为“相机重建检查”及对应风险/阻断状态；主要匹配组覆盖率说明其图像分组含义，不冒充整体模型质量。注册率按素材类型显示“照片注册率”“视频帧注册率”，未知类型使用“图像注册率”；点数优先显示真实splat_count并标“高斯点数”，否则使用sparse_points并标“稀疏点数”，缺值仍为未知。相机重建尝试记录默认折叠，质量检查详情及原风险继续/修复流程保留。输出目录、PLY文件与“恢复点（数量）”采用32px紧凑小按钮，PLY继续受真实产物校验约束；恢复点表示Brush的PLY几何恢复，不暗示完整优化器状态恢复。
- **三维工作台布局与反馈**：视口在固定ResizablePanel中，Inspector为兄弟区域，窄窗用模态显示；512CSS重排允许正文滚动。UI工具栏按主题变化，模型颜色、选区语义及输出色彩不变。未知资源不是0，质量风险按钮严格取决于真实decision。恢复点AsyncStatus在成功但为空时静默，由父容器现有:empty规则消除占位；加载、refreshing、error、stale、partial与重试反馈仍保留。
- **编辑器**：当前固定官方SuperSplat 3.7.0/`b89029dd20911fd18905b61de2701094ac390a73`，配套splat-transform 3.10.2/`e0dab1fa0b7f7546d2b4b197f6294570e53ba3b8`及独立`webp-overlay-3.10.2`；旧3.4.2派生证据保留为历史。独立iframe URL固定，父窗口source/origin/channel鉴权、load/dirty/saved/save-failed、单飞及保存会话确认保持；export使用`{}`保留实际SH0–3，不强制补齐到SH3。theme仅传light/dark+jan-v1，拒绝任意样式/脚本；Jan共享颜色经静态样式及Canvas最小绘制适配进入完整UI，所有输入进入缓存签名/资产清单。语言由宿主拥有，嵌入Preferences不再提供独立语言选择，Reset保留宿主语言；主题和语言同步不重载iframe或重置dirty，theme失败可重试且不冒充模型失败。嵌入菜单隐藏menu-home与其separator，宿主标题、右下版本、About及NOTICE保留。首次在registerPreferences前仅将camera.showInfo与view.perfOverlay迁移为false，保留其他偏好及顶层字段，成功后写入metorigin:supersplat:overlay-defaults:v1标记；随后手动开启仍记忆。standalone保持上游行为，未知或损坏存储不清空，失败写入不标记完成。
- **验证含义**：布局视觉对照与完整发布验收分别记录于根`design-qa.md`和迁移记录第10节。样例数据明确标记，截图不冒充GPU/文件保存/重建证据；未验平台与真实场景不能标成已完成。
