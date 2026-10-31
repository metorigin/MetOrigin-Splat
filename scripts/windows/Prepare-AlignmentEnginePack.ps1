[CmdletBinding()]
param(
    [string]$OutputRoot = 'target/distribution/windows-x64-alignment',
    [string]$CacheDirectory = '.engines/downloads',
    [string]$BrushRuntime = 'target/windows-brush/runtime',
    [string]$SourceRepository = '../brush',
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'AlignmentPack.mjs'), 'prepare', '--output', $OutputRoot, '--cache', $CacheDirectory, '--brush', $BrushRuntime, '--source', $SourceRepository)
if ($Offline) { $arguments += '--offline' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Windows alignment candidate preparation failed; the previous complete pack was preserved.' }
