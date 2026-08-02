[CmdletBinding()]
param(
    [string]$LockFile = "packaging/windows-x64/engine-lock.json",
    [string]$CacheDirectory = ".engines/downloads",
    [string]$OutputRoot = "target/distribution/windows-x64",
    [string]$VCRedistPath,
    [switch]$OfflineEngines,
    [switch]$SkipAcquire
)

. (Join-Path $PSScriptRoot "Packaging.Common.ps1")

$repositoryRoot = Get-MetOriginRepositoryRoot
if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitOperatingSystem) {
    throw "The full internal installer must be built on 64-bit Windows."
}

function Resolve-RequiredCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Names
    )

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) {
            return $command.Source
        }
    }
    throw "Required command not found: $($Names -join ', ')."
}

function Invoke-CheckedTool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $outputText = (& $FilePath @Arguments 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE.`n$outputText"
    }
    return $outputText
}

$node = Resolve-RequiredCommand -Names @("node.exe", "node")
$pnpm = Resolve-RequiredCommand -Names @("pnpm.cmd", "pnpm")
$cargo = Resolve-RequiredCommand -Names @("cargo.exe", "cargo")
$rustc = Resolve-RequiredCommand -Names @("rustc.exe", "rustc")

$rootPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json
$desktopPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot "apps\desktop\package.json") -Raw | ConvertFrom-Json
$fullConfig = Get-Content -LiteralPath (Join-Path $repositoryRoot "apps\desktop\src-tauri\tauri.full.conf.json") -Raw | ConvertFrom-Json
$lock = Read-MetOriginEngineLock -Path $LockFile
$appVersion = [string]$rootPackage.version

if ([string]$desktopPackage.version -ne $appVersion -or [string]$fullConfig.version -ne $appVersion) {
    throw "Root package, desktop package and full Tauri config versions must match."
}
if ([string]$lock.pack_version -notlike "$appVersion-internal.*") {
    throw "Engine pack version '$($lock.pack_version)' does not match app version '$appVersion'."
}
if ([string]$fullConfig.mainBinaryName -ne "MetOrigin Splat") {
    throw "Full Tauri config must produce 'MetOrigin Splat.exe'."
}

$expectedPnpm = ([string]$rootPackage.packageManager -split '@')[-1]
$actualPnpm = Invoke-CheckedTool -FilePath $pnpm -Arguments @("--version") -Name "pnpm"
if ($actualPnpm.Trim() -ne $expectedPnpm) {
    throw "pnpm $expectedPnpm is required; found '$actualPnpm'."
}

$nodeVersion = Invoke-CheckedTool -FilePath $node -Arguments @("--version") -Name "Node.js"
if ($nodeVersion -notmatch '^v(?<major>\d+)\.' -or [int]$Matches.major -lt 22) {
    throw "Node.js 22 or newer is required; found '$nodeVersion'."
}

$toolchain = Get-Content -LiteralPath (Join-Path $repositoryRoot "rust-toolchain.toml") -Raw
if ($toolchain -notmatch 'channel\s*=\s*"(?<channel>[^"]+)"') {
    throw "Unable to read the pinned Rust toolchain."
}
$expectedRust = $Matches.channel
$rustVersion = Invoke-CheckedTool -FilePath $rustc -Arguments @("--version") -Name "rustc"
if ($rustVersion -notmatch [regex]::Escape("rustc $expectedRust")) {
    throw "Rust $expectedRust is required; found '$rustVersion'."
}

Push-Location $repositoryRoot
try {
    $cargoMetadataText = Invoke-CheckedTool `
        -FilePath $cargo `
        -Arguments @("metadata", "--format-version", "1", "--no-deps") `
        -Name "cargo metadata"
    $cargoMetadata = $cargoMetadataText | ConvertFrom-Json
    $desktopCargoPackage = $cargoMetadata.packages |
        Where-Object { $_.name -eq "splat-desktop" } |
        Select-Object -First 1
    if ($null -eq $desktopCargoPackage -or [string]$desktopCargoPackage.version -ne $appVersion) {
        throw "Cargo desktop package version does not match '$appVersion'."
    }
    $targetDirectory = [System.IO.Path]::GetFullPath([string]$cargoMetadata.target_directory)

    Write-Host "Toolchain verified: $nodeVersion; pnpm $actualPnpm; $rustVersion"
    Write-Host "Cargo target directory: $targetDirectory"

    $prepareArguments = @{
        LockFile = $LockFile
        CacheDirectory = $CacheDirectory
        OutputRoot = $OutputRoot
    }
    if ($OfflineEngines) {
        $prepareArguments.Offline = $true
    }
    if ($SkipAcquire) {
        $prepareArguments.SkipAcquire = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($VCRedistPath)) {
        $prepareArguments.VCRedistPath = $VCRedistPath
    }
    & (Join-Path $PSScriptRoot "Prepare-EnginePack.ps1") @prepareArguments
    & (Join-Path $PSScriptRoot "Test-EnginePack.ps1") `
        -LockFile $LockFile `
        -OutputRoot $OutputRoot

    $nsisDirectory = Join-Path $targetDirectory "release\bundle\nsis"
    New-Item -ItemType Directory -Path $nsisDirectory -Force | Out-Null
    $finalName = "MetOrigin-Splat-Full-Setup-$appVersion-internal.exe"
    $finalInstaller = Join-Path $nsisDirectory $finalName
    if (Test-Path -LiteralPath $finalInstaller) {
        Remove-Item -LiteralPath $finalInstaller -Force
    }

    $buildStarted = [DateTime]::UtcNow
    Write-Host "Building the fully offline NSIS installer."
    & $pnpm --dir apps/desktop tauri build `
        --config src-tauri/tauri.full.conf.json `
        --bundles nsis
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri NSIS build failed with exit code $LASTEXITCODE."
    }

    $generatedInstallers = @(
        Get-ChildItem -LiteralPath $nsisDirectory -File -Filter "*.exe" |
            Where-Object {
                $_.LastWriteTimeUtc -ge $buildStarted.AddMinutes(-1)
            } |
            Sort-Object LastWriteTimeUtc -Descending
    )
    if ($generatedInstallers.Count -lt 1) {
        throw "Tauri completed but no new NSIS installer was found in '$nsisDirectory'."
    }
    if ($generatedInstallers.Count -gt 1) {
        $names = ($generatedInstallers | ForEach-Object { $_.Name }) -join ", "
        throw "More than one new NSIS installer was found: $names."
    }
    if ($generatedInstallers[0].FullName -ne $finalInstaller) {
        Move-Item -LiteralPath $generatedInstallers[0].FullName -Destination $finalInstaller -Force
    }

    $installerHash = Get-MetOriginSha256 -Path $finalInstaller
    $installerSums = Join-Path $nsisDirectory "SHA256SUMS.txt"
    Write-MetOriginUtf8File -Path $installerSums -Content "$installerHash  $finalName`n"

    $metadataDirectory = Join-Path $nsisDirectory "metadata"
    Reset-MetOriginDirectory -Path $metadataDirectory -AllowedParent $nsisDirectory | Out-Null
    $stagingRoot = Resolve-MetOriginPath -Path $OutputRoot
    Copy-Item `
        -LiteralPath (Join-Path $stagingRoot "engines\engine-manifest.json") `
        -Destination (Join-Path $metadataDirectory "engine-manifest.json")
    Copy-Item `
        -LiteralPath (Join-Path $stagingRoot "licenses\THIRD_PARTY_NOTICES.md") `
        -Destination (Join-Path $metadataDirectory "THIRD_PARTY_NOTICES.md")
    Copy-Item `
        -LiteralPath (Join-Path $stagingRoot "SHA256SUMS.txt") `
        -Destination (Join-Path $metadataDirectory "distribution-SHA256SUMS.txt")
    Copy-Item `
        -LiteralPath (Join-Path $stagingRoot "licenses") `
        -Destination (Join-Path $metadataDirectory "licenses") `
        -Recurse

    $buildMetadata = [ordered]@{
        schema_version = 1
        app_version = $appVersion
        pack_version = [string]$lock.pack_version
        platform = "windows-x64"
        installer = $finalName
        installer_sha256 = $installerHash
        unsigned_internal_build = $true
        created_utc = [DateTime]::UtcNow.ToString("o")
    }
    Write-MetOriginUtf8File `
        -Path (Join-Path $metadataDirectory "internal-build.json") `
        -Content (($buildMetadata | ConvertTo-Json -Depth 5) + "`n")

    Write-Host "Created internal installer: $finalInstaller"
    Write-Host "Installer SHA-256: $installerHash"
}
finally {
    Pop-Location
}
