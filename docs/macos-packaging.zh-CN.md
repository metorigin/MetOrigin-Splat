# macOS 安装包打包命令

适用于 MetOrigin Splat 的 Apple Silicon（arm64）完整内部 Alpha 包。DMG 包含应用、FFmpeg/FFprobe、COLMAP、Brush 及对应运行资源，配置的最低系统版本为 macOS 15.0；最低系统与其他硬件的验收仍须单独完成。

完整打包入口为 [`scripts/macos/build-macos-app.sh`](../scripts/macos/build-macos-app.sh)，基础资源配置为 [`tauri.macos.full.conf.json`](../apps/desktop/src-tauri/tauri.macos.full.conf.json)。打包脚本根据统一路径配置生成本轮 Tauri 资源配置，应用内仍使用 `resources/app-licenses/`。仅复制代码框中的命令，不要复制步骤编号、终端提示符或示例输出。

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
| 引擎包 | 必须先取得或生成下表中的 arm64 引擎包；新克隆不会自带忽略的引擎、缓存和打包产物 |

当前完整打包脚本默认读取以下输入目录：

| 输入 | 路径 |
| --- | --- |
| 引擎及完整性清单 | `.engines/macos-arm64/distribution/engines/` |
| 引擎分发状态 | `.engines/macos-arm64/distribution/release-status.json` |
| 当前应用许可证据 | `artifacts/licenses/macos-arm64/current/` |

应用“设置”中的本地引擎路径不会替代这些打包输入。引擎准备方法见 [macOS engine packaging](../packaging/macos-arm64/README.md)。`APP_LICENSE_ENGINE_PACK` 只改变许可收集器读取的引擎来源，不能改变完整安装包使用的引擎资源路径。

目录整理分阶段进行：DMG、验证报告和应用许可证据的位置由 [`packaging/shared/artifact-paths.json`](../packaging/shared/artifact-paths.json) 定义，并由 [`scripts/shared/artifact-paths.mjs`](../scripts/shared/artifact-paths.mjs) 解析。当前许可证据使用 `current/`，历史备份使用 `artifacts/licenses/macos-arm64/archive/`。SuperSplat 源码检出目录为 `.cache/metorigin/sources/supersplat/upstream/`，npm 缓存为 `.cache/metorigin/downloads/npm/supersplat/`，统一配置见 [`cache-paths.json`](../packaging/shared/cache-paths.json)。引擎及其许可证仍作为整包管理，独立于应用许可证据。

引擎路径统一见 [`engine-paths.json`](../packaging/shared/engine-paths.json)。当前冻结的待签名源包继续使用原 Alpha `.6` 的 2,999 个文件，清单 SHA-256 为 `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`；目录整理不重建或改写这份源包身份。正式签名流程会派生新包，生成新的文件清单和哈希，验证时应使用本轮报告中的派生身份。开发引擎另位于 `.engines/macos-arm64/development/`，其 Brush 保留 `metorigin-macos.5`，不会因打包自动换成 `.6`。

Mac 引擎直接读取 `.engines/macos-arm64/` 下的 canonical 路径，不保留 `target/` 兼容链接；开发和构建准备不再创建 `target/macos-m0` 或 `target/distribution/macos-arm64`。设置中若显式保存了旧路径，应重新选择对应的 canonical 引擎目录。`cargo clean` 只影响 Cargo 输出，不删除稳定引擎、源码缓存和正式报告。

