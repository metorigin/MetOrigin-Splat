[CmdletBinding()]
param(
    [string]$OutputRoot,
    [switch]$SkipRuntimeChecks
)
. (Join-Path $PSScriptRoot 'Packaging.Common.ps1')
if (-not $OutputRoot) { $OutputRoot = Get-MetOriginWindowsPath -Key 'alignmentRoot' }

$arguments = @((Join-Path $PSScriptRoot 'AlignmentPack.mjs'), 'verify', '--output', $OutputRoot)
if ($SkipRuntimeChecks) { $arguments += '--skip-runtime' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Windows alignment candidate verification failed.' }
