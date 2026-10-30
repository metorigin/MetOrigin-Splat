# SuperSplat 内部 Jan UI 适配

固定上游：SuperSplat **3.7.0 / b89029dd20911fd18905b61de2701094ac390a73**。本地修改说明：MetOrigin 修改 PCUI 与 SuperSplat 的 UI 配色、字体、面板/菜单/弹窗结构及直方图/性能图的 UI 绘制；不修改模型材质、轴/选择标识、颜色处理、序列化与导出图像算法。

`integrations/jan/theme.json` 是宿主与 iframe 共用的唯一设计色表，固定 Jan `b8d58255baf6d9e870025d3f0c60a5b80a63143b`。`apply.mjs` 在生成副本还原固定源文件后检查 `source-inputs.json` 中的 SHA-256，再应用最小 TypeScript 绘制、重复语言控件及嵌入菜单适配；固定输入包含 `src/main.ts` 与 `src/ui/menu.ts`。Rollup/Sass 编译完成后，PostCSS 逐声明将 UI 中性色/交互色映射到同源 CSS 变量，保留上游选择器与正常、hover、选中、disabled、error、拖动状态。工具/轴/颜色选择器及颜色数据渐变被明确排除；`controls.css` 只调整 UI 的圆角、字体、边框、阴影、焦点与密度。所有代码和派生静态文件通过同一 `prepare.mjs` 生成，禁止人工编辑 public/target 产物。

`runtime.ts` 接收 `theme:{ theme: light|dark, version: jan-v1 }`，不接收 CSS、HTML、URL 或脚本。沿用 bridge 的 parent/source/origin/channel 校验，theme 另检查 UUID 与重复 ID；重复主题新请求幂等。先握手并同步主题，再加载模型；开放操作前再次同步最新主题。后续切换只更新 DOM 变量与 UI 图像，不调用 load、doc.saved 或相机。嵌入模式隐藏 Preferences 的重复语言选择，原 i18n setter 由受控语言 owner 包装；只有宿主中英请求可切换语言（en-US 明确归一为 en），编辑器自身 Reset 无法覆盖宿主 locale。独立运行保留原多语言与自动重置。宿主超时/失败显示非阻断重试行；request 超时、旧回复与 dispose 沿用 Map 清理，不重建 iframe。

嵌入模式隐藏菜单中的 `menu-home` 及其 separator，宿主标题、右下版本、About 与随包NOTICE均保留；独立运行的上游菜单不变。`presentation.ts` 的一次性偏好迁移在 `registerPreferences` 前执行：首次将 `supersplat:preferences.values` 内的 `camera.showInfo`、`view.perfOverlay` 设为 `false`，保留其他值及全部顶层字段，成功写入后记录 `metorigin:supersplat:overlay-defaults:v1=1`。之后不再覆盖用户选择，手动开启仍会记忆。未知偏好版本、损坏或不可用存储不被清空；写入失败不标记完成，下一次启动仍可重试。standalone不执行此迁移。

展开时，嵌入菜单与场景管理器共享24px左边距和320px内容宽度，左右边缘对齐；菜单文字水平内边距为12px。折叠时菜单恢复按内容收窄，独立模式保留含品牌菜单的自适应宽度。

直方图由主题事件立即重绘 ImageData；性能图从缓存时序数据重绘 Canvas，后续帧继续使用同源颜色。尺寸文字为 SVG/CSS，原轴/场景选区颜色保持上游。主题变化不修改数据与 dirty。字体为现有本地 Inter Variable / JetBrains Mono，生成目录包含两份 OFL、Jan 原始版权声明及 Apache-2.0 全文。

`preparationSignature` 包含全部 ui-theme 文件、共享 theme.json、Jan 两份许可、字体与 OFL 哈希以及原 prepare/helper/bridge/WebP 输入。`ui-theme.json` 保存输入身份；资产 inventory 强制要求该文件、字体和许可；验证器同时核对输入与 source map 中的实际 runtime 源码，拒绝缺失/损坏/旧派生资源。来源 patch 锚点与源哈希不匹配时构建失败。

