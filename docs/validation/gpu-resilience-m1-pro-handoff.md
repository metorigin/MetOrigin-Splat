# GPU 后端可靠性：Mac M1 Pro Codex 验收交接

本轮 M1 Pro 验收状态：**未执行**。由用户在实际 Mac M1 Pro 上运行本文件。
Windows RTX 5080 的结果不能替代本项；旧 `macos-m1.md` 等历史结果也不能计作本分支验收。
只覆盖 Apple M1 Pro，不扩展到其他 Mac。无需修改系统驱动或用户已安装的应用。

## 0. 从远端分支获取源码（首选）

仓库：`git@github.com:metorigin/MetOrigin-Splat.git`。
验收分支：`codex/gpu-backend-resilience`，对应远端 `origin/codex/gpu-backend-resilience`。
已推送的实现基准 commit：`908863b4db00b22d8245eb37576aef71ede0ee40`。
随后追加的交接文档提交可以位于该基准之上；实际验收须记录最终 checkout 的完整 HEAD。
优先从 Git 获取完整分支，不需要下载或应用 ZIP。所有源码命令从应用仓库执行，
不要误在后文的独立 Brush 源码目录中运行。

新建 checkout 时，先把占位符替换为一个**尚不存在**的绝对路径：

```sh
git clone --single-branch --branch codex/gpu-backend-resilience \
  git@github.com:metorigin/MetOrigin-Splat.git "/absolute/new-metorigin-splat"
cd "/absolute/new-metorigin-splat"
git branch --show-current
git rev-parse HEAD
git rev-parse origin/codex/gpu-backend-resilience
git status --short
```

已有 checkout 时，先进入其根目录，再执行下面的受保护更新。工作区有修改或未跟踪文件时
立即停止；不要自动 stash、reset、clean、覆盖或丢弃用户内容，可以改用上述新 checkout。
如果本地分支有未推送提交或已分叉，`--ff-only` 或末尾 HEAD 比较会阻止后续验收，
也应保留原分支并使用新 checkout。SSH 权限或远端读取失败时报告具体错误，不切回 main 代替。

```sh
(
  set -e
  test -z "$(git status --porcelain)" || { echo "工作区不干净，请保留修改并改用新 checkout。" >&2; exit 1; }
  case "$(git remote get-url origin)" in
    git@github.com:metorigin/MetOrigin-Splat.git|https://github.com/metorigin/MetOrigin-Splat.git) ;;
    *) echo "origin 不指向目标仓库；请核对，不自动修改远端。" >&2; exit 1 ;;
  esac
  git fetch origin refs/heads/codex/gpu-backend-resilience:refs/remotes/origin/codex/gpu-backend-resilience
  if git show-ref --verify --quiet refs/heads/codex/gpu-backend-resilience; then
    git switch codex/gpu-backend-resilience
  else
    git switch --track -c codex/gpu-backend-resilience origin/codex/gpu-backend-resilience
  fi
  git merge --ff-only origin/codex/gpu-backend-resilience
  test "$(git rev-parse HEAD)" = "$(git rev-parse origin/codex/gpu-backend-resilience)" || {
    echo "本地与远端 HEAD 不一致；保留本地提交并改用新 checkout。" >&2; exit 1;
  }
  git branch --show-current
  git log -1 --format='%H %s'
  git status --short
)
```

开始验收前记录实际完整 HEAD，并确认分支正确、工作区干净。测试结果必须绑定这个 HEAD；
如验收期间修复代码，另外记录修复提交或工作区 diff，不能沿用修复前的通过结论。
确认当前 HEAD 包含已推送的实现基准；下面的 ancestry 检查须退出 0，否则停止并核对源码，
不能改用旧 main 或省略该检查：

```sh
git show --no-patch --format='%H %s' 908863b4db00b22d8245eb37576aef71ede0ee40
git merge-base --is-ancestor 908863b4db00b22d8245eb37576aef71ede0ee40 HEAD
```

