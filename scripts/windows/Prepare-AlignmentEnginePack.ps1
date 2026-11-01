[CmdletBinding()]
param(
    [string]$OutputRoot,
    [string]$CacheDirectory,
    [string]$BrushRuntime,
    [string]$SourceRepository,
    [switch]$Offline
)
. (Join-Path $PSScriptRoot 'Packaging.Common.ps1')
if (-not $OutputRoot) { $OutputRoot = Get-MetOriginWindowsDefaultPath -Key 'alignmentRoot' }
if (-not $CacheDirectory) { $CacheDirectory = Get-MetOriginWindowsDefaultPath -Key 'engineDownloads' }
if (-not $BrushRuntime) { $BrushRuntime = Get-MetOriginWindowsDefaultPath -Key 'brushRuntime' }
if (-not $SourceRepository) { $SourceRepository = Get-MetOriginWindowsDefaultPath -Key 'brushSource' }

$arguments = @((Join-Path $PSScriptRoot 'AlignmentPack.mjs'), 'prepare', '--output', $OutputRoot, '--cache', $CacheDirectory, '--brush', $BrushRuntime, '--source', $SourceRepository)
if ($Offline) { $arguments += '--offline' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Windows alignment candidate preparation failed; the previous complete pack was preserved.' }
