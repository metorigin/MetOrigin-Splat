[CmdletBinding()]
param(
    [string]$SourceRepository,
    [string]$OutputDirectory,
    [switch]$Offline,
    [switch]$Verify
)
. (Join-Path $PSScriptRoot 'Packaging.Common.ps1')
if (-not $SourceRepository) { $SourceRepository = Get-MetOriginWindowsDefaultPath -Key 'brushSource' }
if (-not $OutputDirectory) { $OutputDirectory = Get-MetOriginWindowsDefaultPath -Key 'brushRuntime' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskArguments = @('-X', 'utf8', (Join-Path $PSScriptRoot 'build_brush_runtime.py'),
    '--source-repository', $SourceRepository, '--output', $OutputDirectory)
if ($Offline) { $taskArguments += '--offline' }
if ($Verify) { $taskArguments += '--verify' }
Push-Location $taskRoot
try {
    & python @taskArguments
    if ($LASTEXITCODE -ne 0) { throw "Windows Brush runtime preparation failed ($LASTEXITCODE)" }
} finally { Pop-Location }