完整分支包含 `integrations/brush-windows/source-lock.windows1-legacy.json`、两平台
resilience 补丁和 `scripts/shared/validate-gpu-resilience.mjs`。Rust 在编译期包含 Windows
来源锁，不能因为是 Mac 而省略它；Windows 补丁链不用于构建 Metal 引擎。

`m1-pro-source-handoff.zip` 仅是之前未提交工作树的历史交接材料，不是当前验收前置条件，
也不应叠加到已经同步的 Git 分支上。只有明确需要重现那个历史快照时，才按其
`handoff-manifest.json` 的 base commit、逐文件 SHA-256 和补丁恢复到另一个干净目录。
该 ZIP 绑定 manifest 中的历史快照，不会随远端后续提交更新；当前验收以远端分支和本文件为准。

## 给 Mac 上 Codex 的任务

请在包含 `codex/gpu-backend-resilience` 最新代码的 MetOrigin-Splat 仓库执行本文，
先检查适用的 AGENTS.md，记录 Git HEAD、未提交修改、系统版本、内存和硬件。
保护用户现有项目与安装，所有训练使用新建测试目录。持续完成可执行验证，
如设备、引擎或 fixture 不可用，具体说明缺失路径或依赖。不得把单元测试、
跨平台编译、历史证据或 Windows 结果写成 Metal 原生验收通过。

在 Mac 上完成上述 checkout 后，可直接把以下内容交给该仓库的 Codex：

```text
请在这台实际 Apple M1 Pro 上执行 docs/validation/gpu-resilience-m1-pro-handoff.md。
先读取 AGENTS.md，确认当前是 origin/codex/gpu-backend-resilience 对应的干净分支并记录完整 HEAD。
确认 HEAD 包含实现基准 908863b4db00b22d8245eb37576aef71ede0ee40。
按文档构建 .6-resilience Metal 引擎，完成真实预检、3000 步训练、checkpoint 恢复、保存、导出、重开、原生 GUI 与隔离载荷检查。
保护已有修改、项目和安装，不测试其他硬件，不以 Windows、历史证据或单元测试代替 Mac 原生验收。
持续完成可执行工作；缺设备、工具、引擎来源或照片时说明具体缺项。
把每项 PASS / FAIL / NOT RUN、实际命令、版本/hash、证据路径和失败原因写入 docs/validation/gpu-resilience-m1-pro-results.md；未执行项保持未执行，不预填成功结果。
```

## 1. 确认硬件、来源和工具

```sh
git branch --show-current
git rev-parse HEAD
git status --short
uname -sm
system_profiler SPHardwareDataType SPDisplaysDataType
sw_vers
sysctl -n hw.memsize
node --version
pnpm --version
python3 --version
rustup toolchain list
xcodebuild -version
xcrun --sdk macosx --show-sdk-version
```

要求原生终端显示 `Darwin arm64`、芯片为 `Apple M1 Pro`，Node 26、pnpm 11.12.0、
Python 3 和可用的 Xcode/macOS SDK。配方声明最低 macOS 15.0；记录实际运行系统，
不把较新系统的结果写成 macOS 15 验收。应用使用 Rust 1.97.0，
独立 Brush 构建使用 Rust 1.95.0。不要改共享 toolchain 文件去适配本机；
用进程级 `RUSTUP_TOOLCHAIN` 指定。检查四引擎确为 arm64；保留完整 SHA-256、
build-info、源 commit、补丁 hash、动态库清单和包 manifest 核对结果。

Mac 继续使用 Metal，现有固定来源是 Brush commit
`1388f74c6fe0236f68ee4915564bf00e9d2e3747` 和 `metorigin-macos.6` 累积补丁。
Windows 增量补丁不应套到 Mac。本分支新增 `metorigin-macos.6-resilience` 累积诊断
profile，原 `.6` 文件保持不变。新补丁 SHA-256 为
`7e9e81cc0203b61ffb0f606a81a4c84816fbed5179c1a14f0870a8ca1fd5007b`。
引擎仍返回 `.6` 协议身份，能力中新增 `probe_diagnostics_v1`，通过完整补丁/EXE hash
区分候选版本。必须测试该诊断候选，不能拿旧 `.6` EXE 替代。
不得直接使用 Windows EXE 或 DXC DLL。

