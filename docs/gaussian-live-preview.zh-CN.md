# 高斯渲染与训练实时预览

项目详情页的训练、模型校验、导出和预览阶段使用完整的 3D Gaussian Splatting 渲染。预处理仍显示抽取帧，COLMAP 阶段仍显示稀疏点云与相机。

## 使用

在仓库根目录运行：

```powershell
pnpm tauri dev
```

首次使用先安装前端依赖并构建配套引擎。修改 Rust / Tauri 代码后需要重新启动桌面开发进程，单独刷新前端不够：

```powershell
pnpm install --frozen-lockfile
pnpm build:brush:live
```

`build:brush:live` 从 SHA-256 固定的 Brush v0.3.0 源码构建 `brush_live.exe`，放在现有 `brush_app.exe` 旁边。首次构建需要下载 Rust 依赖；缓存齐全后可使用 `pnpm build:brush:live -Offline`。Windows 引擎打包流程也会构建并包含此引擎。

打开已完成项目即可查看已有模型，无需重新训练。新启动的训练会自动使用旁边的实时预览引擎；已经运行的旧 Brush 进程不会被热替换。若配置了其他 Brush 路径，需要将配套引擎构建到该目录。

## 界面行为

- 鼠标左键拖动旋转、滚轮缩放、右键平移；`R` 或重置按钮返回初始视角。
- 优先采用项目的拍摄相机作为初始视角；缺少相机数据时，根据模型范围取景。工具栏也提供查看模型整体和地面网格开关。
- 训练时可选择“实时”“低频”“暂停预览”。暂停预览只停止获取新模型，训练继续。
- 新模型准备好后替换上一帧，保留相机位置。读帧失败时保留已显示模型并提示重试。
- 选择历史 checkpoint 后固定查看该文件；点击“跟随当前阶段”可返回当前阶段预览。
- 页面隐藏或离开项目后停止请求实时快照。请求有 10 秒有效期，窗口异常退出也不会持续要求引擎导出。
- 未安装配套引擎时，可以渲染已经保存的 checkpoint，但无法获取尚未导出的训练模型。

## 实现与边界

前端使用 Spark 2.1.0 / WebGL2 进行高斯投影、深度排序和透明度合成，加载位置、尺度、旋转、不透明度及球谐颜色。通过 Tauri 传输完整二进制 PLY，不再将训练模型裁成最多 20 万个 RGB 点。相机取景中的统计抽样只决定观察位置，不裁剪渲染数据。

实时通道直接读取 Brush 的训练中模型。Brush 每 5 次迭代提供一次 TrainStep 消息；实时模式最小间隔为 5 步，低频模式为 100 步。只有前端请求且确认上一帧已安装后才生成下一帧。前端通常每 500 毫秒检查一次，低频模式每 1500 毫秒检查一次；实际模型更新速度取决于训练、模型大小、传输与解码耗时，不能理解为每 5 步都会显示一帧或固定视频帧率。

快照位于 `training/live-preview/<session-id>/`，每个训练会话保留最近两帧；模型写完后才发布 `latest.json`。该通道独立于恢复用 checkpoint，不改变 checkpoint 间隔。新训练使用新的会话标识，避免把上次训练帧误认为当前帧。

这是 WebView 内的高斯查看器与 Brush 训练模型之间的实时通道，不是把 Brush 原生窗口嵌入页面。跨进程快照需要 GPU 回读、文件传输和解码，会增加部分训练开销；Brush 原生界面可以共享进程内模型，两者性能与像素结果不保证完全相同。画面质量仍取决于训练数据、迭代和现有模型质量。

目前支持 Brush 的二进制小端 float32 PLY、SH 0–3 阶，单个 PLY 上限 1 GiB。超限、未写完、属性不完整或越出项目目录的文件会明确报错。Spark 模块按需加载，构建时会产生较大的独立渲染资源包。

## 验证

常规检查与真实引擎测试见[开发指南](development.md)。历史原生验证曾在 Windows / WebView2 / RTX GPU 上完成 95,563 个高斯的完整加载，以及单独的 3,000 步训练：训练结束前出现多次模型更新，暂停预览时训练继续，恢复后继续更新，快照缓存保持最多两帧。该记录是特定环境的基线，不代表每次更新都已重新完成相同 GPU 验证。

复现时先确认依赖和实时预览引擎已准备好。启动 `pnpm dev`，在另一个 PowerShell 终端启动隔离测试应用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Start-PreviewValidation.ps1
pnpm test:gaussian:native "D:/path/to/completed.splat-project"
```

启动脚本使用离线 Cargo 构建，需要已有完整依赖缓存，并使用独立应用标识与浏览器数据目录。不要同时运行占用同一 Vite 端口的 `pnpm tauri dev`。测试输入应包含 `output/scene.ply` 和准备好的 `training/dataset`。验证程序读取该数据并运行隔离的 GPU 训练，输出写入 `.test-results/gaussian-live/`，包含截图、日志和 JSON 报告。

验证结束后停止脚本启动的测试应用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Start-PreviewValidation.ps1 -StopOnly
```

原生 GPU 进程必须能在当前运行环境中正常启动；无法启动时，应记录环境限制，不能据此判断训练引擎通过或失败。不要将测试生成的模型、截图和日志加入 Git。
