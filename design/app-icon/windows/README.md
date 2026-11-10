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

## 历史版本

Windows v1/v2 重绘稿、原始提示词和测量结果已移到[历史图标档案](archive/README.md)。当前导出始终使用 shared-v4 派生 PNG，不恢复旧重绘稿。旧资源的来源字段按原记录保留。

当前候选构建与原生验收边界见[项目状态](../../../docs/status.md)。