以下 shell 块均从 MetOrigin-Splat 仓库根目录执行，先替换全部 `/absolute/...`
占位符。`BRUSH_SOURCE`、`BRUSH_BUILD`、后续 artifact/pack 目录互不包含。
使用新的独立 checkout；若已经有符合条件的独立源码，则检查 commit、detached 状态
和工作区后跳过 clone，不能在已经套用 `.6` 的源码上再叠加此累积补丁。

```sh
BRUSH_SOURCE="/absolute/new-isolated-brush-source"
BRUSH_BUILD="/absolute/new-resilience-build"
git clone --no-checkout https://github.com/MinKaiZhi/brush "$BRUSH_SOURCE"
git -C "$BRUSH_SOURCE" checkout --detach 1388f74c6fe0236f68ee4915564bf00e9d2e3747
(
  unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_TARGET_DIR
  export RUSTUP_TOOLCHAIN=1.95.0
  bash scripts/macos/build-brush.sh --gpu-resilience-patch "$BRUSH_SOURCE" "$BRUSH_BUILD"
)
BRUSH_BINARY="$BRUSH_BUILD/target/aarch64-apple-darwin/release/brush-cli"
python3 scripts/macos/prepare-brush-source.py "$BRUSH_SOURCE" \
  --profile metorigin-macos.6-resilience --verify
"$BRUSH_BINARY" --capabilities-json
shasum -a 256 "$BRUSH_BINARY"
```

能力输出必须含 `probe_diagnostics_v1`、`aarch64-apple-darwin` 和
`1.0.0+metorigin-macos.6`；核对 `evidence/build-info.json` 的 binary/patch/Cargo.lock
哈希。上述命令清除继承的 `CARGO_TARGET_DIR`，因此实际 Mach-O 位于给出的
`BRUSH_BINARY`；保留完整 `evidence/`，不要手改 build-info 中尚未验收的状态字段。

优先复用本机已核对来源的完整 Mac 引擎包；如果缺少，引擎构建与打包入口见
`scripts/macos/README.md`、`scripts/macos/build-brush.sh`、
`scripts/macos/build-macos-app.sh` 和 `packaging/shared/engine-paths.json`。
源码 checkout 必须独立、detached、匹配固定 commit，不能在用户 Brush 开发目录直接打补丁。
完整 pack 检查的输入是包含 `engine-manifest.json` 的 **engines 子目录**。
使用 `pack-engines.py` 时，新 profile 必须显式传 `--brush-source`（独立源码目录），
并把候选 `brush-cli` 与 `evidence/build-info.json` 放到同一新 artifact 目录，
以 `--brush-artifact` 指向该目录；原始证据目录另行保留。默认路径表仍指向旧 `.6`，
不要让默认 pack 路径意外替换掉此次诊断候选。

核心训练可以直接使用 `BRUSH_BINARY`，无需等待完整应用打包。打包阶段可按下列模板
准备不可变 Brush artifact；COLMAP/FFmpeg 的 source、build-info、安装目录和依赖缓存
必须按本机已核验路径显式传入 `pack-engines.py`，或先确认路径表默认值确实指向它们。
仅有一个旧 Mac 成品包而缺少这些来源材料时，应报告缺失材料，不能手改旧 manifest。