开发 COLMAP 依赖环境按固定的 171 包显式锁，由 Conda 原生安装到 `.engines/macos-arm64/development/colmap-deps/`；COLMAP 4.1.0 使用独立 `native/` 构建树重编译并安装到开发引擎目录，保留 CGAL、LSD、MVS、downloads 开启的开发 profile。原依赖环境和开发安装分别保留于 `.engines/macos-arm64/archive/colmap/dependencies-original/`、`development-original/`，历史 Alpha 审计默认使用单独的 `colmapAlphaDependencyEvidence`，不混用新环境。当前命令见 [原生引擎脚本](../scripts/macos/README.md#当前路径入口2026-11-01)；应用重复打包仍读取冻结的 Alpha `.6`，不需要重编译开发引擎。

原生源码与缓存使用 `.cache/metorigin/`，已导入的旧构建树保留为历史记录，新重编译使用独立 `native/` 目录。旧 [引擎迁移映射](../.engines/macos-arm64/migration-map.json) 和 stage-4 回执不改写，前缀退役与新构建另记后继记录，不沿用旧开发二进制的哈希或验收结论；前缀整理也不代表开发环境已通过可移植或干净机验收。

迁移前许可证据的内容和旧路径字段保留原文，本机旧位置到新位置的对应关系见 [migration-map.json](../artifacts/licenses/macos-arm64/migration-map.json)。旧安装包和历史打包报告归入 `artifacts/` 管理，原记录内容和旧路径字段不改写，由迁移记录说明当前位置；新克隆不会自带这些本地产物。

## 2. 常规重复打包

当依赖、锁文件、复制 UI、SuperSplat 资源及相关派生补丁与已收集清单仍匹配时，直接执行：

```bash
bash scripts/macos/build-macos-app.sh --internal-alpha
```

默认生成 release `.app` 和完整 DMG，前端会在构建时重新编译。脚本还会执行引擎解析及版本预检、最终资源/签名完整性校验，以及 DMG 只读挂载比对；这些预检不启动训练。

脚本会先检查 node、pnpm、cargo、python3 是否可执行，以及 Node 26.x / pnpm 11.12.0 是否匹配；工具缺失或版本不符时，在引擎预检和编译之前退出。

如果提示输入、资源或许可证清单不匹配，先执行下一节，不要跳过校验。构建期间不要同时改动源码、依赖、资源或清单。

### Developer ID 签名与 Apple 公证

在本机“登录”钥匙串中准备带有私钥的 **Developer ID Application** 身份，并用
`security find-identity -v -p codesigning` 获取该证书的 SHA-1 指纹。使用 Apple 的
App 专用密码配置本机凭据；省略 `--password`，在安全提示中输入密码：

```bash
xcrun notarytool store-credentials metorigin-notary \
  --apple-id '你的开发者账户邮箱' --team-id '你的十位 Team ID'
xcrun notarytool history --keychain-profile metorigin-notary
```

将下方证书指纹和 Team ID 占位符换成自己的值，再执行完整流程：

```bash
bash scripts/macos/build-macos-app.sh --internal-alpha \
  --signing-identity 'Developer ID Application 证书的40位SHA1' \
  --team-id '你的十位TeamID' \
  --notary-profile metorigin-notary
```

`--internal-alpha` 保留当前许可证据中尚未完成的事项；它与正式签名可以同时使用。
签名或公证成功不会自动清除许可问题、干净机验收或公开发布门槛。签名要求 release
构建，不能与 `--debug` 同用。省略 `--notary-profile` 时只正式签名，不提交公证。

日常本机开发和不带正式签名参数的内部打包不会自动提交公证。准备分发新构建时，
再显式提供签名身份、Team ID 和 `--notary-profile`。公证绑定上传的具体构建，后续
重新打包的分发产物需要重新提交。

脚本先验证默认冻结引擎包，在本轮报告目录的 `signed-engine-pack/` 中派生新包：
逐个签署 dylib 和引擎可执行文件，使用可信时间戳，并为可执行文件启用 Hardened
Runtime；随后重建清单及派生审计，再执行重定位与实际应用预检。原始引擎包保持不变。
`--engine-pack-root DIRECTORY` 可显式选择另一套待派生输入，资源映射和预检使用同一路径。
Tauri 构建时会清除自动签名/公证环境变量，避免再次改写已经固定的引擎文件。

应用签名并验证后，脚本用该完整应用生成 DMG，签署并只读挂载核对，再将最终 DMG
提交公证。Apple 返回 `Accepted` 后才为 DMG 附加并验证票据，执行 Gatekeeper 与
完整挂载比对。对于这种 Finder 拖放安装方式，Apple 支持只提交最外层的分发容器，
无需先等待一轮独立应用 ZIP 公证，见 Apple 的
[打包分发说明](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
及[自定义公证流程](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)。

DMG 流程采用显式的 `--require-notarized-container` 验证策略：要求 DMG 的票据和
Gatekeeper 评估通过，并核验内含应用及全部原生引擎的签名、资源清单与来源应用完全
一致。报告区分容器公证与应用自身的附票据状态，不声称应用自身已附票据。
`--require-notarized` 仍严格要求应用自身的票据；`--app-only` 公证流程继续通过
ZIP 提交应用并为应用附票据。

提交 ID、Apple 原始日志、上传及附票据后的 SHA-256 保存在本轮 `notary-dmg/`
目录（仅应用模式为 `notary-app/`）；全部步骤通过后才产生最终报告并更新成功指针。

如只需完成上传、稍后等待 Apple 处理，可在完整命令后加 `--notary-submit-only`。
此选项只适用于 DMG，生成明确标为待处理的提交回执后退出，不执行附票据，不更新
`latest.json` 或成功产物登记。退出码为零只表示上传成功，不能据此认定公证已通过。
随后使用同一 DMG 和报告目录恢复处理，例如：

```bash
python3 scripts/macos/notarize-artifact.py \
  --submit-file '/完整路径/新安装包.dmg' \
  --staple-target '/完整路径/新安装包.dmg' \
  --keychain-profile metorigin-notary \
  --report-dir '/本轮报告目录/notary-dmg'
```

该命令恢复原提交，等待通过后附加并验证票据。然后还需运行 `verify-app.py`，使用
本轮的固定输入哈希、`--expected-app-report`、`--dmg`、Team ID/证书指纹和
`--require-notarized-container` 完成最终挂载验证；单独恢复公证不会自动更新构建成功指针。

需要保留的已登记旧包，应在构建前通过 `artifact-retention.mjs pin` 固定；默认保留策略
仍只保留最近的未固定成功产物，详见[开发指南](development.md)。

网络中断或公证等待超时后，`notarize-artifact.py` 可以使用相同的提交文件、目标、
凭据名称及报告目录恢复已保存的提交 ID，不会重复上传。不要先重新构建或改写原目标。
如果提交被拒绝，查看该目录的 `apple-log.json`；拒绝、缺少票据或 Gatekeeper 检查失败
不会被记录成公证成功，也不会替换上一份成功报告。

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

首次使用新缓存布局时，准备脚本会更新资源准备签名，因此需要继续按下文归档并重新收集许可证据。之后输入保持匹配时，可直接重复打包。新克隆会自动创建 `.cache/metorigin/` 下的缓存；脚本不再读取旧的 `target/supersplat-source/`、`target/supersplat-npm-cache/`，也不使用目录链接兼容旧路径。已有缓存应在新位置复制并验证成功后再清理旧副本。

收集器拒绝覆盖已有目录。仅迁移已验证的目录、且输入和内容未变时，无需重新收集。确需更新时，先把当前清单归档，再在默认 `current/` 位置生成新清单；不要删除旧证据，也不要用符号链接替代默认目录。

```bash
mac_license_dir="$(node scripts/shared/artifact-paths.mjs --platform macos-arm64 --kind license-current)"
mac_license_archive="$(node scripts/shared/artifact-paths.mjs --platform macos-arm64 --kind license-archive)"

if [ -e "$mac_license_dir" ]; then
  mkdir -p "$mac_license_archive"
  mac_license_backup="$mac_license_archive/licenses-backup-$(date +%Y%m%d-%H%M%S)-$$"
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
mac_license_dir="$(node scripts/shared/artifact-paths.mjs --platform macos-arm64 --kind license-current)"

python3 scripts/macos/verify-app.py \
  --check-app-license-evidence "$mac_license_dir" \
  --internal-alpha

node scripts/macos/verify-supersplat-inputs.mjs \
  --license-root "$mac_license_dir"
```

清单准备完成后，执行第 2 节的完整打包命令。显式指定收集输出时，只接受统一许可证平台根目录内的新子目录；自定义输出不会自动替代打包脚本使用的 `current/`。

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
Verified app packaging evidence: .../artifacts/verification/macos-arm64/build.XXXXXX/final.json
```

`running 1 test`、`1 passed` 或编译的 `Finished` 只表示中间阶段通过。应核对本轮输出的 `final.json`，其中 DMG 路径、SHA-256、`application_matches_verified_bundle` 和 `application_signatures_verified` 对应本轮产物。

| 产物 | 默认 release 路径 |
| --- | --- |
| 完整应用 | `target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app` |
| DMG 目录 | `artifacts/packages/macos-arm64/` |
| 本轮报告和预检日志 | `artifacts/verification/macos-arm64/build.XXXXXX/` |
| 最近一次成功报告 | `artifacts/verification/macos-arm64/latest.json` |

DMG 名称格式为 `MetOrigin-Splat-release-<引擎清单哈希前12位>-build.<随机标识>.dmg`。使用 `--debug` 时，应用路径中的 `release` 和 DMG 文件名中的 `release` 改为 `debug`；两种 DMG 都放在同一个平台目录中。

打开产物目录：

```bash
open artifacts/packages/macos-arm64
```

DMG 使用唯一名称，默认只保留最新一份及对应报告；受保护的发布基线可能额外保留。选择与本轮 `final.json` 一致的文件。`latest.json` 在本轮选定验证和产物登记成功后原子更新；验证或登记失败时保留旧成功记录，不能用它证明失败的本轮已经完成。`--app-only` 成功也会更新该文件，但报告没有 `dmg` 字段。

登记时旧的 `latest.json` 会保护上一轮成功包。新成功指针发布后，脚本再清理不需要
保留的旧产物；若此清理失败，会给出提示并保留多余文件，新的已验证、已登记产物
仍有效。可通过下方清理命令预览和重试。

安装包按平台仅保留最近一次已登记构建，以及它引用的全部验证、许可证据；发布基线、显式固定和未解决失败不按普通历史轮换删除。需要清理时先预览，确认候选后再加 `--apply`：

```bash
node scripts/shared/artifact-retention.mjs apply --platform macos-arm64
node scripts/shared/artifact-retention.mjs apply --platform macos-arm64 --apply
```

引用关系和 `pin` / `unpin` 的用法见[目录职责与清理规则](development.md#generated-files-and-cleanup)。不要只按文件日期删除仍被包或审计清单引用的许可证和报告；源码缓存中的本地修改、工具链、运行引擎及用户项目不属于普通测试清理对象。

## 6. 安装与启动

1. 退出当前运行的 MetOrigin Splat，避免继续使用调试版进程。
2. 双击本轮 DMG，将 **MetOrigin Splat.app** 拖入 **Applications（应用程序）**。
3. 从“应用程序”启动，再推出已挂载的磁盘映像。

打包完成后还需进行安装和运行验收。未指定正式签名身份的内部打包使用 ad-hoc
完整性签名；指定身份后使用 Developer ID。报告中的签名与公证字段分别表示：

| 字段 | 验证范围 |
| --- | --- |
| `dmg.application_signatures_verified` | 包内应用的签名与资源完整性，单独此字段不能确认 Developer ID 或公证 |
| `developer_id_verification` | Developer ID 证书链、Team ID、时间戳及要求的 Hardened Runtime |
| 顶层 `notarization_verified` | 应用自身附加票据及 Gatekeeper 评估；DMG 容器模式下可为 `false` |
| `distribution_notarization_verified`、`dmg.notarization_verified` | DMG 自身的公证票据与 Gatekeeper 评估；正式 DMG 公证流程应核对这两个字段为 `true` |
| `application_public_release_ready` | 此验证器始终保留 `false`；公开发布还需独立完成许可、原生运行和干净机验收 |

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

### 图标外框、旧图标与存储空间重复项

macOS 专用图标资源位于 `apps/desktop/src-tauri/icons/macos/`，包含预编译的 `Assets.car` 和供旧系统使用的 `icon.icns`。原生资源用于避免新系统给传统图标附加兼容外框；Windows 继续使用原有 `icons/icon.ico`。常规打包使用预编译资源，第 2 节命令不变。修改图标母版后，需要完整 Xcode 26 或更高版本重新生成：

```bash
bash scripts/macos/build-app-icon.sh
```

源码图标的修改不会更新已安装的应用：需要重新打包、安装，并在保存编辑后完全退出旧进程，再手动启动“应用程序”中的新版。资源生成或源码检查通过，也不代表已完成安装后的原生图标验收。

“系统设置 → 通用 → 存储空间 → 应用程序”可能同时列出 `/Applications/MetOrigin Splat.app` 和 `target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app`；相同名称和版本会被标为重复项。逐一选中条目，通过“在访达中显示”确认实际路径，日常运行保留 `/Applications` 中的安装版。`target/` 中只放 Cargo 构建输出；引擎、源码缓存及新安装包分别位于 `.engines/`、`.cache/`、`artifacts/`。清理时按实际路径区分已安装应用、构建输出和需要保留的产物，删除 Cargo 缓存后重新构建会增加编译时间。

存储列表可能继续显示系统缓存的旧图标，不能据此判断当前应用包内的资源。安装新版后关闭并重新打开该设置页面核对；若仍显示旧图标，先确认条目路径与实际应用，不执行全局缓存清理或自动重启命令。

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
