# Windows Alpha 发布材料与 GitHub 下载

## 当前方案

首轮采用 **未签名 Alpha**。GitHub Releases 可以托管安装包，单个附件须小于 2 GiB。代码签名不是 GitHub 上传条件，但 Windows 可能提示未知发布者，或按设备策略阻止运行。签名以后也不保证新文件立即获得 SmartScreen 信誉。

完整离线包目前只能进入维护者可见的 Release 草稿。第三方证据、兼容性验证和安全检查的未完成项必须保留，不能通过改名为 Alpha 或添加一份许可证消除。

## FFmpeg：对应源码和声明

锁定的 Gyan 8.1.2 包是静态 GPLv3 构建。随包 README 指向 FFmpeg 提交 `38b88335f9`，并列出大量静态外部库。

完成条件：

1. 归档与实际二进制匹配的 FFmpeg 源码、补丁、configure 参数和构建脚本。
2. 列出实际静态链接的依赖，补齐对应版本的源码、许可证和构建材料。只有 FFmpeg 仓库 ZIP 不足以说明整个静态二进制可重建。
3. 生成对应源码归档及 SHA-256，与安装包放在同一个 Release，发布页明确标注源码入口。
4. 保留 GPLv3 许可证、版权声明，以及源码包与二进制包的映射记录。

在线分发拟采用 GPLv3 第 6(d) 节的对应源码访问方式。书面承诺是另一种交付路径，不是一律叠加在 6(d) 上的额外要求。上游二进制下载地址不能称为源码包。

如果拿不到原二进制完整构建材料，可自行构建所需功能的 FFmpeg，同时保存精确源版本、依赖和构建流程，再重新验证视频处理路径。

## COLMAP：逐项核对实际依赖

`native-payload-inventory.json` 记录随包 EXE/DLL 的相对路径、大小和 SHA-256。它是核对起点，不是许可证审计结论。

需要将每个运行库映射到准确版本、上游来源和许可文本，并补入静态链接依赖。COLMAP 4.1.0 的 Windows 工作流、vcpkg 基线、构建记录和安装目录中的 `share/<port>/copyright` 是优先证据来源。Qt、SuiteSparse、GCC 运行库等不能统一写成 COLMAP 的 BSD 许可证。按各自实际许可证补齐所需源码、例外条款及可替换/重新链接说明。

若上游归档缺少依赖版本证据，应从固定源码与 vcpkg 基线重新构建，或者向上游确认；不能通过猜测 DLL 文件名完成审计。

## Brush：代码和权重分别记录

Brush v0.3.0 代码为 Apache-2.0。它通过 `include_bytes!` 将 `crates/lpips/burn_mapped.bin` 编译进原生引擎，MetOrigin companion 也引用同一依赖。仅关闭评估参数不会移除内嵌权重。

需要记录对应 LPIPS 与 VGG 检查点的来源、版本、哈希、授权和归属声明，以及转换为该文件的过程。Oxford 的 VGG 模型页提供 Creative Commons Attribution 信息，但这不能单独证明 Brush 中的具体转换文件来自同一获授权检查点。

无法建立来源链时，可取得上游确认，或从授权明确的检查点重新转换；也可从源码移除相关指标和权重后重新验证引擎。不能仅把 Brush 的 Apache 许可证复制给权重。

## 软件组件清单和许可证自动化

`pnpm package:windows:full` 在打包前运行 `Generate-ReleaseEvidence.mjs`，并将以下内容装入 `resources/licenses/`：

- `SBOM.cdx.json`：CycloneDX 1.6，Windows Rust 依赖图、Brush companion 依赖图、前端生产依赖、引擎归档及本机二进制文件哈希。
- `dependencies/`、`dependency-license-index.json`：从实际安装依赖复制的许可证/声明及其哈希。
- `native-payload-inventory.json`：待逐项核查的 EXE/DLL 清单。
- `release-readiness.json`：未完成项及缺少许可文本的包。

当前 SBOM 明确标记 `incomplete`：源码图含构建依赖、前端裁剪前依赖；预编译上游引擎中的静态组件、权重来源和打包器组件尚未全部确定。生成 SBOM 不等于完成许可审查。

## 签名

未签名 Alpha 明确标注 `NotSigned` 并给出 SHA-256。哈希验证文件一致性，不能替代发布者身份签名。不要要求用户关闭 Defender 或系统防护。

正式版本取得受信任代码签名证书或云签名服务后，通过 Tauri 的 `certificateThumbprint` 或 `signCommand` 接入。签署 MetOrigin 主程序和最终安装包，添加可信时间戳，再验证签名；校验值和发布附件在签名完成后生成。私钥或服务凭据放在 GitHub 环境密钥/身份联合中，不能提交到仓库。自签名证书不能冒充受信任签名。

## 构建与 GitHub 草稿

提交经过验证的更改后再构建；草稿脚本拒绝工作区有改动、源码版本不一致或校验值不符的包。

```powershell
pnpm package:windows:full
powershell -NoProfile -File scripts/windows/Publish-WindowsDraft.ps1 -Tag v0.1.0-alpha.1
```

添加 `-PrepareOnly` 仅整理本地附件。脚本用 `gh release create --draft --prerelease` 上传安装包、校验值、许可证归档、SBOM、构建元数据、应用源码 ZIP 和待完成项。已存在的 Release 或本地候选目录不会被覆盖；上传中断后先检查远端现状再恢复。

GitHub 草稿需要仓库写权限才能查看，不能作为普通试用者下载入口。全部分发材料及该候选的安装/升级/卸载/重建验证完成后，再将草稿公开为 Pre-release。应用源码 ZIP 不代替引擎对应源码归档。

## 官方参考

- [GitHub Releases 容量与附件](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [FFmpeg 许可证与分发说明](https://ffmpeg.org/legal.html)
- [GPLv3 原文](https://www.gnu.org/licenses/gpl-3.0.html)及 [GNU FAQ](https://www.gnu.org/licenses/gpl-faq.html.en)
- [COLMAP 4.1.0 Windows 构建流程](https://github.com/colmap/colmap/blob/4.1.0/.github/workflows/build-windows.yml)
- [Brush v0.3.0 权重嵌入代码](https://github.com/ArthurBrussee/brush/blob/v0.3.0/crates/lpips/src/lib.rs)
- [Oxford VGG 模型来源](https://www.robots.ox.ac.uk/~vgg/research/very_deep/)
- [Tauri Windows 签名](https://v2.tauri.app/distribute/sign/windows/)
- [Microsoft SmartScreen 信誉说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

这份文档记录工程交付步骤与证据缺口，不代表全部第三方许可已完成法律审查。
