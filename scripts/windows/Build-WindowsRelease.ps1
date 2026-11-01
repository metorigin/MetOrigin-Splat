[CmdletBinding()]
param(
    [string]$ArtifactDirectory,
    [string]$CargoTargetDirectory = "target/windows-release-build",
    [switch]$AlignmentCandidate,
    [switch]$OfflineEngines,
    [switch]$SkipAcquire,
    [switch]$CheckOnly
)

. (Join-Path $PSScriptRoot "Packaging.Common.ps1")


if ($AlignmentCandidate) {
    if ($PSBoundParameters.ContainsKey('ArtifactDirectory')) { throw 'AlignmentCandidate writes a unique isolated artifact directory.' }
    $candidateArgs = @{ NoBundle=$true; OfflineEngines=$OfflineEngines; SkipAcquire=$SkipAcquire; CheckOnly=$CheckOnly }
    if ($PSBoundParameters.ContainsKey('CargoTargetDirectory')) { $candidateArgs.CargoTargetDirectory=$CargoTargetDirectory }
    & (Join-Path $PSScriptRoot 'Build-AlignmentCandidate.ps1') @candidateArgs
    return
}
if ($OfflineEngines -or $SkipAcquire -or $CheckOnly) { throw 'Engine/check options require AlignmentCandidate.' }

$repositoryRoot = Get-MetOriginRepositoryRoot
if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitOperatingSystem) {
    throw "The Windows release application must be built on 64-bit Windows."
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

$pnpm = Resolve-RequiredCommand -Names @("pnpm.cmd", "pnpm")
$cargo = Resolve-RequiredCommand -Names @("cargo.exe", "cargo")
$git = Resolve-RequiredCommand -Names @("git.exe", "git")
$rootPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json
$desktopPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot "apps\desktop\package.json") -Raw | ConvertFrom-Json
$tauriConfig = Get-Content -LiteralPath (Join-Path $repositoryRoot "apps\desktop\src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$appVersion = [string]$rootPackage.version
$binaryName = [string]$tauriConfig.mainBinaryName
$previousCargoTargetDirectory = $env:CARGO_TARGET_DIR
$isolatedCargoTargetDirectory = Resolve-MetOriginPath -Path $CargoTargetDirectory

if ([string]$desktopPackage.version -ne $appVersion -or [string]$tauriConfig.version -ne $appVersion) {
    throw "Root package, desktop package and Tauri config versions must match."
}
if ($binaryName -ne "MetOrigin Splat") {
    throw "Default Tauri config must produce 'MetOrigin Splat.exe'."
}

Push-Location $repositoryRoot
try {
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $verificationRoot = Get-MetOriginWindowsPath -Key 'verification'
    $reportDirectory = Join-Path $verificationRoot "build.$stamp"
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    if (-not $ArtifactDirectory) { $ArtifactDirectory = Join-Path (Get-MetOriginWindowsPath -Key 'packages') "build.$stamp" }
    New-Item -ItemType Directory -Path $isolatedCargoTargetDirectory -Force | Out-Null
    $env:CARGO_TARGET_DIR = $isolatedCargoTargetDirectory
    $cargoMetadataText = Invoke-CheckedTool `
        -FilePath $cargo `
        -Arguments @("metadata", "--format-version", "1", "--no-deps") `
        -Name "cargo metadata"
    $cargoMetadata = $cargoMetadataText | ConvertFrom-Json
    $targetDirectory = [System.IO.Path]::GetFullPath([string]$cargoMetadata.target_directory)
    $releaseExecutable = Join-Path $targetDirectory "release\$binaryName.exe"

    $buildStarted = [DateTime]::UtcNow
    Write-Host "Building the Windows release application."
    Write-Host "Isolated Cargo target directory: $targetDirectory"
    & $pnpm --dir apps/desktop tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri release build failed with exit code $LASTEXITCODE."
    }
    if (-not (Test-Path -LiteralPath $releaseExecutable -PathType Leaf)) {
        throw "Tauri completed but the expected executable was not found: '$releaseExecutable'."
    }
    $releaseItem = Get-Item -LiteralPath $releaseExecutable
    if ($releaseItem.LastWriteTimeUtc -lt $buildStarted.AddMinutes(-1)) {
        throw "The expected executable was not refreshed by this build: '$releaseExecutable'."
    }

    $windowsArtifactRoot = Get-MetOriginWindowsPath -Key 'packages'
    New-Item -ItemType Directory -Path $windowsArtifactRoot -Force | Out-Null
    $requestedArtifactDirectory = Resolve-MetOriginPath -Path $ArtifactDirectory
    if (Test-Path -LiteralPath $requestedArtifactDirectory) { throw 'Application output already exists; select a fresh ArtifactDirectory.' }
    New-Item -ItemType Directory -Path $requestedArtifactDirectory -Force | Out-Null
    $publishedDirectory = $requestedArtifactDirectory
    $publishedExecutable = Join-Path $publishedDirectory "$binaryName.exe"
    Copy-Item -LiteralPath $releaseExecutable -Destination $publishedExecutable

    $executableHash = Get-MetOriginSha256 -Path $publishedExecutable
    Write-MetOriginUtf8File `
        -Path (Join-Path $publishedDirectory "SHA256SUMS.txt") `
        -Content "$executableHash  $binaryName.exe`n"

    $revision = (Invoke-CheckedTool -FilePath $git -Arguments @("rev-parse", "HEAD") -Name "git rev-parse").Trim()
    $workingTreeState = (& $git status --porcelain 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "git status failed with exit code $LASTEXITCODE."
    }
    $buildMetadata = [ordered]@{
        schema_version = 1
        app_version = $appVersion
        platform = "windows-x64"
        executable = "$binaryName.exe"
        executable_sha256 = $executableHash
        source_revision = $revision
        working_tree_dirty = -not [string]::IsNullOrWhiteSpace($workingTreeState)
        created_utc = [DateTime]::UtcNow.ToString("o")
    }
    Write-MetOriginUtf8File `
        -Path (Join-Path $reportDirectory "build-info.json") `
        -Content (($buildMetadata | ConvertTo-Json -Depth 5) + "`n")

    $finalReport = Join-Path $reportDirectory 'final.json'
    $record = [ordered]@{ schema_version=1; status='passed'; platform='windows-x64'; kind='application';
        package=$publishedExecutable; package_sha256=$executableHash; created_utc=[DateTime]::UtcNow.ToString('o') }
    Write-MetOriginUtf8File -Path $finalReport -Content (($record | ConvertTo-Json -Depth 6)+"`n")
    $managedPackagePrefix = $windowsArtifactRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($publishedDirectory.StartsWith($managedPackagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        & node (Join-Path $repositoryRoot 'scripts/shared/artifact-retention.mjs') record --platform windows-x64 --report $finalReport --package $publishedDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Application retention registration failed.' }
    } else { Write-Host 'Explicit custom output is preserved outside managed package retention.' }
    $latest = ([ordered]@{ final_report=$finalReport; package=$publishedExecutable } | ConvertTo-Json)+"`n"
    Write-MetOriginUtf8File -Path (Join-Path $verificationRoot 'latest-app.json') -Content $latest
    Write-MetOriginUtf8File -Path (Join-Path $verificationRoot 'latest.json') -Content $latest
    Write-Host "Published Windows release application: $publishedExecutable"
    Write-Host "Executable SHA-256: $executableHash"
}
finally {
    if ($null -eq $previousCargoTargetDirectory) {
        Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:CARGO_TARGET_DIR = $previousCargoTargetDirectory
    }
    Pop-Location
}
