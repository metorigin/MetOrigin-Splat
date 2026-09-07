[CmdletBinding()]
param(
    [string]$LockFile = "packaging/windows-x64/engine-lock.json",
    [string]$CacheDirectory = ".engines/downloads",
    [string]$OutputRoot = "target/distribution/windows-x64",
    [string]$VCRedistPath,
    [switch]$Offline,
    [switch]$SkipAcquire
)

. (Join-Path $PSScriptRoot "Packaging.Common.ps1")

$repositoryRoot = Get-MetOriginRepositoryRoot
$distributionRoot = Resolve-MetOriginPath -Path "target/distribution"
$output = Reset-MetOriginDirectory `
    -Path (Resolve-MetOriginPath -Path $OutputRoot) `
    -AllowedParent $distributionRoot
$engineRoot = Join-Path $output "engines"
$licenseRoot = Join-Path $output "licenses"
$installerRoot = Join-Path $output "installer"
$workRoot = Join-Path $output ".work"

New-Item -ItemType Directory -Path $engineRoot, $licenseRoot, $installerRoot, $workRoot -Force | Out-Null

$lock = Read-MetOriginEngineLock -Path $LockFile
$cache = Resolve-MetOriginPath -Path $CacheDirectory

if (-not $SkipAcquire) {
    $acquireArguments = @{
        LockFile = $LockFile
        CacheDirectory = $CacheDirectory
    }
    if ($Offline) {
        $acquireArguments.Offline = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($VCRedistPath)) {
        $acquireArguments.VCRedistPath = $VCRedistPath
    }
    & (Join-Path $PSScriptRoot "Acquire-EngineArchives.ps1") @acquireArguments
}

function Get-LockedArchivePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ComponentId
    )

    $component = $lock.components.PSObject.Properties[$ComponentId].Value
    $path = Join-Path $cache ([string]$component.archive_filename)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Locked archive is missing for '$ComponentId': '$path'."
    }
    $actualHash = Get-MetOriginSha256 -Path $path
    if ($actualHash -ne ([string]$component.sha256).ToUpperInvariant()) {
        throw "Locked archive hash mismatch for '$ComponentId': '$actualHash'."
    }
    if ([int64](Get-Item -LiteralPath $path).Length -ne [int64]$component.size_bytes) {
        throw "Locked archive size mismatch for '$ComponentId'."
    }
    return $path
}

function Expand-LockedArchive {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ComponentId
    )

    $destination = Join-Path $workRoot $ComponentId
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Expand-Archive -LiteralPath (Get-LockedArchivePath -ComponentId $ComponentId) `
        -DestinationPath $destination `
        -Force
    return $destination
}

function Find-SingleFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SearchRoot,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $matches = @(Get-ChildItem -LiteralPath $SearchRoot -Recurse -File -Filter $Name)
    if ($matches.Count -ne 1) {
        throw "Expected exactly one '$Name' below '$SearchRoot', found $($matches.Count)."
    }
    return $matches[0]
}

function Copy-RequiredFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,

        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required file not found: '$Source'."
    }
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-EngineFileRecords {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory
    )

    return @(
        Get-ChildItem -LiteralPath $Directory -Recurse -File |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = Get-MetOriginRelativePath -BasePath $engineRoot -Path $_.FullName
                    sha256 = Get-MetOriginSha256 -Path $_.FullName
                    size_bytes = [int64]$_.Length
                }
            }
    )
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,

        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

