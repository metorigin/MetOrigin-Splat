# 桌面应用图标

当前方案：**v4 空间切片 · macOS 原生外轮廓适配**，延续深灰底座、白色 S 形球面切片与橙色内侧。

用户已于 2026-10-30 选定 v3，并要求与常见 Dock 图标的视觉大小对齐。v4 减少外围透明留白，整体放大底座与标记；母版仍为 1254×1254 RGBA PNG，图标外部透明。

- [v4 PNG 母版](metorigin-splat-icon-v4.png)
- [v4 调整说明与完整提示词](metorigin-splat-icon-v4.prompt.md)
- [v4 尺寸与透明度记录](metorigin-splat-icon-v4.metadata.json)

以 alpha ≥ 128 的实体边界测量，底座占画布宽度由 80.86% 增至 88.04%，高度由 79.27% 增至 86.28%，整体约放大 8.9%。不按任意非零 alpha 自动裁边，以免极低透明度的边缘像素影响尺寸判断。

Windows、Linux 和 favicon 的资源位于 `apps/desktop/src-tauri/icons/`，由 Tauri CLI 生成。**macOS 单独使用 `icons/macos/` 中 Apple 编译的 `Assets.car`、兼容 ICNS 与 PNG**，由自动合并的 `tauri.macos.conf.json` 引用。Android/iOS 历史资源保留原状。

2026-10-31 起，Windows 通过独立的 `icons/windows/` 导出图标，并优先以 256px ICO 图像提供窗口图标。按用户要求，当前 Windows 与 Mac 共用这份 v4 原始母版；Windows 仅确定性裁除多余透明留白后等比缩放，保留原图造型与比例。此前 Windows v1/v2 重绘稿已停用。Mac 原生构图与已编译资源保持不变，详见 [Windows 调整说明](windows/README.md)。

重新生成通用、Linux 和 favicon 资源时，在仓库根目录使用 Node 26 执行以下命令，并将输出目录顶层的 PNG、ICNS、ICO 同步到桌面资源目录；不要覆盖 `icons/macos/` 或 `icons/windows/`。Windows 专用资源使用下方链接中的独立生成命令。

```bash
node apps/desktop/node_modules/@tauri-apps/cli/tauri.js icon \
  design/app-icon/metorigin-splat-icon-v4.png \
  --output target/app-icon-v4
```

替换前的 SVG 已归档为 [`legacy/app-icon.svg`](legacy/app-icon.svg)。

v4 初次仅放大 PNG 时，所有尺寸可解码，但 macOS 仍把图案缩进了银色系统底板。后续原生修复见下文。运行中的应用不会自动加载源码目录中的新图标。

## macOS 原生图标

