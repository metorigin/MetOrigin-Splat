# 历史 Windows 图标

本目录保存已停用的 v1/v2 重绘稿、原始提示词和测量 metadata；不参与当前导出或打包。当前 shared-v4 流程见[Windows 图标维护入口](../README.md)。

图片、metadata 和提示词保持原始字节。v1 metadata 的 `source_reference: ../metorigin-splat-icon-v4.png` 是归档前的相对路径；其实际来源仍是[共用 v4 母版](../../metorigin-splat-icon-v4.png)。下面代码块是原时点操作记录，当前脚本不会据此重新生成旧版本；历史像素测量和构建结论不等于新构建通过。

## 历史版本 v2（已停用）

2026-10-31：用户反馈任务栏图标仍偏小。只读核对确认已安装 EXE 已使用 v1 的全部七档图标和 256px 默认窗口图，资源没有漏更新。本次使用内置 `image_gen.imagegen` 从 v1 调整为 [v2 母版](metorigin-splat-windows-v2.png)，扩大底座内的白橙主体，同时进一步减少外围透明留白。详见 [完整提示词](metorigin-splat-windows-v2.prompt.md)与[实测记录](metorigin-splat-windows-v2.metadata.json)。

在 alpha ≥ 128、白色主体 RGB 各通道 > 135 的同一测量口径下，主体宽度从画布的 64.75% 增至 77.59%，高度从 66.03% 增至 80.30%，约放大 20%。底座实体宽度由 93.94% 增至 97.37%，高度由 92.19% 增至 96.65%。这是像素构图指标，不把它当作已完成真实任务栏验收。

v2 当时输出到 `target/windows-icon-v2/`。用户后续要求共用 Mac 原始母版，因此这份重绘稿保留为历史记录，不再参与导出或打包。

## 历史版本 v1

2026-10-31：调整 Windows 任务栏中的视觉大小。以现有 [v4 母版](../../metorigin-splat-icon-v4.png) 为参考，使用内置 `image_gen.imagegen` 生成 Windows 专用的 [PNG 母版](metorigin-splat-windows-v1.png)。保留空间切片造型、深灰底座、白橙配色，减少外围透明留白。

实测 alpha ≥ 128 的实体宽度占比由 88.04% 增至 93.94%，高度占比由 86.28% 增至 92.19%；实际输出与提示词的目标值分开记录，详见 [尺寸记录](metorigin-splat-windows-v1.metadata.json)。ICO 和 PNG 由 Tauri CLI 从同一母版生成。Windows 使用独立的 `icons/windows/` 资源，macOS 保持原生图标构图。

Windows ICO 保留多尺寸图像，并将 256px 图像的目录项放在第一位：Tauri 的默认窗口图标解码使用 ICO 第一项，避免以 32px 位图作为所有 DPI 下的窗口图标来源。该重排仅改变容器目录顺序，不更改各图像的像素。EXE、窗口与安装包使用同一个 Windows ICO。

侧栏品牌图标复用现有 v4 的 128px 导出资源，位于 `apps/desktop/src/assets/app-icon.png`，显示尺寸为 28px。

在仓库根目录使用 Node 26 重新生成或只读验证：

```powershell
node scripts/windows/Prepare-WindowsIcons.mjs prepare
node scripts/windows/Prepare-WindowsIcons.mjs verify
```

`prepare` 只更新 Windows 专用资源。`verify` 检查 ICO 全部尺寸、第一项顺序、配置引用，并输出各尺寸的 alpha 实体边界；macOS 的配置与原生图标保持独立。

## 编辑提示词

```text
Use case: precise-object-edit. Edit target: the attached existing MetOrigin Splat v4 app icon. Asset type: Windows desktop application icon, transparent square PNG, one finished icon only. The user wants the exact existing icon to have the same optical size as neighboring Windows taskbar icons. Change ONLY the composition/scale inside the transparent canvas: enlarge the COMPLETE existing charcoal rounded-square tile and its white/ivory spherical S slices with orange inner surface uniformly by about 1.11x, centered. The SOLID CHARCOAL TILE should span 98% of canvas width and about 96% of canvas height (approximately 1% transparent side margins, 2% top/bottom margins). Preserve the entire tile and rounded corners with a tiny safe margin: do not clip its edges. Preserve the exact original emblem shape, curved cut profile, angle, proportions of emblem relative to tile, materials, shading, color and fine edges as closely as possible; no redrawing or redesign. No added frame, no silver surround, no new shadows, no extra effects, no letters, no words, no mockup. True transparent alpha outside the rounded tile. Square high resolution, clean antialiasing and strong silhouette at 32px. This is only a Windows optical-size correction of the supplied existing raster asset.
```