try {
    # FFmpeg: retain only the two command-line tools plus the archive's license/readme.
    $ffmpegExtracted = Expand-LockedArchive -ComponentId "ffmpeg"
    $ffmpegExecutable = Find-SingleFile -SearchRoot $ffmpegExtracted -Name "ffmpeg.exe"
    $ffmpegBin = $ffmpegExecutable.Directory.FullName
    $ffmpegSourceRoot = $ffmpegExecutable.Directory.Parent.FullName
    $ffmpegDestination = Join-Path $engineRoot "ffmpeg"
    Copy-RequiredFile -Source $ffmpegExecutable.FullName -Destination (Join-Path $ffmpegDestination "bin\ffmpeg.exe")
    Copy-RequiredFile -Source (Join-Path $ffmpegBin "ffprobe.exe") -Destination (Join-Path $ffmpegDestination "bin\ffprobe.exe")
    Copy-RequiredFile -Source (Join-Path $ffmpegSourceRoot "LICENSE") -Destination (Join-Path $ffmpegDestination "LICENSE")
    Copy-RequiredFile -Source (Join-Path $ffmpegSourceRoot "README.txt") -Destination (Join-Path $ffmpegDestination "README.txt")

    # COLMAP: retain the runtime tree, but strip unit tests, debug symbols and test launcher.
    $colmapExtracted = Expand-LockedArchive -ComponentId "colmap"
    $colmapExecutable = Find-SingleFile -SearchRoot $colmapExtracted -Name "colmap.exe"
    if ($colmapExecutable.Directory.Name -ne "bin") {
        throw "COLMAP executable is not inside the expected bin directory."
    }
    $colmapSourceRoot = $colmapExecutable.Directory.Parent.FullName
    $colmapDestination = Join-Path $engineRoot "colmap"
    Copy-DirectoryContents -Source $colmapSourceRoot -Destination $colmapDestination

    Get-ChildItem -LiteralPath $colmapDestination -Recurse -File |
        Where-Object { $_.Name -like "*_test.exe" -or $_.Extension -ieq ".pdb" } |
        ForEach-Object {
            Assert-MetOriginChildPath -Path $_.FullName -Parent $colmapDestination | Out-Null
            Remove-Item -LiteralPath $_.FullName -Force
        }
    $runTests = Join-Path $colmapDestination "RUN_TESTS.bat"
    if (Test-Path -LiteralPath $runTests) {
        Remove-Item -LiteralPath $runTests -Force
    }
    Copy-RequiredFile `
        -Source (Join-Path $repositoryRoot "packaging\windows-x64\licenses\COLMAP-COPYING.txt") `
        -Destination (Join-Path $colmapDestination "COPYING.txt")

    # Brush: retain only the release executable and its release documentation.
    $brushExtracted = Expand-LockedArchive -ComponentId "brush"
    $brushExecutable = Find-SingleFile -SearchRoot $brushExtracted -Name "brush_app.exe"
    $brushSourceRoot = $brushExecutable.Directory.FullName
    $brushDestination = Join-Path $engineRoot "brush"
    Copy-RequiredFile -Source $brushExecutable.FullName -Destination (Join-Path $brushDestination "brush_app.exe")
    foreach ($name in @("LICENSE", "README.md", "CHANGELOG.md")) {
        Copy-RequiredFile -Source (Join-Path $brushSourceRoot $name) -Destination (Join-Path $brushDestination $name)
    }

    # Build the pinned headless companion so packaged training also provides live previews.
    $liveArguments = @{}
    if ($Offline) { $liveArguments.Offline = $true }
    & (Join-Path $PSScriptRoot "Build-BrushLive.ps1") @liveArguments
    $liveRoot = Join-Path $repositoryRoot ".engines/brush-v0.3.0-windows-x64"
    Copy-RequiredFile -Source (Join-Path $liveRoot "brush_live.exe") -Destination (Join-Path $brushDestination "brush_live.exe")
    Copy-RequiredFile -Source (Join-Path $liveRoot "BRUSH-LIVE-LICENSE") -Destination (Join-Path $brushDestination "BRUSH-LIVE-LICENSE")

    # Generate the explicit internal-only third-party notice from the locked metadata.
    $noticeTemplatePath = Join-Path $repositoryRoot "packaging\windows-x64\THIRD_PARTY_NOTICES.template.md"
    $notice = Get-Content -LiteralPath $noticeTemplatePath -Raw
    $replacements = [ordered]@{
        "{{PACK_VERSION}}" = [string]$lock.pack_version
        "{{FFMPEG_VERSION}}" = [string]$lock.components.ffmpeg.version
        "{{FFMPEG_SOURCE_URL}}" = [string]$lock.components.ffmpeg.source_url
        "{{FFMPEG_SOURCE_SHA256}}" = ([string]$lock.components.ffmpeg.sha256).ToUpperInvariant()
        "{{COLMAP_VERSION}}" = [string]$lock.components.colmap.version
        "{{COLMAP_SOURCE_URL}}" = [string]$lock.components.colmap.source_url
        "{{COLMAP_SOURCE_SHA256}}" = ([string]$lock.components.colmap.sha256).ToUpperInvariant()
        "{{BRUSH_VERSION}}" = [string]$lock.components.brush.version
        "{{BRUSH_SOURCE_URL}}" = [string]$lock.components.brush.source_url
        "{{BRUSH_SOURCE_SHA256}}" = ([string]$lock.components.brush.sha256).ToUpperInvariant()
        "{{VCREDIST_VERSION}}" = [string]$lock.components.vcredist.version
        "{{VCREDIST_SOURCE_URL}}" = [string]$lock.components.vcredist.source_url
        "{{VCREDIST_SOURCE_SHA256}}" = ([string]$lock.components.vcredist.sha256).ToUpperInvariant()
    }
    foreach ($replacement in $replacements.GetEnumerator()) {
        $notice = $notice.Replace([string]$replacement.Key, [string]$replacement.Value)
    }
    if ($notice -match '\{\{[A-Z0-9_]+\}\}') {
        throw "Third-party notice contains an unresolved template token."
    }
    $noticePath = Join-Path $engineRoot "THIRD_PARTY_NOTICES.md"
    Write-MetOriginUtf8File -Path $noticePath -Content $notice

    $manifest = [ordered]@{
        schema_version = 1
        pack_version = [string]$lock.pack_version
        platform = "windows-x64"
        engines = [ordered]@{
            ffmpeg = [ordered]@{
                version = [string]$lock.components.ffmpeg.version
                executables = [ordered]@{
                    ffmpeg = "ffmpeg/bin/ffmpeg.exe"
                    ffprobe = "ffmpeg/bin/ffprobe.exe"
                }
                source_url = [string]$lock.components.ffmpeg.source_url
                source_sha256 = ([string]$lock.components.ffmpeg.sha256).ToUpperInvariant()
                files = @(Get-EngineFileRecords -Directory $ffmpegDestination)
                license_files = @("ffmpeg/LICENSE")
            }
            colmap = [ordered]@{
                version = [string]$lock.components.colmap.version
                executables = [ordered]@{
                    colmap = "colmap/bin/colmap.exe"
                }
                source_url = [string]$lock.components.colmap.source_url
                source_sha256 = ([string]$lock.components.colmap.sha256).ToUpperInvariant()
                files = @(Get-EngineFileRecords -Directory $colmapDestination)
                license_files = @("colmap/COPYING.txt")
            }
            brush = [ordered]@{
                version = [string]$lock.components.brush.version
                executables = [ordered]@{
                    brush = "brush/brush_app.exe"
                }
                source_url = [string]$lock.components.brush.source_url
                source_sha256 = ([string]$lock.components.brush.sha256).ToUpperInvariant()
                files = @(Get-EngineFileRecords -Directory $brushDestination)
                license_files = @("brush/LICENSE")
            }
        }
    }

    $manifestPath = Join-Path $engineRoot "engine-manifest.json"
    Write-MetOriginUtf8File -Path $manifestPath -Content (($manifest | ConvertTo-Json -Depth 12) + "`n")

    # Aggregate application and component notices under resources/licenses.
    Copy-RequiredFile -Source (Join-Path $repositoryRoot "LICENSE-MIT") -Destination (Join-Path $licenseRoot "LICENSE-MIT")
    Copy-RequiredFile -Source (Join-Path $repositoryRoot "LICENSE-APACHE") -Destination (Join-Path $licenseRoot "LICENSE-APACHE")
    Copy-RequiredFile -Source $noticePath -Destination (Join-Path $licenseRoot "THIRD_PARTY_NOTICES.md")
    Copy-RequiredFile -Source (Join-Path $ffmpegDestination "LICENSE") -Destination (Join-Path $licenseRoot "ffmpeg\LICENSE")
    Copy-RequiredFile -Source (Join-Path $colmapDestination "COPYING.txt") -Destination (Join-Path $licenseRoot "colmap\COPYING.txt")
    Copy-RequiredFile -Source (Join-Path $brushDestination "LICENSE") -Destination (Join-Path $licenseRoot "brush\LICENSE")

    Copy-RequiredFile -Source (Join-Path $brushDestination "BRUSH-LIVE-LICENSE") -Destination (Join-Path $licenseRoot "brush/BRUSH-LIVE-LICENSE")
    Copy-RequiredFile -Source (Join-Path $repositoryRoot "apps/desktop/node_modules/@sparkjsdev/spark/LICENSE") -Destination (Join-Path $licenseRoot "spark/LICENSE")

    # The prerequisite is a temporary installer resource, not an engine manifest entry.
    Copy-RequiredFile `
        -Source (Get-LockedArchivePath -ComponentId "vcredist") `
        -Destination (Join-Path $installerRoot "vc_redist.x64.exe")

    # Collect actual dependency texts and a review SBOM before checksums and bundling.
    $evidenceArguments = @((Join-Path $PSScriptRoot 'Generate-ReleaseEvidence.mjs'), $output)
    if ($Offline) { $evidenceArguments += '--offline' }
    & node @evidenceArguments
    if ($LASTEXITCODE -ne 0) { throw 'Release dependency evidence generation failed.' }
    & node (Join-Path $PSScriptRoot 'Test-ReleaseEvidence.mjs') $output
    if ($LASTEXITCODE -ne 0) { throw 'Release dependency evidence verification failed.' }
}
finally {
    $safeWorkRoot = Assert-MetOriginChildPath -Path $workRoot -Parent $output
    if (Test-Path -LiteralPath $safeWorkRoot) {
        Remove-Item -LiteralPath $safeWorkRoot -Recurse -Force
    }
}

$engineSumsPath = Join-Path $engineRoot "SHA256SUMS"
Write-MetOriginSha256Sums `
    -BasePath $engineRoot `
    -OutputPath $engineSumsPath `
    -ExcludePaths @($engineSumsPath)

$distributionSumsPath = Join-Path $output "SHA256SUMS.txt"
Write-MetOriginSha256Sums `
    -BasePath $output `
    -OutputPath $distributionSumsPath `
    -ExcludePaths @($distributionSumsPath)

& (Join-Path $PSScriptRoot "Test-EnginePack.ps1") `
    -LockFile $LockFile `
    -OutputRoot $OutputRoot `
    -SkipRuntimeChecks

Write-Host "Prepared Windows x64 engine pack: $engineRoot"
