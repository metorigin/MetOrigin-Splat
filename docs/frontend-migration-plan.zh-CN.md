# MetOrigin Splat 前端迁移与优化方案

状态：Proposed，尚未实施。评估日期：2026-10-21。

建议采用 **shadcn/ui + Tailwind CSS v4 + 受控的 Magic UI 动效组件**，全面统一自有 React 界面。迁移围绕本地三维重建工作流展开：保留可靠的原生任务与渲染边界，逐步替换基础组件、页面布局和样式，实现可维护的设计系统。详细视觉、组件、状态与交互规范见[设计系统提案](design-system-proposal.zh-CN.md)。

“全部迁移”需要划定两种范围：自有 React 页面和编辑器外壳可以全部统一；嵌入的 SuperSplat 内部使用独立 DOM、样式和构建体系，必须单独治理。仅安装三个库不会让它自动统一，也不会自动解决任务状态、性能和设计一致性。

## 1 产品定位与迁移目标

MetOrigin Splat 是 Windows 优先、本地运行的 Gaussian Splatting 创作工作台。用户从视频或图片开始，经过素材处理、相机重建、模型训练、质量检查，最后编辑和导出场景。当前同一时间只执行一个重建任务，但允许浏览其他项目。

本方案以三类任务为设计依据：首次使用者成功完成一次重建；反复处理素材的创作者快速配置与比较结果；高级用户判断训练状态、资源瓶颈和恢复策略。它们是从现有功能推导的使用场景，尚不代表经过访谈确认的用户分群。

迁移成功应表现为：

- 控件、布局、状态文案和快捷键行为跨页面一致。
- 用户能区分当前浏览项目、正在运行项目、当前阶段和所查看的产物。
- 高斯模型拥有足够的显示面积，辅助界面不会抢占资源或遮挡画布。
- 耗时操作有可信进度、取消边界、恢复入口和明确结果。
- 新功能通过共享组件完成，不再复制页面专属按钮、弹窗和 CSS。
- 保留本地处理、断网运行、中英双语、用户主题偏好及旧项目兼容性。

## 2 当前前端基线

### 2.1 技术与代码规模

| 项目 | 当前事实 | 迁移含义 |
| --- | --- | --- |
| 技术栈 | React 18.3.1、Vite 5.4.21、TypeScript 5.9.3，版本来自锁文件 | 不需要引入 Next.js 或替换 Vite |
| 桌面接口 | Tauri 2；API 2.11.1、CLI 2.11.4 | 保留命令、事件、窗口和权限边界 |
| 渲染 | Three 0.185.1、Spark 2.1.0、独立 SuperSplat 编辑器 | UI 替换与渲染生命周期分开 |
| UI 依赖 | 本地 Inter、JetBrains Mono、Lucide | 可以继续使用，无需在线字体和第二套图标 |
| UI 源文件 | 33 个非测试 TSX，其中 components 下 26 个 | 规模适合分批替换，业务复杂度主要在大页面 |
| CSS | tokens 57 行、buzz 665 行、interaction-surfaces 446 行、model-editor 13 行，共 1181 行 | 主要问题是全局覆盖与契约分散，不是纯粹行数过大 |
| 大文件 | ProjectDetailPage 932 行、NewProjectPage 915 行、App 723 行 | 拆分流程控制、业务区块和展示组件 |
| 原生窗口 | 默认 1440×1024，最小 1024×768 | 优先验证桌面窄窗、高 DPI、缩放和面板收起 |

依据：[前端依赖](../apps/desktop/package.json)、[锁文件](../pnpm-lock.yaml)、[样式入口](../apps/desktop/src/styles/buzz.css)、[Tauri 配置](../apps/desktop/src-tauri/tauri.conf.json)。

项目已有语义颜色、亮暗主题、焦点样式、模态焦点管理、Tab 键盘导航、屏幕阅读器通知及异步状态类型。因此准确的诊断是“已有设计基础，但缺少完整的组件契约和治理”，无需从零推翻。

### 2.2 本次实际执行的检查