## J21 / J22 可达界面盘点

本表是固定源码入口与实施覆盖，不冒充实机截图通过。每行适用正常/选择/禁用/错误/进行中状态均保留原控制逻辑；真实交互证据统一记录在根 `design-qa.md` 与 `.test-results/jan-ui-migration/`。

| 编号 | 可达入口与固定 src/ui 模块 | 本轮适配 |
| --- | --- | --- |
| J21.01 | 主菜单 File/Edit/Select/Render/Help；menu.ts、menu-panel.ts | PCUI+菜单声明映射、Jan 40px菜单栏、浮层/分隔/禁用/快捷键；嵌入时隐藏menu-home及其分隔，About/版本/NOTICE保留 |
| J21.02 | 右侧选择与变换工具；right-toolbar.ts、transform.ts | 紧凑工具、选中/hover/禁用、表单/向量输入与焦点 |
| J21.03 | 底部相机/显示/选择工具；bottom-toolbar.ts | 浮动工具表面、边框、按钮与分隔 |
| J21.04 | 场景与对象列表；scene-panel.ts、splat-list.ts | 标题、列表行、可见/锁定/选中与重命名输入 |
| J21.05 | 数据面板；data-panel.ts、histogram.ts | 分组/下拉/数值，直方图像素与SVG拖动提示主题重绘 |
| J21.06 | 颜色、外观；color-panel.ts、appearance-panel.ts | 分组行、复位/滑块/输入；颜色数据与渐变保留 |
| J21.07 | 设置与变换；settings-panel.ts、transform.ts | 统一输入、开关、焦点与disabled |
| J21.08 | 底部状态；status-bar.ts | 状态行、文字、数字与surface |
| J22.01 | 时间轴；timeline-panel.ts | 时间刻度、帧数、循环、关键帧、拖动/复制、越界错误与播放按钮 |
| J22.02 | Overlays入口；overlays-panel.ts | 同源面板/开关/分隔；现有可达性不变 |
| J22.03 | 相机与性能信息；camera-info-overlay.ts、perf-overlay.ts | 浮动信息卡/数字/编辑反馈；Canvas缓存数据按主题重绘；嵌入首次迁移默认关闭，后续手动开启保持记忆 |
| J22.04 | 尺寸/边界/朝向；dimension-labels.ts、bound-dimensions-overlay.ts、view-cube.ts | 字体与尺寸文字；三维轴与选择标识保持上游语义 |
| J22.05 | 通用提示/等待；popup.ts、progress.ts、spinner.ts、tooltips.ts | 对话框、按钮、错误、进度inline变量、加载与Tooltip |
| J22.06 | File→Export；export-popup.ts | 类型选择、参数/表单/按钮/警告 |
| J22.07 | Render→Image；image-settings-dialog.ts | PNG/JPEG/WebP、尺寸/相机/透明设置、结果与失败popup |
| J22.08 | Render→Video；video-settings-dialog.ts | 参数、进度与兼容性警告/错误 |
| J22.09 | File→Publish既有入口；publish-settings-dialog.ts | 既有设置表单与反馈；本轮未新增账号、上传或云服务 |
| J22.10 | Help→Shortcuts/About；shortcuts-popup.ts、about-popup.ts | 键帽/列表/技术信息/归属，保留PlayCanvas品牌图形 |
| J22.11 | editor.ts / localization.ts / select-cursor.ts | 稳定容器、原语言机制与选择操作cursor，生命周期保持 |

自动化覆盖 host/bridge、模型加载、图像导出、header安置生命周期，以及 theme/资产身份校验；准确运行次数与本轮结果见根验收记录和对应日志。真实 GPU 编辑、保存重开、多格式图像导出与系统退出必须另实测，不能由这些测试推断。