Apple 说明新 macOS 会识别旧图标外形；异形图案会被缩放后放入系统底板。当前母版带透明留白、近似圆角与低透明度边缘，直接转 ICNS 的原生渲染确实出现了套框，不能仅以 PNG 占比或文件哈希判断 Dock 显示已正确。[Apple WWDC25：Say hello to the new look of app icons](https://developer.apple.com/videos/play/wwdc2025/220/)。

原生构图保存在 [`macos/icon.json`](macos/icon.json)。生成脚本把它与原封不动的 v4 PNG 组合为临时 `AppIcon.icon`，通过 Apple `actool` 编译。母版按 1254 像素原尺寸导入，scale=1、平移 [0, 10]；深灰背景填满系统外轮廓，原有底座边缘延伸至遮罩之外。该图像层关闭重复的玻璃、投影与半透明效果，保留白橙 S 的原始造型。不是再次生成或重画图案。

```bash
# 仅修改母版或构图后需要；要求完整 Xcode 26+。
bash scripts/macos/build-app-icon.sh
python3 scripts/macos/verify-app-icon.py
```

普通开发、CI 与打包直接消费已提交的原生资源，无需重新编译图标。`Assets.car` 提供现代高分辨率图标，Apple 生成的 ICNS 提供旧系统回退；PNG 用于 Tauri 开发模式。`manifest.json` 固定源文件和产物哈希。完整打包脚本和 macOS CI 会核对实际应用中的 `CFBundleIconName=AppIcon`、ICNS 及 `Assets.car`，防止漏打包或误用旧资源。

在 macOS 27.0.1 / Xcode 27.1 上，独立测试 bundle 及实际构建的完整 release 应用均通过 `NSWorkspace.icon(forFile:)` 真实系统渲染检查：银色套框消失，外轮廓与常见应用一致，占 1024 画布的 824×824 区域，S 图案约占底座宽度 73%。单独使用 Apple 编译的兼容 ICNS 也未复现套框。实验和实际构建渲染文件位于忽略的 `target/icon-investigation/`；这项验证不等同于替换用户已安装应用或清除存储空间的历史图标索引。

## 历史方案 v3：空间切片

- [v3 PNG 母版](metorigin-splat-icon-v3.png)
- [v3 设计说明与完整提示词](metorigin-splat-icon-v3.prompt.md)

v3 曾通过前端 production 构建及 macOS ARM64 release 构建；当时包内 ICNS 与生成资源字节一致，DMG 已只读挂载并通过应用一致性校验。历史验证仅对应 v3，不作为 v4 的安装包验证。

## 历史方案 v2：高斯原点

版本：v2，2026-10-30。用途：MetOrigin Splat 桌面应用图标设计稿。

- 深石墨色圆角底座，带柔和的立体边缘。
- 珊瑚橙 M 形标记，由厚实、圆润的椭球体交叠构成，呼应 MetOrigin 与 Gaussian Splatting。
- 下方小圆点作为原点，保留简洁的整体轮廓。
- 延续用户参考图中的材质感、圆角和主体辨识度，采用项目现有的珊瑚橙色系。

文件：[`metorigin-splat-icon-v2.png`](metorigin-splat-icon-v2.png)，1254×1254、RGBA、透明背景。原始尺寸与透明度检查见 [`metorigin-splat-icon-v2.metadata.json`](metorigin-splat-icon-v2.metadata.json)。

生成方式：内置 `image_gen.imagegen`，`transparent_background: true`。这是独立新方案，保存在设计目录中。

## 最终提示词

```text
Use case: logo-brand. Create ONE original, finished macOS desktop application icon for MetOrigin Splat, a professional local 3D Gaussian Splatting reconstruction and training app. The user likes the supplied reference aesthetic: compact rounded-square app tiles, one immediately recognizable bold symbol, tactile materials, selective vivid color, convincing soft depth. Translate that visual language into an original identity for this 3DGS product.

Design: a deep graphite / almost-black rounded-square squircle tile, subtly convex with a fine softly illuminated rim, viewed perfectly straight on. In the center is a distinctive sculptural angular M monogram made from four interlocking short, thick, smoothly rounded and gently tapered ellipsoid strokes. It should suggest overlapping Gaussian splats becoming a coherent reconstructed shape, with a clean strong silhouette, NOT a fuzzy particle cloud. The M has a low middle valley and confident raised outer shoulders, one cohesive compact object, slightly faceted volumetric curves rather than tubular wire. One tiny luminous circular origin point sits in the central lower negative space and remains subordinate. Restrained coral-orange materials: warm vermilion #f17455 illuminated top faces, richer burnt orange #be4c30 sides, tiny apricot highlights; subtle reflected warm light on the charcoal tile. Real sculpted depth with soft studio lighting from the upper left, satin ceramic/resin finish, rich readable shadows, premium and calm. Avoid chrome, excessive shine, neon halos or a generic infinite-loop shape.

Composition: square high-resolution icon asset, a single centered icon only. The tile occupies about 84% of the square canvas, equal transparent margins around it; the orange symbol occupies about 66% of the tile. Maintain broad, simple shapes and clear negative space so the silhouette reads at 32 pixels. True transparent alpha outside the complete rounded-square tile, including corners, no drawn checkerboard and no solid external background. Clean antialiased edges. No extra scene, no icon grid, no presentation board, no lettering or words beyond the abstract M-shaped symbol, no watermark, no app screenshot, no small technical decorations, no thin orbit lines, no literal camera or cube. Deliver a polished standalone production-oriented app icon, not a mockup.
```