| 检查 | 结果与范围 |
| --- | --- |
| 依赖安装 | 使用现有 lockfile，`--frozen-lockfile --ignore-scripts`，没有升级依赖 |
| ESLint | `pnpm lint` 通过 |
| TypeScript | `pnpm --dir apps/desktop exec tsc --noEmit` 通过 |
| 单元与交互测试 | `pnpm test` 通过，30 个测试文件、157 项测试 |
| 前端产物 | `pnpm --dir apps/desktop exec vite build` 通过，有大分块警告 |
| 页面观察 | 应用内浏览器访问开发专用 `?ui-preview`，检查项目中心、新建素材页、训练工作台和设置 |

本次直接执行 Vite 构建，**没有执行含 SuperSplat 准备步骤的完整 `pnpm build`，也没有构建原生安装包**。页面观察使用示例数据，不能证明真实文件导入、GPU 渲染、重建恢复或编辑保存已经通过验证。

构建体积如下，单位沿用 Vite 输出的十进制 kB；gzip 是比较口径，不等于 Tauri 本地加载的实际传输体积：

| 分块 | 构建体积 kB | gzip kB |
| --- | ---: | ---: |
| index JS | 238.39 | 92.01 |
| App JS | 730.67 | 194.21 |
| GaussianSplatPreview JS | 4931.98 | 1753.31 |
| ModelEditorPage JS | 4.84 | 2.41 |
| App CSS | 82.33 | 21.14 |
| ModelEditorPage CSS | 1.22 | 0.52 |

入口通过 lazy 加载 App，但首页仍需加载 App 及其静态依赖。高斯预览已经独立分块，不能把它的 4.93 MB 全部算作首页加载量。此表不包含独立 SuperSplat 构建资源，也没有测量启动时间、帧率、内存或训练速度。

### 2.3 页面观察与设计判断

截图为本次浏览器实际捕获并回读的 1280×720 暗色示例界面。该尺寸是浏览器捕获尺寸，不是原生最小窗口验收结果。截图保存在被 Git 忽略的 `.test-results/frontend-migration-audit-2026-10-21/`。

| 步骤及截图 | 已观察到的优点 | 需要改进的设计判断 |
| --- | --- | --- |
| 1 项目中心，01-project-center.png | 主入口清楚，项目状态和运行环境可见 | 左侧与主体都有项目列表及搜索；应明确“快捷访问”和“完整项目中心”的分工。三块统计卡可收紧，让最近项目和运行任务更突出 |
| 2 新建项目，02-create-project.png | 三步结构清楚，有素材建议及本地处理说明 | 首屏导入区较高，帮助内容与主任务竞争空间；窄窗应收起帮助并保证底部操作区可达。预检与确认步骤本轮未实走 |
| 3 训练工作台，03-reconstruction-workspace.png | 四阶段可理解，模型区域与任务监控分开 | 顶部、阶段卡、右侧多处呈现状态；应明确整体进度、阶段进度的不同分母。避免反复出现“处理中/运行中/Brush训练” |
| 4 设置，04-settings.png | 分类、语言入口和引擎详情齐备 | GPU、组件状态统一写“已完成”语义不准确；应分别为“已检测/可用/已验证”。常规设置不应重复放入引擎分类 |

代码进一步确认，设置页存在逐次 `onChange` 保存与“保存设置”按钮并存；Tabs 可见名称和无障碍名称也不完全一致。见 [SettingsDrawer](../apps/desktop/src/components/settings/SettingsDrawer.tsx) 第 26、32、78、122、147、180、197–198 行。

截图能支持布局判断，不能支持“已符合 WCAG”或“所有键盘路径正确”的结论；明亮主题、200% 缩放、读屏、原生对话框和完整创建流程列入实施验收。

## 3 技术选择与兼容决策

### 3.1 三套技术各自负责什么

| 层 | 选择 | 负责 | 不承担 |
| --- | --- | --- | --- |
| 视觉基础 | Tailwind CSS v4 + CSS variables | Token 映射、布局、响应式、状态样式 | 业务状态机、GPU 渲染 |
| 可访问组件 | shadcn/ui，统一选 Radix 基础 | Button、Dialog、Tabs、Menu、Select 等自有源码组件 | 自动生成项目的业务规范 |
| 业务组合 | 项目自己的 React 组件 | PipelineTimeline、SceneViewport、PresetCard、EngineCard 等 | 重新实现通用焦点陷阱 |
| 动效来源 | Magic UI 按需引入，统一封装 | 一次性出现、有限的结果变化 | 整站持续装饰、伪进度、训练循环 |
| 业务契约 | 现有 hooks/context/desktopApi | 状态派生、命令、取消、恢复、错误映射 | 视觉样式 |

