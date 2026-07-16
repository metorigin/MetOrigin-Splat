[CmdletBinding()]
param(
    [string]$LockFile = "packaging/windows-x64/engine-lock.json",
    [string]$OutputRoot = "target/distribution/windows-x64",
    [switch]$SkipRuntimeChecks
)

. (Join-Path $PSScriptRoot "Packaging.Common.ps1")

$lock = Read-MetOriginEngineLock -Path $LockFile
$output = Resolve-MetOriginPath -Path $OutputRoot
$engineRoot = Join-Path $output "engines"
$licenseRoot = Join-Path $output "licenses"
$installerRoot = Join-Path $output "installer"
$manifestPath = Join-Path $engineRoot "engine-manifest.json"

foreach ($requiredDirectory in @($engineRoot, $licenseRoot, $installerRoot)) {
    if (-not (Test-Path -LiteralPath $requiredDirectory -PathType Container)) {
        throw "Required staging directory is missing: '$requiredDirectory'."
    }
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Engine manifest is missing: '$manifestPath'."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema_version -ne 1) {
    throw "Unexpected engine manifest schema '$($manifest.schema_version)'."
}
if ([string]$manifest.pack_version -ne [string]$lock.pack_version) {
    throw "Manifest pack_version does not match the engine lock."
}
if ($manifest.platform -ne "windows-x64") {
    throw "Manifest platform must be windows-x64."
}

function Resolve-ManifestFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $normalized = $RelativePath.Replace('\', '/')
    if ($normalized -ne $RelativePath) {
        throw "Manifest path must use forward slashes: '$RelativePath'."
    }
    if ([System.IO.Path]::IsPathRooted($normalized) -or
        $normalized.Split('/') -contains ".." -or
        $normalized.Split('/') -contains ".") {
        throw "Manifest path is not a safe relative path: '$RelativePath'."
    }

    $candidate = [System.IO.Path]::GetFullPath((Join-Path $engineRoot $normalized))
    Assert-MetOriginChildPath -Path $candidate -Parent $engineRoot | Out-Null
    return $candidate
}

$expectedVersions = @{
    ffmpeg = [string]$lock.components.ffmpeg.version
    colmap = [string]$lock.components.colmap.version
    brush = [string]$lock.components.brush.version
}

foreach ($engineProperty in $manifest.engines.PSObject.Properties) {
    $id = $engineProperty.Name
    $engine = $engineProperty.Value
    if (-not $expectedVersions.ContainsKey($id)) {
        throw "Manifest contains unknown engine '$id'."
    }
    if ([string]$engine.version -ne $expectedVersions[$id]) {
        throw "Manifest version mismatch for '$id': '$($engine.version)'."
    }
    if ([string]$engine.source_sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw "Manifest source_sha256 is invalid for '$id'."
    }
    if ([string]$engine.source_sha256 -ne ([string]$lock.components.$id.sha256).ToUpperInvariant()) {
        throw "Manifest source_sha256 does not match the lock for '$id'."
    }
    if ([string]$engine.source_url -ne [string]$lock.components.$id.source_url) {
        throw "Manifest source_url does not match the lock for '$id'."
    }

    $declaredFiles = @{}
    foreach ($file in @($engine.files)) {
        $relative = [string]$file.path
        if ($declaredFiles.ContainsKey($relative)) {
            throw "Manifest contains duplicate file '$relative'."
        }
        $path = Resolve-ManifestFile -RelativePath $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Manifest file is missing: '$relative'."
        }
        if ([int64](Get-Item -LiteralPath $path).Length -ne [int64]$file.size_bytes) {
            throw "Manifest file size mismatch: '$relative'."
        }
        $actualHash = Get-MetOriginSha256 -Path $path
        if ($actualHash -ne ([string]$file.sha256).ToUpperInvariant()) {
            throw "Manifest file hash mismatch: '$relative'."
        }
        $declaredFiles[$relative] = $true
    }

    foreach ($executableProperty in $engine.executables.PSObject.Properties) {
        $relative = [string]$executableProperty.Value
        Resolve-ManifestFile -RelativePath $relative | Out-Null
        if (-not $declaredFiles.ContainsKey($relative)) {
            throw "Executable '$relative' is not present in files[] for '$id'."
        }
    }
    foreach ($relativeValue in @($engine.license_files)) {
        $relative = [string]$relativeValue
        Resolve-ManifestFile -RelativePath $relative | Out-Null
        if (-not $declaredFiles.ContainsKey($relative)) {
            throw "License '$relative' is not present in files[] for '$id'."
        }
    }

    $engineDirectory = Join-Path $engineRoot $id
    $physicalFiles = @(
        Get-ChildItem -LiteralPath $engineDirectory -Recurse -File |
            ForEach-Object { Get-MetOriginRelativePath -BasePath $engineRoot -Path $_.FullName }
    )
    foreach ($physical in $physicalFiles) {
        if (-not $declaredFiles.ContainsKey($physical)) {
            throw "Physical file is not declared in '$id' files[]: '$physical'."
        }
    }
    if ($physicalFiles.Count -ne $declaredFiles.Count) {
        throw "Manifest/physical file count differs for '$id'."
    }
}

$expectedEngineIds = @("ffmpeg", "colmap", "brush")
foreach ($id in $expectedEngineIds) {
    if ($null -eq $manifest.engines.PSObject.Properties[$id]) {
        throw "Manifest is missing engine '$id'."
    }
}

