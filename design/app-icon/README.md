# 桌面应用图标

当前方案：**v3 空间切片**，深灰底座、白色 S 形球面切片与橙色内侧。

用户已于 2026-10-30 选定并采用此方案。母版为 1254×1254 RGBA PNG，图标外部透明。

- [v3 PNG 母版](metorigin-splat-icon-v3.png)
- [v3 设计说明与完整提示词](metorigin-splat-icon-v3.prompt.md)

桌面资源位于 `apps/desktop/src-tauri/icons/`：PNG 各尺寸、macOS `icon.icns`、Windows `icon.ico` 与应用商店 Logo 均由该母版通过项目安装的 Tauri CLI 生成。favicon 使用同一套 `32x32.png`。Android/iOS 历史资源保留原状。

重新生成时，在仓库根目录使用 Node 26 执行以下命令，并将输出目录顶层的 PNG、ICNS、ICO 同步到桌面资源目录：

```bash
node apps/desktop/node_modules/@tauri-apps/cli/tauri.js icon \
  design/app-icon/metorigin-splat-icon-v3.png \
  --output target/app-icon-v3
```

替换前的 SVG 已归档为 [`legacy/app-icon.svg`](legacy/app-icon.svg)。

验证：桌面资源可解码、尺寸与引用正确；前端 production 构建及 macOS ARM64 release 构建通过；包内 ICNS 与生成资源字节一致，DMG 已只读挂载并通过应用一致性校验。Windows 图标资源已生成，未执行 Windows 安装包构建。

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