shadcn 和 Magic UI 都采用可纳入项目维护的组件源码思路。组件导入后需要由本项目审查和维护，不能当成安装后自动升级的黑盒。[shadcn 项目](https://github.com/shadcn-ui/ui)、[Magic UI 安装](https://magicui.design/docs/installation)。

### 3.2 React 和构建工具

目标建议采用经回归验证的 React 19.x，但先用独立提交验证兼容，再进行页面迁移。当前 shadcn 面向 Tailwind v4 的组件采用新的 ref 写法，而 React 的函数组件 ref prop 从 19 开始支持。若试验阶段保留 React 18.3.1，Button、Input 等需要转发 ref 的包装必须继续正确使用 `forwardRef`，尤其验证 DialogTrigger、Tooltip、Popover 的组合。[shadcn 的 Tailwind v4 说明](https://ui.shadcn.com/docs/tailwind-v4)、[React 19 ref 说明](https://react.dev/blog/2024/12/05/react-19#ref-as-a-prop)。

Radix 统一为本项目的基础原语，不同时引入 Base UI/React Aria 的第二套同类弹层。当前 CLI 提供多个 base 选项，初始化时应显式记录选择。[shadcn CLI](https://ui.shadcn.com/docs/cli)。

Vite 5.4 暂时保留。官方 Tailwind Vite 插件源码的 peer 范围包含 Vite 5.2 及以上的对应主版本范围；实施时仍需检查实际发布版本的 peer，而不是将 main 分支版本当成 npm 稳定版本。Tailwind 与其 Vite 插件固定到同一经验证版本。[官方插件包声明](https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/packages/@tailwindcss-vite/package.json)。

新依赖具体版本在兼容试验时确定并写入 lockfile；不在长期脚本中使用浮动 `@latest`，不使用强制忽略 peer 错误作为稳定方案。

### 3.3 WebView 与离线约束

Tailwind v4 的官方浏览器基线为 Chrome 111、Safari 16.4、Firefox 128。Windows Tauri 使用 WebView2，应验证实际运行时达到所需 Chromium/CSS 能力，不仅检查操作系统版本。[Tailwind 兼容性](https://tailwindcss.com/docs/compatibility)、[Tauri WebView 版本](https://v2.tauri.app/reference/webview-versions/)。

项目完整安装器配置为 `offlineInstaller`，不是固定版本 `fixedRuntime`。记录离线安装载荷与实际 WebView2 版本，测试当前版本、受支持最低版本、断网安装和首次运行。后续如扩展 macOS/Linux，需要单独验证 WebKit。

保留本地字体、图标、组件、脚本和编辑器资源。Magic UI registry 的网络访问仅发生在开发引入阶段，安装后的应用不依赖 registry/CDN。

当前两份 Tauri 配置均为 `csp: null`。CSP 加固单独排期，依据 IPC、模型 blob、worker/WASM、iframe 的真实需求制定，不与首次 UI 替换混成一个提交。[Tauri CSP](https://v2.tauri.app/security/csp/)。

## 4 目标结构与保留边界

以下目录是目标建议，当前尚未创建：

```text
src/
  app/                    应用壳、providers、导航与启动
  components/
    ui/                   shadcn 基础组件，自有源码
    magicui/              选中的上游动效源码
    motion/               项目动效策略与受控封装
    shell/                侧栏、运行栏、状态栏
    domain/               状态徽标、预检卡、参数字段、资源指标
  features/
    projects/             项目中心与快捷访问
    create-project/       三步向导、草稿、预检协调
    reconstruction/       阶段、产物、日志、检查点
    model-editor/         编辑器外壳与会话
    settings/             设置分类与保存状态
  viewers/                点云/高斯渲染与生命周期
  services/               desktopApi、editorBridge，契约保留
  hooks/                  跨功能异步与桌面交互能力
  types/                  现有领域类型
  i18n/                   现有中文/英文资源
  styles/                 tokens、主题映射、过渡期 legacy
```

目录迁移随实际模块替换完成，避免先全量移动文件再修改行为。UI 层不能直接启动引擎或把原生任务状态复制成第二份真相。状态框架、数据库或跨层服务的新增受[项目宪章](../.specify/memory/constitution.md)约束；本方案优先拆分现有 Context、优化订阅，不以引入 Zustand/Redux 为前提。

必须保留的边界：

1. `desktopApi` 的 typed IPC、错误归一化与开发预览隔离。
2. project ID、session、sequence 约束和晚到事件过滤。
3. pause/cancel/recover/rerun 的后端确认与有效恢复数据判断。
4. 删除、重跑等操作的影响预览、确认 token、过期校验和结果回执。
5. 编辑器 bridge 的 origin/source/channel 校验、dirty 判断、保存确认和二进制 transfer。
6. 模型更新时保留旧画面和用户相机，失败更新不得清空有效模型。

SuperSplat 分两阶段处理：第一阶段统一返回、保存、错误、载入和任务提示等外壳；第二阶段如要求内部视觉也统一，在固定上游 commit 上维护有限主题补丁或新增经过验证的主题桥协议。其内部全面 React/shadcn 重写属于独立编辑器工程，不包含在本次宿主 UI 工期中。

## 5 样式和组件迁移方法

### 5.1 接入顺序

在 `apps/desktop` 中接入 Tailwind Vite 插件，保留 1420/1421 端口和 Tauri watcher。同步配置 TypeScript、Vite、Vitest 的 `@/*` 别名；Vitest 当前独立配置，不能只改 Vite。

新增 `components.json`，明确 `rsc:false`、`tsx:true`、CSS variables、CSS 入口、aliases 和组件基础。Tailwind v4 不照搬旧版 `tailwind.config.js` 流程。[Vite 安装](https://ui.shadcn.com/docs/installation/vite)、[components.json](https://ui.shadcn.com/docs/components-json)。

保留 `data-theme` 作为唯一主题源；例如用以下方式把 Tailwind dark variant 对齐当前机制：

```css
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
}
```

这是局部映射示例，不是完整可替换的样式文件。完整 token 以设计系统提案为准。初期将旧变量映射到新语义变量，例如 `--bg-panel → --card`，同一主题只保留一份色值来源，逐页去掉旧别名。

### 5.2 旧 CSS 共存

现有 buzz 与 interaction-surfaces 存在相同选择器的顺序覆盖。未放入 layer 的旧样式通常会压过分层 utility；仅把 Tailwind 导入放在末尾无法可靠解决。

建议明确 layer 顺序 `theme → base → legacy → components → utilities`。先将现有样式按模块整理到可控 legacy 层，并验证旧页面；随后迁移一个组件就删除其旧规则。Portal 使用共享主题和浮层组件样式，不能依赖某个页面祖先才能正确显示。

过渡期可以只引入 Tailwind theme/utilities，暂不启用全局 Preflight，但要为新组件显式补足必要基础样式；待旧控件迁移完毕再启用完整 Preflight 并做全页回归。[Preflight 配置](https://tailwindcss.com/docs/preflight#disabling-preflight)。

所有状态类使用完整字符串映射或 CVA variants；不拼接 `bg-${status}-500`。扫描范围限定自有源码，不扫描 SuperSplat 构建目录、模型或生成产物。[Tailwind 源码扫描](https://tailwindcss.com/docs/detecting-classes-in-source-files)。

### 5.3 组件映射与替换验收

| 现有实现 | 目标基础组件 | 必须保留的项目行为 |
| --- | --- | --- |
| button/btn/icon-button | Button + Tooltip | busy 防重复提交、名称、快捷键、风险等级 |
| 原生 input/select/checkbox | Input、Select、Checkbox、Switch、Field/Label | IME、数值边界、选中文本、路径展示 |
| ModalSurface | Dialog / AlertDialog | 模态栈、焦点返回、忙碌期关闭限制 |
| ProjectDrawer / CheckpointDrawer | Sheet + ScrollArea | 搜索、定位、恢复条件、长列表 |
| 手写菜单 | DropdownMenu / ContextMenu | 方向键、Esc、点击后焦点、禁用原因 |
| SettingsDrawer | Dialog + Tabs | 标签一致、保存模型、重试与诊断 |
| status-pill | Badge + domain presentation map | 真实状态、统一文案、文本加图标 |
| progress-track | Progress + TaskProgress | 未知、暂停、失败、最后成功数据 |
| 三步向导 | 自有 Stepper + Field + Alert | 草稿保留、预检失效、取消复制 |
| 四阶段时间线 | 自有 Timeline + Collapsible | 12 步聚合、手动选择与自动跟随 |
| 活动工作台 | Tabs + 有界虚拟列表 + Resizable | cursor、去重、筛选、选择与自动追随 |
| ActionReceipt / ErrorNotice | Sonner + Inline Alert | 阻断错误不消失、可执行恢复动作 |
| 点云/高斯预览 | 保留 renderer，统一 toolbar/overlay | 摄像机、模型、资源释放、隐藏策略 |
| SuperSplat | ModelEditorShell | 保存/离开检查，iframe 稳定身份 |

同一弹层不得同时运行旧焦点陷阱和 Radix 焦点管理。迁移 `ModalSurface` 时保留领域 wrapper 接口、逐调用点切换，确认无旧引用后移除旧 hooks。

注意 Tabs 内容卸载：布局、主题、语言和面板切换不能无意卸载 renderer 或编辑器。保留稳定宿主节点，隐藏面板时暂停耗时工作；`forceMount` 的使用要同时考虑隐藏内容的焦点与辅助技术访问。

`ProjectCard`、`EmptyState`、`PipelineProgress`、`StageProgress` 存在退役候选：目前静态检索未见实际页面使用链。先核实并清理无用导出，避免给未使用代码再建一套新组件。

## 6 前端优化优先级

### 6.1 已有优化需要继承

首页索引/设置/引擎独立加载；路径检测有 4 路并发限制；资源采样已有 5/15/30 秒策略；当前项目轮询已有 in-flight 合并；异步资源已有 requestKey 和 stale 支持。高斯预览已经 lazy、限制 DPR、隐藏时停绘制/停实时请求、串行更新、保留旧帧并释放 GPU 资源。

后端已有稀疏点云 20 万采样上限，活动 API 已 cursor 分页且默认 200、最多 500 条/页。优化重点是前端调用与显示，不要将已有能力重复列为待建设。

### 6.2 具体工作

| 级别 | 当前证据 | 建议改变 | 验收 |
| --- | --- | --- | --- |
| P0 迁移安全 | 原生状态和编辑器承担长任务/未保存数据 | 迁移前建立行为 fixture 与关键回归 | 暂停、取消、恢复、未保存离开、确认 token 均不退化 |
| P1 拆包 | App 静态页面链引入 PointCloud/Three | 页面和 PointCloud 各自 lazy，检查 barrel 引用 | 项目中心加载图不包含 Three/Spark/编辑器运行时 |
| P1 活跃摘要 | App:244–258 逐事件查询再叠加 3s 轮询 | single-flight；进度合并 100–250ms，终态立即处理；保留低频兜底 | 峰值下同资源至多一个在途请求，状态传播不退化 |
| P1 React 更新 | AppContext:10 全量 state 广播 | 按导航/目录/任务拆分订阅；业务快照和 freshness 分开 | 高频事件不让无关目录、设置和编辑外壳反复提交 |
| P1 日志一致性 | ActivityWorkbench:80–86 的 cursor/ref 副作用独立于结果 guard | 用 query generation 同步保护数据、cursor、refs | 旧查询晚到不会改变新查询分页游标 |
| P1 日志负载 | 搜索逐键请求，events 全量 map、缓存无上限 | 150–250ms debounce，虚拟化，有界窗口，旧页按需取回 | 1k/10k/100k记录仍可操作；不会丢失后端历史 |
| P1 设置保存 | SettingsDrawer:197–198 输入每变一次即持久化 | 数字草稿+验证+显式应用；即时偏好单独反馈 | 输入空字符串/越界/快速修改不会写入错误中间态 |
| P1 稀疏点云 | PointCloudPreview:134 常驻 RAF；:140 未释放网格资源 | 隐藏暂停、资源释放，阻尼结束后按需绘制 | 进出20次资源无持续增长；隐藏无绘制 |
| P2 点云缓冲 | PointCloudPreview:25 preserveDrawingBuffer=true | 先核对截图需求，再决定关闭 | 图像/截图功能保持，峰值资源有实测比较 |
| P2 模型峰值 | GaussianSplatPreview:190 新旧模型并存保证连续性 | 测 decode/upload/RAM/VRAM，再调整刷新节奏 | 保留有效旧帧，训练吞吐和内存满足基线 |
| P2 数据刷新 | ProjectDetailPage:230 产物轮询与阶段刷新叠加 | 按版本失效、合并扫描、完成后降频 | 恢复/重跑及时更新，完成项目无频繁磁盘扫描 |
| P2 字体与构建 | 字体产物包含多个语言子集/格式 | 根据实际中英界面和符号需求选择子集 | 中文回退、数字/单位完整，断网不缺字 |

这些是基于调用路径的优化候选与可复现风险，不是已经实测的卡顿比例。优先把拆包、设置保存和日志乱序保护放在独立提交中，方便比较与回退。

### 6.3 性能预算与测量

继承现有契约：主操作反馈不超过 1 秒；状态传播 p95 不超过 2 秒；1000 条日志筛选定位 p95 不超过 2 秒。历史报告的合成 IPC 数据不能替代真实 Tauri 基线，历史任务 T082 仍记录为未完成。依据：[旧规格](../specs/001-frontend-ux-improvements/spec.md)、[验证记录](../specs/001-frontend-ux-improvements/validation-results.md)、[任务记录](../specs/001-frontend-ux-improvements/tasks.md)。

新增以下建议目标，P0 实测后确认，不作为当前已达成指标：

| 场景 | 建议目标或测量口径 |
| --- | --- |
| 普通点击、输入反馈 | p95 ≤100ms；耗时命令立即显示已接收状态 |
| 日志筛选 | 1000条标准数据下结果 p95 ≤200ms，不含人为 debounce；另记录端到端时间 |
| 首页依赖 | 不加载 Three、Spark、SuperSplat；新增 UI/动效依赖单独记录 gzip 与解析成本 |
| 高频事件 | 同资源请求合并、终态无丢失；记录每秒 IPC 与 React commits |
| 静态界面 | 持续装饰动画为0；隐藏页停止装饰动画与非必要绘制 |
| 训练加预览 | 固定硬件/模型，记录 step/s、帧耗时、峰值RAM/VRAM；P0先测波动区间并确定允许退化阈值，分别比较吞吐下降率和帧耗时上升率 |
| 长时间运行 | 1小时任务、20次进出预览/编辑后，DOM/监听器/GPU资源不持续累积 |

统一记录操作系统、WebView2、GPU/驱动、窗口尺寸、DPI、电源模式、模型点数/字节数和构建 hash。初测至少采集30次重复交互；正式交互延迟验收预热后采集至少100次，报告p50/p95与波动区间，冷启动单独采集。主线程用 Performance/React Profiler，原生调用用单调时钟；不能用 Vitest 执行耗时当产品响应速度，也不能承诺所有模型达到60 FPS。

## 7 迁移分期与工作量

以下为一名熟悉项目的前端工程师、配合原生测试支持的工作量估计，非交付承诺。原生故障修复及 SuperSplat 内部统一另计。

| 阶段 | 交付 | 进入下一阶段的条件 | 估计人日 |
| --- | --- | --- | ---: |
| P0 基线与兼容试验 | 组件清单、基准 fixture；Button/Dialog/Select/Tooltip/Magic封装试验；React决策 | ref/焦点/IME/主题通过，WebView基线明确 | 2–3 |
| P1 设计基础 | tokens、Tailwind、别名、组件来源清单、组件展示页、旧样式隔离 | 双主题及旧页无样式回归 | 2–3 |
| P2 基础组件与设置 | buttons/fields/menu/dialog/tabs/feedback；设置保存与标签修复 | 键盘/嵌套弹层/失败恢复通过 | 3–4 |
| P3 项目中心与向导 | 导航、列表、三步创建、预检与确认 | 新建/取消/返回草稿/路径变更复检通过 | 3–4 |
| P4 工作台与编辑外壳 | 四阶段、视口外框、Inspector、日志、Checkpoint、保存与退出 | 原生任务/模型/编辑器生命周期回归通过 | 4–6 |
| P5 性能与动效 | 拆包、订阅/查询合并、点云清理、受控Magic UI | 对比基线不退化，减少动效真正生效 | 2–3 |
| P6 发布验收 | 清理legacy/无用组件、全矩阵、文档、安装包与离线运行 | 所有阻断项关闭且可回退 | 2–3 |

总计约 **18–26 人日**，不包含 CSP 加固、SuperSplat 内部统一及额外原生故障修复。组件规范和兼容试验是共享前置；项目中心与部分设置可以并行，工作台和编辑器应由同一负责人控制生命周期边界。

推荐每个阶段拆成可审阅提交或 PR。React 升级、Tailwind 基础接入、业务行为修复和页面视觉替换分别提交。必要时只保留短期、内部使用的页面切换开关，不维护两套永久产品入口。

回退以代码/构建版本回退为主；本次 UI 迁移不改变项目 schema。回退前关闭或安全退出编辑会话，避免热切换重建 iframe。UI 偏好如增加“减少动效”必须采用独立键/兼容默认值，不影响工程数据读取。

## 8 验收清单与完成定义

| 范围 | 必须覆盖 |
| --- | --- |
| 视觉 | 明/暗；1024×768、1440×1024、1920×1080；Windows125%/150%/200%DPI；另测内容缩放 |
| 双语 | 中文/英文即时切换、长项目名/路径、按钮扩展、日期/数值单位 |
| 状态 | 初次loading、empty、refreshing、stale、partial、failed、retry、disabled、busy |
| 创建 | 视频/图片文件夹、警告/阻断、预设变更、路径变更、复制取消、创建并启动冲突 |
| 任务 | 运行中浏览其他项目、事件乱序、暂停/取消中重复操作、恢复点失效、失败后重试 |
| 渲染 | 模型更新失败保留旧帧、隐藏暂停、尺寸调整、相机保留、点云/高斯切换与资源清理 |
| 编辑 | 未保存离开、保存中关闭、bridge异常、iframe不因主题/语言重建 |
| 无障碍 | 可见标签即名称、完整键盘路径、焦点回归、错误关联、读屏去重、对比度、减少动效 |
| 原生与分发 | WebView2最低/当前版本、原生选择器、断网启动、生产构建、安装/卸载与许可证 |

复用现有 lint/typecheck/test；正式 `pnpm build` 包含 SuperSplat 资源准备。复用 `test:ux:automated`、`test:tauri:native-fast`、`test:tauri:native-failure-recovery`、`test:gaussian:native`。涉及 Rust/安装/能力配置的改动按宪章执行对应 Cargo 和 Windows 构建验证。

完成标准：所有实际使用的宿主基础控件统一走 `components/ui`，业务状态统一映射，旧全局组件样式和焦点实现无残余调用，动效均经过项目封装，核心原生路径与性能基线通过。SuperSplat 内部是否继续保持上游样式必须在版本说明中明确，不能据宿主完成宣称整个第三方编辑器已迁移。

## 9 组件来源与后续维护

为每个引入组件记录：名称、上游 registry URL、获取日期、源 commit 或内容 hash、依赖版本、许可证、本地修改、维护负责人和行为测试。固定 CLI 版本不能锁住远端 registry 内容，因此提交的组件源码才是可复现依据。

统一 `cn`/class 合并实现。当前 shadcn 提供 `cn` 迁移路径；若保留 `clsx + tailwind-merge` 自有工具，应选择与 Tailwind v4 匹配的版本并测试冲突类，不混用多个实现。[CLI 迁移说明](https://ui.shadcn.com/docs/cli#migrate-cn)。

Magic UI 先引入极少量组件：去模糊的 BlurFade 用于一次性轻量出现，NumberTicker 仅用于低频完成汇总。原始 NumberTicker 的 locale/颜色及 Motion 的减少动效行为需要项目适配；详见[设计系统动效规范](design-system-proposal.zh-CN.md)。[BlurFade 源码](https://magicui.design/r/blur-fade.json)、[NumberTicker 源码](https://magicui.design/r/number-ticker.json)、[Motion 无障碍](https://motion.dev/docs/react-accessibility)。

组件展示页采用开发入口和固定数据，不暴露真实项目路径；后续组件改动先验证 variants、状态、主题和键盘行为，再更新业务页面。每次引入新 variant 必须说明现有 variant 无法覆盖的原因，避免新技术栈重新长成无标准的样式集合。