$bannedFiles = @(
    Get-ChildItem -LiteralPath $engineRoot -Recurse -File |
        Where-Object {
            $relative = Get-MetOriginRelativePath -BasePath $engineRoot -Path $_.FullName
            $_.Extension -ieq ".zip" -or
            $_.Extension -ieq ".pdb" -or
            $_.Name -ieq "ffplay.exe" -or
            $_.Name -like "*_test.exe" -or
            $relative -match '(^|/)(src|source|sources)(/|$)'
        }
)
if ($bannedFiles.Count -gt 0) {
    $paths = ($bannedFiles | ForEach-Object { $_.FullName }) -join "`n"
    throw "Staging contains banned archive/source/test/debug files:`n$paths"
}

foreach ($requiredLicense in @(
    "LICENSE-MIT",
    "LICENSE-APACHE",
    "THIRD_PARTY_NOTICES.md",
    "ffmpeg\LICENSE",
    "colmap\COPYING.txt",
    "brush\LICENSE"
)) {
    $path = Join-Path $licenseRoot $requiredLicense
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Aggregated license file is missing: '$path'."
    }
}

$notice = Get-Content -LiteralPath (Join-Path $licenseRoot "THIRD_PARTY_NOTICES.md") -Raw
foreach ($requiredGate in @("GPLv3", "COLMAP", "LPIPS/VGG", "WebView2", "Public distribution is blocked")) {
    if ($notice -notmatch [regex]::Escape($requiredGate)) {
        throw "Third-party notice is missing release gate text '$requiredGate'."
    }
}

$vcPath = Join-Path $installerRoot "vc_redist.x64.exe"
if (-not (Test-Path -LiteralPath $vcPath -PathType Leaf)) {
    throw "VC++ Runtime installer is missing from staging."
}
if ((Get-MetOriginSha256 -Path $vcPath) -ne ([string]$lock.components.vcredist.sha256).ToUpperInvariant()) {
    throw "VC++ Runtime installer hash does not match the lock."
}

function Test-Sha256SumsFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BasePath,

        [Parameter(Mandatory = $true)]
        [string]$SumsPath
    )

    if (-not (Test-Path -LiteralPath $SumsPath -PathType Leaf)) {
        throw "SHA256SUMS file is missing: '$SumsPath'."
    }
    foreach ($line in Get-Content -LiteralPath $SumsPath) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        if ($line -notmatch '^([A-Fa-f0-9]{64})  (.+)$') {
            throw "Invalid SHA256SUMS line in '$SumsPath': '$line'."
        }
        $expectedHash = $Matches[1].ToUpperInvariant()
        $relative = $Matches[2]
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $BasePath $relative))
        Assert-MetOriginChildPath -Path $candidate -Parent $BasePath | Out-Null
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "SHA256SUMS target is missing: '$relative'."
        }
        if ((Get-MetOriginSha256 -Path $candidate) -ne $expectedHash) {
            throw "SHA256SUMS mismatch: '$relative'."
        }
    }
}

Test-Sha256SumsFile -BasePath $engineRoot -SumsPath (Join-Path $engineRoot "SHA256SUMS")
Test-Sha256SumsFile -BasePath $output -SumsPath (Join-Path $output "SHA256SUMS.txt")

function Invoke-CheckedVersionCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedPattern
    )

    $outputText = (& $FilePath @Arguments 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Name version command exited with $exitCode.`n$outputText"
    }
    if ($outputText -notmatch $ExpectedPattern) {
        throw "$Name version output did not match '$ExpectedPattern'.`n$outputText"
    }
    Write-Host "$Name runtime check passed."
}

if (-not $SkipRuntimeChecks) {
    Invoke-CheckedVersionCommand `
        -Name "FFmpeg" `
        -FilePath (Join-Path $engineRoot "ffmpeg\bin\ffmpeg.exe") `
        -Arguments @("-version") `
        -ExpectedPattern 'ffmpeg version 8\.1\.2'
    Invoke-CheckedVersionCommand `
        -Name "FFprobe" `
        -FilePath (Join-Path $engineRoot "ffmpeg\bin\ffprobe.exe") `
        -Arguments @("-version") `
        -ExpectedPattern 'ffprobe version 8\.1\.2'

    $oldPath = $env:PATH
    $oldQtPluginPath = $env:QT_PLUGIN_PATH
    try {
        $colmapBin = Join-Path $engineRoot "colmap\bin"
        $env:PATH = "$colmapBin;$oldPath"
        $env:QT_PLUGIN_PATH = Join-Path $engineRoot "colmap\plugins"
        Invoke-CheckedVersionCommand `
            -Name "COLMAP" `
            -FilePath (Join-Path $colmapBin "colmap.exe") `
            -Arguments @("-h") `
            -ExpectedPattern 'COLMAP 4\.1\.0'
    }
    finally {
        $env:PATH = $oldPath
        $env:QT_PLUGIN_PATH = $oldQtPluginPath
    }

    Invoke-CheckedVersionCommand `
        -Name "Brush" `
        -FilePath (Join-Path $engineRoot "brush\brush_app.exe") `
        -Arguments @("--version") `
        -ExpectedPattern '(brush-cli|brush) 0\.3\.0'
}

Write-Host "Windows x64 engine pack verification passed: $engineRoot"
