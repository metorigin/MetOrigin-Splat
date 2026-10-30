# macOS 安装包打包命令

适用于 MetOrigin Splat 的 Apple Silicon（arm64）完整内部 Alpha 包。DMG 包含应用、FFmpeg/FFprobe、COLMAP、Brush 及对应运行资源，配置的最低系统版本为 macOS 15.0；最低系统与其他硬件的验收仍须单独完成。

完整打包入口为 [`scripts/macos/build-macos-app.sh`](../scripts/macos/build-macos-app.sh)，资源配置为 [`tauri.macos.full.conf.json`](../apps/desktop/src-tauri/tauri.macos.full.conf.json)。仅复制代码框中的命令，不要复制步骤编号、终端提示符或示例输出。

## 1. 环境与输入

在项目根目录执行。以下 `cd` 路径是占位示例，请替换为你的实际仓库目录。

```bash
cd /path/to/MetOrigin-Splat
export PATH="$HOME/.cargo/bin:$PATH"

node --version
pnpm --version
cargo --version
python3 --version
xcode-select -p
```

| 项目 | 要求或说明 |
| --- | --- |
| 构建主机 | Apple Silicon Mac；脚本检查 Darwin/arm64 |
| Node.js | 开发和 CI 统一使用 Node 26；CI 从根目录 [`.node-version`](../.node-version) 读取版本，[`.nvmrc`](../.nvmrc) 供 nvm 使用。确认实际 `node --version` 为 `v26.x`；历史构建记录保留当时实际使用的版本 |
| pnpm | 项目固定 `11.12.0`；需要让打包脚本启动的 bash 子进程也能找到它 |
| Rust | 使用仓库 `rust-toolchain.toml` 指定的工具链，并准备 `aarch64-apple-darwin` 目标 |
| Apple 工具链 | Xcode/Command Line Tools，包含 codesign、hdiutil 等工具 |
| 应用依赖 | 首次克隆或依赖变化后执行 `pnpm install --frozen-lockfile`；已有匹配依赖时无需重复安装 |
| 引擎包 | 必须先取得或生成下表中的 arm64 引擎包；新克隆不会自带 `target/` 产物 |

当前完整打包脚本和资源配置共同固定以下输入目录：

| 输入 | 路径 |
| --- | --- |
| 引擎及完整性清单 | `target/distribution/macos-arm64/engines/` |
| 引擎分发状态 | `target/distribution/macos-arm64/release-status.json` |
| 应用许可证据 | `target/macos-m4/app-license-evidence/licenses/` |

应用“设置”中的本地引擎路径不会替代这些打包输入。引擎准备方法见 [macOS engine packaging](../packaging/macos-arm64/README.md)。`APP_LICENSE_ENGINE_PACK` 只改变许可收集器读取的引擎来源，不能改变完整安装包脚本的固定资源路径。

## 2. 常规重复打包

当依赖、锁文件、复制 UI、SuperSplat 资源及相关派生补丁与已收集清单仍匹配时，直接执行：

```bash
bash scripts/macos/build-macos-app.sh --internal-alpha
```

默认生成 release `.app` 和完整 DMG，前端会在构建时重新编译。脚本还会执行引擎解析及版本预检、最终资源/签名完整性校验，以及 DMG 只读挂载比对；这些预检不启动训练。

脚本会先检查 node、pnpm、cargo、python3 是否可执行，以及 Node 26.x / pnpm 11.12.0 是否匹配；工具缺失或版本不符时，在引擎预检和编译之前退出。

如果提示输入、资源或许可证清单不匹配，先执行下一节，不要跳过校验。构建期间不要同时改动源码、依赖、资源或清单。

### Node 26 与 pnpm 命令入口

使用现有 Node 管理器安装并选择 Node 26。使用 nvm 时，可在项目根目录执行以下可选步骤，它们读取 `.nvmrc`；使用 Vite+ 等其他管理器时，按该管理器的方式选择 Node 26，并核对实际版本：

```bash
nvm install
nvm use
```

```bash
node --version
npm --version
```

pnpm 版本继续固定为 11.12.0。已有匹配的可执行入口时无需重复安装；尚未安装时，使用当前 Node 26 对应的 npm：

```bash
npm install --global pnpm@11.12.0
```

如果安装成功后 bash 仍提示找不到 pnpm，将实际安装目录加入 PATH；对于上述 npm 全局安装，可使用：

