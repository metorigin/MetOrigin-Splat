[CmdletBinding()]
param(
    [string]$OutputRoot = 'target/distribution/windows-x64-alignment',
    [switch]$SkipRuntimeChecks
)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'AlignmentPack.mjs'), 'verify', '--output', $OutputRoot)
if ($SkipRuntimeChecks) { $arguments += '--skip-runtime' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Windows alignment candidate verification failed.' }
