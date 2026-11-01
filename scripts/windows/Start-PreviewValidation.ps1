[CmdletBinding()]
param([int]$DebugPort = 9246, [string]$CargoTargetDirectory = 'target/windows-preview-validation', [switch]$StopOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskIdentity = ([BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskRoot)))).Replace('-', '').Substring(0,16) }
finally { $taskHasher.Dispose() }
$taskQa = Join-Path ([IO.Path]::GetTempPath()) "metorigin-preview-$taskIdentity"
$taskTarget = if ([IO.Path]::IsPathRooted($CargoTargetDirectory)) { [IO.Path]::GetFullPath($CargoTargetDirectory) } else { [IO.Path]::GetFullPath((Join-Path $taskRoot $CargoTargetDirectory)) }
$taskBinary = Join-Path $taskTarget 'debug/splat-desktop.exe'
if ((Test-Path -LiteralPath $taskQa) -and ((Get-Item -LiteralPath $taskQa -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Preview scratch directory cannot be a link.' }
New-Item -ItemType Directory -Path $taskQa -Force | Out-Null
$taskPidPath = Join-Path $taskQa 'app.pid'
if (Test-Path -LiteralPath $taskPidPath) {
    $taskPid = [int](Get-Content -LiteralPath $taskPidPath)
    $taskPrevious = Get-Process -Id $taskPid -ErrorAction SilentlyContinue
    if ($taskPrevious -and [IO.Path]::GetFullPath($taskPrevious.Path) -eq [IO.Path]::GetFullPath($taskBinary)) { Stop-Process -Id $taskPid }
}
if ($StopOnly) { Remove-Item -LiteralPath $taskQa -Recurse -Force; Write-Output 'Owned preview test application stopped; temporary profile and logs removed.'; return }
# Different identifier keeps the user's preferences and recent projects isolated.
$env:TAURI_CONFIG = '{"identifier":"com.metorigin.splat.preview-validation"}'
Push-Location $taskRoot
try {
    & cargo build -p splat-desktop --no-default-features --offline --target-dir $taskTarget
    if ($LASTEXITCODE -ne 0) { throw 'Preview test application build failed' }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $taskQa 'webview-profile'
    $taskProcess = Start-Process -FilePath $taskBinary -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskQa 'app.stdout.log') -RedirectStandardError (Join-Path $taskQa 'app.stderr.log')
    $taskProcess.Id | Set-Content -LiteralPath $taskPidPath
    Write-Output "Preview test application PID $($taskProcess.Id), CDP $DebugPort"
} finally { Pop-Location }