```bash
export PATH="$PATH:$(npm prefix --global)/bin"
bash -c 'node --version && pnpm --version'
```

追加目录会优先沿用原 PATH 中的 Node。只在当前 shell 定义 `pnpm` alias 或 function，不能保证打包脚本的 bash 子进程能找到它。需要排查多个入口时执行：

```bash
type -a node
type -a npm
type -a pnpm
```

本机历史构建曾通过追加已有 nvm `v26.5.0/bin` 中的 Corepack 入口找到 pnpm，以下方式对该现有目录仍适用；它只是本机历史路径，不是通用安装步骤：

```bash
env PATH="$PATH:$HOME/.nvm/versions/node/v26.5.0/bin" \
  bash -c 'node --version && pnpm --version'
```

本机同时存在 Vite+ 和 nvm 的 Node 入口，历史上曾出现 `nvm use 22` 后，后续命令实际由 Vite+ Node 26.13.0 执行的情况。当前统一以实际输出为 Node 26 为准；许可证清单本身不绑定运行收集器的 Node 版本。历史验收中的 Node 22 记录不改写为 Node 26；本次基线调整也不追认历史产物为 Node 26 验收。

## 3. 首次生成或更新许可证清单

首次准备安装包，或相关依赖、锁文件、复制 UI、SuperSplat 集成/主题资源、Spark/Three 派生补丁变化后，执行本节。每一步成功后再继续下一步。已成功生成且仍匹配的清单不需要重复收集。

先准备当前 SuperSplat 资源：

```bash
node integrations/supersplat/prepare.mjs
```

命中已校验缓存时，这条命令可能没有输出，成功退出即可。

收集器拒绝覆盖已有目录。更新时先归档旧清单，再在脚本固定的默认位置生成新清单；不要删除旧证据，也不要用符号链接替代默认目录。

```bash
mac_license_dir="target/macos-m4/app-license-evidence/licenses"

if [ -e "$mac_license_dir" ]; then
  mac_license_backup="${mac_license_dir}-backup-$(date +%Y%m%d-%H%M%S)-$$"
  mv "$mac_license_dir" "$mac_license_backup"
fi

node scripts/macos/collect-app-licenses.mjs
```

成功时会输出类似以下摘要；数量随实际依赖变化，并非固定验收数字：

```json
{"cargo_components":291,"npm_components":115,"license_texts":693,"missing":1,"files":797,"release_ready":false}
```

`missing` 和 `release_ready` 记录许可审查状态。`--internal-alpha` 允许已如实记录的未完成项，但仍检查文件哈希、来源和资源配对，不能接受损坏或不匹配的清单。

如需单独核对当前清单：

```bash
python3 scripts/macos/verify-app.py \
  --check-app-license-evidence target/macos-m4/app-license-evidence/licenses \
  --internal-alpha

node scripts/macos/verify-supersplat-inputs.mjs \
  --license-root target/macos-m4/app-license-evidence/licenses
```

清单准备完成后，执行第 2 节的完整打包命令。将清单收集到自定义目录，不会自动切换完整打包脚本使用的默认目录。

## 4. 打包选项

| 命令 | 结果 |
| --- | --- |
| `bash scripts/macos/build-macos-app.sh --internal-alpha` | release 应用与 DMG；日常内部测试包使用此命令 |
| `bash scripts/macos/build-macos-app.sh --internal-alpha --debug` | debug 应用与 DMG |
| `bash scripts/macos/build-macos-app.sh --internal-alpha --app-only` | 仅构建并验证完整 `.app`，不生成 DMG |

三个选项可以组合。脚本已设置 `MACOSX_DEPLOYMENT_TARGET=15.0` 和本机工具链需要的 `CARGO_PROFILE_RELEASE_STRIP=none`，无需重复手动设置。

不带 `--internal-alpha` 时，脚本要求引擎和应用许可证据的发布门槛通过；即使通过，也不代表自动完成 Developer ID 签名、公证或公开发布验收。当前分发边界见 [Release process](release-process.md)。

## 5. 确认打包完成与查找产物

完整 DMG 流程必须成功退出，并在最后出现：

```text
Verified app packaging evidence: .../target/macos-m4/app-verification/build.XXXXXX/final.json
```

