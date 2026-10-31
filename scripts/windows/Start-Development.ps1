[CmdletBinding()]
param(
    [string]$EngineDirectory,
    [ValidateSet('dx12','vulkan')][string]$Backend,
    [string]$DeviceId,
    [switch]$Offline,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'dev:windows requires native Windows.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location $root
$previousHint = $env:METORIGIN_PREPARED_ENGINE_DIR
$previousEngine = $env:METORIGIN_ENGINE_DIR
$previousBackend = $env:METORIGIN_BRUSH_BACKEND
$previousDevice = $env:METORIGIN_BRUSH_DEVICE_ID
try {
    $nodeVersion = (& node --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v26\.') { throw 'Node.js 26 is required; activate the repository Node version first.' }
    $pnpmVersion = (& pnpm --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne '11.12.0') { throw 'pnpm 11.12.0 is required.' }
    $rustVersion = (& rustc --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $rustVersion -notmatch '^rustc 1\.97\.0 ') { throw 'The application requires Rust 1.97.0.' }
    if ($EngineDirectory) {
        $selected = [IO.Path]::GetFullPath($EngineDirectory)
        if ([IO.Path]::GetFileName($selected.TrimEnd('\','/')) -ne 'engines') {
            throw 'EngineDirectory must identify the engines directory of a complete alignment candidate pack.'
        }
        # Explicit caller override retains highest priority; never silently repair it.
        & node (Join-Path $PSScriptRoot 'AlignmentPack.mjs') verify --output (Split-Path -Parent $selected)
        if ($LASTEXITCODE -ne 0) { throw 'Explicit candidate engine directory failed verification.' }
        $env:METORIGIN_ENGINE_DIR = $selected
    } else {
        & (Join-Path $PSScriptRoot 'Prepare-AlignmentEnginePack.ps1') -Offline:$Offline
        $selected = Join-Path $root 'target/distribution/windows-x64-alignment/engines'
        # A low-priority, Windows debug-only candidate hint preserves saved settings
        # and user METORIGIN_ENGINE_DIR. The application validates the selected pack.
        $env:METORIGIN_PREPARED_ENGINE_DIR = $selected
    }
    if ($PSBoundParameters.ContainsKey('Backend')) { $env:METORIGIN_BRUSH_BACKEND = $Backend }
    if ($PSBoundParameters.ContainsKey('DeviceId')) { $env:METORIGIN_BRUSH_DEVICE_ID = $DeviceId }
    $selection = if ($env:METORIGIN_BRUSH_BACKEND) { $env:METORIGIN_BRUSH_BACKEND } else { 'dx12 (application default)' }
    Write-Host "Windows candidate prepared: $selected; WGPU $selection (compute preflight still required)."
    if (-not $CheckOnly) {
        # Tauri owns beforeDevCommand and starts the only Vite server.
        & pnpm --dir apps/desktop tauri dev
        if ($LASTEXITCODE -ne 0) { throw 'Windows Tauri development process failed.' }
    }
} finally {
    $env:METORIGIN_PREPARED_ENGINE_DIR = $previousHint
    $env:METORIGIN_ENGINE_DIR = $previousEngine
    $env:METORIGIN_BRUSH_BACKEND = $previousBackend
    $env:METORIGIN_BRUSH_DEVICE_ID = $previousDevice
    Pop-Location
}
