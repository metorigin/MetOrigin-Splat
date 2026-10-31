# Windows 图标：空间切片

## 当前版本：共用 Mac 的 v4 母版

Windows 与 Mac 统一使用 [v4 原始母版](../metorigin-splat-icon-v4.png)，也就是用户提供的图片。其 SHA-256 为 `09344e658af8b37ccf986187f1b82c1e6bf5929b661420263dbf3befff20d9ea`，与 Mac 的 `icons/macos/manifest.json` 输入记录一致。原始母版和 Mac 已编译资源均不修改。

Windows 只确定性处理外围透明留白：以 alpha ≥ 128 的实体边界为基准，每边保留2%安全边距，得到 `[52,48,1202,1198]` 的1150×1150裁切。此步骤逐像素复制原图，不缩放、不调色，也不改变 S 与底座的比例。裁切外最高 alpha 为1，没有裁掉可见图案。之后才由 Tauri CLI 等比导出所需尺寸和 ICO。

- [Windows 派生 PNG](metorigin-splat-shared-v4.png)
- [裁切与像素一致性记录](metorigin-splat-shared-v4.metadata.json)
- 导出资源及来源绑定：`apps/desktop/src-tauri/icons/windows/manifest.json`

维护者使用 Node26、Python/Pillow及项目锁定的 Tauri CLI 重新导出；安装后的应用直接使用包内图标，无需运行脚本。

```powershell
node scripts/windows/Prepare-WindowsIcons.mjs prepare
node scripts/windows/Prepare-WindowsIcons.mjs verify
```

`verify` 重新核对原始像素与确定性裁切、Mac 母版绑定，以及每个 PNG/ICO 输出的校验和，防止只换来源而仍打包旧图标。ICO 保留16/24/32/48/64/128/256px七档，首项为256px。默认窗口保持1200×768逻辑像素、居中和工作区防溢出。侧栏品牌图标继续使用同一 v4 的既有缩图。

`src-tauri/build.rs` 在 Windows 目标下显式跟踪这份自定义 ICO 与 manifest。否则仅替换图标、配置保持不变时，窗口 codegen 图像可能更新，而 Cargo 复用的 PE/winres 图标仍是旧版。打包产物还需独立核对全部七档 PE 图标与默认窗口 RGBA，不能只检查来源文件或编译成功。

## 历史版本 v2（已停用）

2026-10-31：用户反馈任务栏图标仍偏小。只读核对确认已安装 EXE 已使用 v1 的全部七档图标和 256px 默认窗口图，资源没有漏更新。本次使用内置 `image_gen.imagegen` 从 v1 调整为 [v2 母版](metorigin-splat-windows-v2.png)，扩大底座内的白橙主体，同时进一步减少外围透明留白。详见 [完整提示词](metorigin-splat-windows-v2.prompt.md)与[实测记录](metorigin-splat-windows-v2.metadata.json)。

在 alpha ≥ 128、白色主体 RGB 各通道 > 135 的同一测量口径下，主体宽度从画布的 64.75% 增至 77.59%，高度从 66.03% 增至 80.30%，约放大 20%。底座实体宽度由 93.94% 增至 97.37%，高度由 92.19% 增至 96.65%。这是像素构图指标，不把它当作已完成真实任务栏验收。

v2 当时输出到 `target/windows-icon-v2/`。用户后续要求共用 Mac 原始母版，因此这份重绘稿保留为历史记录，不再参与导出或打包。

## 历史版本 v1

2026-10-31：调整 Windows 任务栏中的视觉大小。以现有 [v4 母版](../metorigin-splat-icon-v4.png) 为参考，使用内置 `image_gen.imagegen` 生成 Windows 专用的 [PNG 母版](metorigin-splat-windows-v1.png)。保留空间切片造型、深灰底座、白橙配色，减少外围透明留白。

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