`running 1 test`、`1 passed` 或编译的 `Finished` 只表示中间阶段通过。应核对本轮输出的 `final.json`，其中 DMG 路径、SHA-256、`application_matches_verified_bundle` 和 `application_signatures_verified` 对应本轮产物。

| 产物 | 默认 release 路径 |
| --- | --- |
| 完整应用 | `target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app` |
| DMG 目录 | `target/aarch64-apple-darwin/release/bundle/dmg/` |
| 本轮报告和预检日志 | `target/macos-m4/app-verification/build.XXXXXX/` |
| 最近一次成功报告 | `target/macos-m4/app-verification/latest.json` |

DMG 名称格式为 `MetOrigin-Splat-release-<引擎清单哈希前12位>-build.<随机标识>.dmg`。使用 `--debug` 时，应用/DMG 路径中的 `release` 改为 `debug`。

打开产物目录：

```bash
open target/aarch64-apple-darwin/release/bundle/dmg
```

DMG 使用唯一名称，目录里可能保留多次历史构建；选择与本轮 `final.json` 一致的文件。`latest.json` 仅在本轮全部选定步骤成功后更新；失败时它可能仍是旧成功记录，不能用来证明失败的本轮已经完成。`--app-only` 成功也会更新该文件，但报告没有 `dmg` 字段。

## 6. 安装与启动

1. 退出当前运行的 MetOrigin Splat，避免继续使用调试版进程。
2. 双击本轮 DMG，将 **MetOrigin Splat.app** 拖入 **Applications（应用程序）**。
3. 从“应用程序”启动，再推出已挂载的磁盘映像。

打包完成不等于已经安装或完成安装后的运行验收。当前内部包使用 ad-hoc 签名进行完整性校验；`application_signatures_verified: true` 不等于 Developer ID 或 Apple 公证。`notarization_verified: false`、`application_public_release_ready: false` 表示相应发布工作尚未完成。

## 7. 常见输出与处理

| 输出 | 原因与处理 |
| --- | --- |
| `zsh: command not found: 2.` 或 `3.` | 步骤编号被粘贴成命令；只复制代码框，不影响此前已成功的步骤 |
| `Evidence already exists; select a new output directory.` | 清单已存在，收集器正常拒绝覆盖；若第一次已成功且输入未变，直接打包；确需更新才按第 3 节归档重收 |
| `pnpm: command not found` | 构建用的 bash 找不到 pnpm；按第 2 节补充真实可执行入口后重新运行完整脚本 |
| `1 passed` 后报错退出 | 仅预检通过，后续构建未完成；解决其后报错再重跑，不必仅因此重收清单 |
| Node 版本与 `nvm use` 显示不同 | 用 `type -a node` 和 `node --version` 确认 PATH/其他工具入口；与清单目录已存在无关 |
| `cmp` 或 SuperSplat/patch 输入配对失败 | 源码、锁文件或实际资源与已收集证据不一致；准备当前资源并更新清单，不修改校验哈希来绕过 |
| `release_ready: false` | 查看清单中的 `release-readiness.json`；它记录发布准备状态，与内部流程能否通过完整性检查分开判断 |

若已创建本轮 `build.XXXXXX` 证据目录，失败时会保留；最早的引擎前置校验失败可能尚未创建该目录。不要因为已有旧 DMG、旧 `.app` 或旧 `latest.json` 就判断本轮成功。

## 8. 历史构建记录（2026-10-30）

以下保留当日 `build.nM8fVm` 的实际成功产物，供历史核对；它不是当前最新图标包。重新构建会产生新的报告标识与哈希，不能沿用此记录证明新包成功。

| 项目 | 记录 |
| --- | --- |
| 报告 | `target/macos-m4/app-verification/build.nM8fVm/final.json` |
| DMG | `target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.nM8fVm.dmg` |
| DMG SHA-256 | `4f4fabb0b689d088e1e655f8230327d370a61cbb45bbd0b760dfa7b0bd8436a1` |
| 引擎文件数 | 2,999 |
| 许可清单文件数 | 797；仍有 1 项原始 notice 缺项 |
| DMG 校验 | 只读挂载、应用与已验证 bundle 匹配、签名完整性均通过 |
| 发布状态 | 内部 Alpha；未完成公证及公开发布准备 |

进一步的引擎构建、来源和许可说明见 [macOS engine packaging](../packaging/macos-arm64/README.md)、[应用许可证据](validation/macos-app-licenses.md)。