```sh
BRUSH_ARTIFACT="/absolute/new-resilience-brush-artifact"
PACK_ROOT="/absolute/new-resilience-macos-pack"
mkdir "$BRUSH_ARTIFACT"
cp "$BRUSH_BINARY" "$BRUSH_ARTIFACT/brush-cli"
cp "$BRUSH_BUILD/evidence/build-info.json" "$BRUSH_ARTIFACT/build-info.json"
cp "$BRUSH_BUILD/evidence/distribution-policy.json" "$BRUSH_ARTIFACT/distribution-policy.json"
python3 scripts/macos/pack-engines.py --help
# 确认其他引擎输入路径后执行；需要覆盖默认值时追加 --colmap-*、--ffmpeg-* 等实际参数。
python3 scripts/macos/pack-engines.py --brush-artifact "$BRUSH_ARTIFACT" \
  --brush-source "$BRUSH_SOURCE" --output "$PACK_ROOT/engines"
python3 scripts/macos/verify-pack.py "$PACK_ROOT/engines" --relocate \
  --report-dir "$PACK_ROOT/relocation-evidence"
```

pack 会记录重定位/签名后的文件哈希；它们可能不同于原始 build 的哈希，应通过
`brush/provenance/original-build-info.json` 和 `relocation-map.json` 追溯来源。
`release-status.json` 中未完成的发布门禁照实保留，本任务不要求公证或外部发布。

## 2. 准备不可变照片 fixture

使用 `packaging/macos-arm64/fixtures/james-sample-40.json` 的 James40 CC0 原图。
若已有正确 fixture，直接复用只读输入。若缺少，参照
`packaging/macos-arm64/fixtures/README.md` 下载固定归档并运行
`scripts/macos/prepare-smoke-fixture.py`，所有输出放 `.cache/metorigin/` 下的新目录。
验收程序会逐图核对 SHA-256；不得用不同照片绕过核对，也不得修改原图。
传给 `METORIGIN_TEST_IMAGE_DIR` 的路径是 fixture 的 `images/` 子目录，内含固定 40 张照片，
不是已经执行 SfM 的训练目录。下载受限时，fixture 工具接受已验证的子集/局部归档，
但必须保留其 `whole_archive_verification` 实际状态，不能将逐图通过写成整个归档通过。

## 3. 核心回归与真实 3000 步训练

先将下列路径替换为本机核验过的绝对路径（不能照抄示例占位符）：

```sh
export RUSTUP_TOOLCHAIN=1.97.0
export METORIGIN_TEST_BRUSH="$BRUSH_BINARY"
export METORIGIN_TEST_COLMAP="/absolute/native/colmap/bin/colmap"
export METORIGIN_TEST_FFMPEG="/absolute/native/ffmpeg/bin/ffmpeg"
export METORIGIN_TEST_FFPROBE="/absolute/native/ffmpeg/bin/ffprobe"
export METORIGIN_TEST_IMAGE_DIR="/absolute/james40/images"
python3 -m unittest scripts/macos/test_prepare_brush_source.py scripts/macos/test_build_brush.py
cargo test --locked -p splat-engine-brush -p splat-pipeline -p splat-project --lib
node scripts/shared/validate-gpu-resilience.mjs metal
```

脚本限制硬件为 M1 Pro，运行生产十二阶段、CPU COLMAP、Metal 真计算，
冻结 3000 步、SH0、960px 的显式验收配置；这不是默认预设画质比较。
训练完检查 PLY 和 checkpoint，恢复一个中间 checkpoint，再次完成到 3000 步，
检查归档旧结果、重新打开项目、缓存重开、重新导出并核对完整模型哈希。
PLY warm start 会重置优化器，记录 `optimizer_state_restored=false` 才符合实际语义。
该 Mac 核心脚本验证的是照片输入、显式 checkpoint 恢复和项目重开；它没有实际操作
原生暂停按钮、编辑器或导入独立拍摄视频，这些不能从核心 receipt 推断为已通过。

结果自动写入 `artifacts/verification/macos-arm64/tests/gpu-resilience-metal/current/`
或 `failed/`，保留 `receipt.json`、`cargo.log`、`debug/projects/` 项目与底层日志。
最终 receipt 中 `native_ui_verified=false` 和 `installer_verified=false` 是准确的范围标记，
只有下一节另行完成才能在最终验收报告中记录 GUI 或包的通过结果。
receipt 同时记录 runner 哈希、Git tracked diff 哈希和未跟踪源码逐文件哈希；交接包
应用后存在未提交变更是允许的，应保存这些字段。若打印 `publication_error` 或退出码
非零，即使计算部分已记录 `PASS`，仍须按终端提示保留原始目录并单独处理证据发布失败。

