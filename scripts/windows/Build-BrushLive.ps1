[CmdletBinding()]
param(
    [string]$SourceArchive = '.engines/downloads/brush-v0.3.0-source.zip',
    [string]$OutputDirectory = '.engines/brush-v0.3.0-windows-x64',
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskBuild = Join-Path $taskRoot 'target/brush-live-source'
$taskArchive = if ([IO.Path]::IsPathRooted($SourceArchive)) { [IO.Path]::GetFullPath($SourceArchive) } else { [IO.Path]::GetFullPath((Join-Path $taskRoot $SourceArchive)) }
$taskOutput = if ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $taskRoot $OutputDirectory)) }
New-Item -ItemType Directory -Path $taskBuild, $taskOutput -Force | Out-Null
if (-not (Test-Path -LiteralPath $taskArchive)) {
    if ($Offline) { throw "Missing pinned Brush source: $taskArchive" }
    New-Item -ItemType Directory -Path (Split-Path $taskArchive) -Force | Out-Null
    Invoke-WebRequest -Uri 'https://github.com/ArthurBrussee/brush/archive/refs/tags/v0.3.0.zip' -OutFile $taskArchive
}
# Extract into an isolated copy; the stock engine and cached upstream source stay usable.
$taskExpectedHash = '510698AF9E6FDACE4B3D0BBE8695E5549F2F969AD0260A32B4B49694BCC51C0A'
if ((Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash -ne $taskExpectedHash) {
    throw 'Brush v0.3.0 source archive checksum mismatch'
}
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskBuild -Force
$taskSource = Join-Path $taskBuild 'brush-0.3.0'
$taskCli = Join-Path $taskSource 'crates/brush-cli'
$taskEncoding = New-Object System.Text.UTF8Encoding($false)
$taskLib = Join-Path $taskCli 'src/lib.rs'
$taskText = [IO.File]::ReadAllText($taskLib)
$taskText = $taskText.Replace('use brush_process::{', "mod live_preview;`n`nuse brush_process::{")
$taskText = $taskText.Replace('    version,', '    version = "0.3.0+metorigin-live.1",')
$taskText = $taskText.Replace('    let mut duration = Duration::from_secs(0);', "    let mut live_preview = live_preview::LivePreview::from_env();`n    let mut duration = Duration::from_secs(0);")
$taskText = $taskText.Replace("            ProcessMessage::TrainStep {`n                iter,", "            ProcessMessage::TrainStep {`n                splats,`n                iter,")
if (-not $taskText.Contains("                splats,`n                iter,")) { throw 'Pinned Brush TrainStep patch did not match' }
$taskText = $taskText.Replace('                main_spinner.set_message("Training");', @'
                if let Some(preview) = live_preview.as_mut() {
                    if let Err(error) = preview.update(iter, *splats).await {
                        log::warn!("MetOrigin live preview failed: {error}");
                    }
                }
                main_spinner.set_message("Training");
'@)
[IO.File]::WriteAllText($taskLib, $taskText, $taskEncoding)
Copy-Item -LiteralPath (Join-Path $taskRoot 'integrations/brush-live/live_preview.rs') -Destination (Join-Path $taskCli 'src/live_preview.rs') -Force
Copy-Item -LiteralPath (Join-Path $taskRoot 'integrations/brush-live/main.rs') -Destination (Join-Path $taskCli 'src/main.rs') -Force
$taskManifest = Join-Path $taskCli 'Cargo.toml'
$taskText = [IO.File]::ReadAllText($taskManifest).Replace('[dependencies]', @'
[[bin]]
name = "brush_live"
path = "src/main.rs"

[dependencies]
brush-render.path = "../brush-render"
serde.workspace = true
serde_json.workspace = true
env_logger.workspace = true
tokio = { workspace = true, features = ["rt-multi-thread", "io-util"] }
wgpu = { workspace = true, features = ["vulkan"] }
'@)
[IO.File]::WriteAllText($taskManifest, $taskText, $taskEncoding)
$taskArgs = @('build', '--release', '--manifest-path', (Join-Path $taskSource 'Cargo.toml'), '-p', 'brush-cli', '--bin', 'brush_live', '--target-dir', (Join-Path $taskRoot 'target/brush-live-build'))
if ($Offline) { $taskArgs += '--offline' }
& cargo @taskArgs
if ($LASTEXITCODE -ne 0) { throw "Brush live build failed: $LASTEXITCODE" }
$taskBinary = Join-Path $taskRoot 'target/brush-live-build/release/brush_live.exe'
Copy-Item -LiteralPath $taskBinary -Destination (Join-Path $taskOutput 'brush_live.exe') -Force
Copy-Item -LiteralPath (Join-Path $taskSource 'LICENSE') -Destination (Join-Path $taskOutput 'BRUSH-LIVE-LICENSE') -Force
& (Join-Path $taskOutput 'brush_live.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'Brush live version verification failed' }
Write-Host "Embedded preview engine ready: $taskOutput"
