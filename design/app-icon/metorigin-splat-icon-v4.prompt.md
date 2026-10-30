# 图标 v4：空间切片 · Dock 尺寸调整

用户要求现有图标在 Dock 中与参考应用的视觉大小接近。保留 v3 的空间切片设计，减少外部透明留白，同时放大底座和标记。

使用内置 `image_gen.imagegen` 编辑 v3，`transparent_background: true`。项目母版为 [`metorigin-splat-icon-v4.png`](metorigin-splat-icon-v4.png)，尺寸及透明度见 [`metadata`](metorigin-splat-icon-v4.metadata.json)。此前 v3 文件保留。

提示词目标为约 90% 的底座宽度，实际生成结果为 88.04%（alpha ≥ 128）。相对 v3 的 80.86% 放大约 8.9%；高度同样约放大 8.9%。PNG、ICNS 和 ICO 由 Tauri CLI 从同一母版生成。

## 完整编辑提示词

```text
Use case: precise-object-edit. Asset type: production desktop app icon, transparent PNG. Edit target: the provided MetOrigin Splat v3 icon. The ONLY requested change is its size inside the square canvas: enlarge the WHOLE existing rounded charcoal tile together with its unchanged ivory S-shaped spherical slices and orange inner cut surface by approximately 1.12x, centered, so the solid outer rounded-square tile spans 90% of canvas width and about 89% of canvas height, leaving about 5% transparent margin on each side. This is a mechanical composition/scale correction, NOT a redesign. Preserve the exact emblem shape, proportions of emblem to tile, diagonal angle, ivory and coral orange colors, charcoal material, rounding and original lighting as closely as possible. Maintain crisp clean antialiased edges. Do not add any outer silver/white rounded tile or second frame. No background, no shadow beyond safe margins, no text, no extra motifs, no presentation mockup. True transparent alpha outside the whole charcoal tile, including rounded corners. Output one square icon only.
```