## 4. 实际原生界面和安装载荷回归

构建本分支原生应用到隔离目录，使用原生窗口操作测试副本，记录应用 EXE/Mach-O hash、
包 manifest hash、PID、实际引擎 hash 与每一步截图/日志。执行：

应用构建前准备 `pnpm install --frozen-lockfile` 及现有脚本要求的应用许可证/前端来源材料
（见 `docs/macos-packaging.zh-CN.md`）；缺失时列出具体路径，不将缺少材料当作 GPU 失败。
使用刚生成的 `PACK_ROOT`，运行本地内部 `.app` 构建，不申请 Developer ID 或公证：

```sh
(
  unset CARGO_TARGET_DIR
  export RUSTUP_TOOLCHAIN=1.97.0
  bash scripts/macos/build-macos-app.sh --internal-alpha --app-only --engine-pack-root "$PACK_ROOT"
)
```

此脚本当前把 `.app` 写到仓库 `target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app`，
未提供任意 Cargo 输出目录选项；不要继承 Brush 的 `CARGO_TARGET_DIR`。若该路径已有需保留
的构建，先使用新的独立应用 checkout 执行，或保留现有候选；不替换用户 `/Applications`
中的安装。启动时核实窗口 PID 对应本次 `.app`，其实际 Brush 为包内候选且包含诊断能力。

1. 设置页只显示 Metal；无 Auto/DX12/Vulkan 控件。引擎版本已检查不能被显示为 GPU 已计算验证。
2. 新项目预检显示实际 Apple M1 Pro / Metal，完成 Gaussian forward/backward 后才允许创建。
3. 原生向导创建照片项目，完整训练至设定目标，验证 checkpoint、保存、查看器和实时预览。
4. 正常暂停并继续、明确恢复 checkpoint；恢复与重新打开均保持 Metal，不改变冻结 API。
5. 在编辑器做一个可识别的小改动并保存，导出模型，正常关闭并重新打开项目，确认修改与模型可见。
6. 设置中导出诊断：无项目首次预检日志也应可导出；常规 UI 不应显示原始私密路径。
7. 检查 app 自包含动态依赖及完整哈希；用隔离复制载荷验证。不得覆盖用户现有安装。

驱动/系统、引擎或依赖变化的测试只在测试副本进行；真正创建或启动训练前应真实重检。
已经完成的项目只做缓存重开时允许跳过训练，不能将这种跳过记作重新执行 GPU 计算。
损坏引擎或无效协议必须阻止；Mac 不得尝试 Windows 后端。取消后确认本次子进程退出，
不按名称批量结束用户进程。无需修改系统驱动来模拟变化。

## 5. 回传给 Windows 会话的结果

执行后新建结果文档 `docs/validation/gpu-resilience-m1-pro-results.md`，不要在尚未执行时
创建含有通过结论的结果。若此路径已有先前结果，先读取并保留，按实际执行日期和 HEAD
追加新一轮记录，不覆盖历史结论。逐项写 `PASS / FAIL / NOT RUN`：硬件身份、版本和 hash、
单元回归、Metal 预检、3000 步训练、checkpoint/恢复、编辑保存、导出、重新打开、
诊断导出与原生包完整性。附每项证据路径及失败原因链；区分核心脚本与原生 UI 结果。
文档开头记录应用仓库 URL、分支、完整 HEAD、起止时间、实际 M1 Pro/系统身份，
以及验收期间发生的源码修改；最后列出阻塞项和仍需的具体操作。
只传必要摘要和经检查的诊断包；不要把本机私密路径贴进普通截图或用户界面。
Windows 会话只有在收到真实 M1 Pro 结果后才能合并验收状态。
