# 历史桌面图标

本目录保存已停用的设计稿、原始提示词、测量 metadata 和早期 [SVG](legacy/app-icon.svg)。它们不参与当前图标导出或打包；当前母版与平台生成命令见[图标维护入口](../README.md)。

图片、metadata 和提示词保留归档前字节。metadata 内的文件名、来源字段和下面的构建结论属于当时设计时点；它们不是新版本的验收结果。

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
