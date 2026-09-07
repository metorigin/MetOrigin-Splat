[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v\d+\.\d+\.\d+-alpha\.\d+$')]
    [string]$Tag,
    [string]$Repository = 'metorigin/MetOrigin-Splat',
    [switch]$PrepareOnly
)

. (Join-Path $PSScriptRoot 'Packaging.Common.ps1')
$root = Get-MetOriginRepositoryRoot
$installerDirectory = Join-Path $root 'artifacts/windows/installer'
$metadata = Get-Content -LiteralPath (Join-Path $installerDirectory 'metadata/internal-build.json') -Raw | ConvertFrom-Json
# A publisher-only fix may be newer than the build. Always archive and target the
# exact clean revision recorded by the installer, never substitute the latest HEAD.
if ($metadata.source_revision -notmatch '^[0-9a-f]{40}$') { throw 'Installer has no valid recorded source revision; rebuild it.' }
$revision = (& git -C $root rev-parse --verify "$($metadata.source_revision)^{commit}" | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Recorded build source revision is not available locally.' }
$dirty = (& git -C $root status --porcelain | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read working tree status.' }
if ($dirty -or $metadata.working_tree_dirty -or $metadata.source_revision -ne $revision) {
    throw 'Commit the reviewed changes and rebuild from the exact clean source revision before preparing a GitHub draft.'
}
if (-not $Tag.StartsWith("v$($metadata.app_version)-alpha.")) { throw 'Tag does not match the installer application version.' }
$installer = Assert-MetOriginChildPath -Path (Join-Path $installerDirectory $metadata.installer) -Parent $installerDirectory
if ((Get-MetOriginSha256 -Path $installer) -ne $metadata.installer_sha256) { throw 'Installer hash does not match build metadata.' }
$signature = [string](Get-AuthenticodeSignature -LiteralPath $installer).Status
if ($signature -ne 'NotSigned') { throw "Expected the explicitly selected unsigned Alpha candidate, got '$signature'." }

$licenseRoot = Join-Path $installerDirectory 'metadata/licenses'
$readiness = Get-Content -LiteralPath (Join-Path $licenseRoot 'release-readiness.json') -Raw | ConvertFrom-Json
$bom = Get-Content -LiteralPath (Join-Path $licenseRoot 'SBOM.cdx.json') -Raw | ConvertFrom-Json
if ($readiness.source_revision -ne $revision) { throw 'Release evidence is not from this build revision.' }
if ($bom.bomFormat -ne 'CycloneDX' -or $bom.specVersion -ne '1.6') { throw 'Missing CycloneDX review SBOM.' }

# Preserve reviewed candidates; never delete or overwrite an existing one.
$reviewRoot = Join-Path $root 'artifacts/windows/release-review'
New-Item -ItemType Directory -Path $reviewRoot -Force | Out-Null
$output = Assert-MetOriginChildPath -Path (Join-Path $reviewRoot $Tag) -Parent $reviewRoot
if (Test-Path -LiteralPath $output) { throw "Review directory already exists: $output. Preserve it and select a new Alpha number." }
New-Item -ItemType Directory -Path $output | Out-Null
$candidateName = "MetOrigin-Splat-Full-Setup-$Tag-unsigned.exe"
Copy-Item -LiteralPath $installer -Destination (Join-Path $output $candidateName)
foreach ($name in @('SBOM.cdx.json', 'release-readiness.json', 'native-payload-inventory.json', 'dependency-license-index.json', 'THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $licenseRoot $name) -Destination (Join-Path $output $name)
}
Copy-Item -LiteralPath (Join-Path $installerDirectory 'metadata/internal-build.json') -Destination (Join-Path $output 'build-info.json')
Copy-Item -LiteralPath (Join-Path $installerDirectory 'metadata/engine-manifest.json') -Destination (Join-Path $output 'engine-manifest.json')
# Unlike Compress-Archive on Windows PowerShell 5.1, ZipFile clamps source dates
# outside ZIP's 1980-2107 range (some upstream package license dates are in 1970).
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $licenseRoot,
    (Join-Path $output 'Third-Party-Notices.zip'),
    [System.IO.Compression.CompressionLevel]::Optimal,
    $true
)
$sourceZip = Join-Path $output "MetOrigin-Splat-Source-$Tag.zip"
& git -C $root archive --format=zip "--output=$sourceZip" $revision
if ($LASTEXITCODE -ne 0) { throw 'Could not archive exact application source revision.' }

$blockers = @($readiness.blockers | ForEach-Object { "- **$($_.id)**: $($_.detail)" }) -join "`n"
$notes = @"
# MetOrigin Splat $Tag - Windows x64 unsigned candidate

This is a **maintainer review draft**, not a public download release. Third-party
redistribution evidence and clean-machine validation are still pending. Keep this
release in draft until the items below have been resolved.

- Source revision: $revision
- Installer: $candidateName
- Signature: **NotSigned**. Windows may warn or block according to device policy.
- Includes FFmpeg, COLMAP, Brush and the MetOrigin live-preview companion.
- Review inventory: $($readiness.evidence.source_components) components,
  $($readiness.evidence.native_payload_files) native payload files,
  $($readiness.evidence.collected_license_texts) license/notice texts.
- SBOM.cdx.json explicitly declares an **incomplete** composition.
- The application source ZIP is not the corresponding-source package for bundled engines.

## Remaining publication work

$blockers

See release-readiness.json for missing license texts and evidence limitations.
SHA256SUMS.txt covers all attached review artifacts except itself.
"@
Write-MetOriginUtf8File -Path (Join-Path $output 'RELEASE-NOTES.md') -Content $notes
$sums = Join-Path $output 'SHA256SUMS.txt'
Write-MetOriginSha256Sums -BasePath $output -OutputPath $sums -ExcludePaths @($sums)

if ($PrepareOnly) { Write-Host "Prepared review artifacts: $output"; return }
& gh auth status --hostname github.com 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GitHub authentication unavailable. Review artifacts are retained locally.' }
$existingJson = & gh api "repos/$Repository/releases" --paginate --jq '.[].tag_name'
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing releases; refusing to create blindly.' }
if (@($existingJson) -contains $Tag) { throw 'Release tag already exists; refusing to overwrite its assets.' }
$assets = @(Get-ChildItem -LiteralPath $output -File | ForEach-Object { $_.FullName })
& gh release create $Tag --repo $Repository --target $revision --draft --prerelease `
    --title "MetOrigin Splat $Tag - Windows unsigned candidate" `
    --notes-file (Join-Path $output 'RELEASE-NOTES.md') @assets
if ($LASTEXITCODE -ne 0) { throw 'Draft upload did not complete. Inspect GitHub before retrying; local artifacts were retained.' }
& gh release view $Tag --repo $Repository --json url,isDraft,isPrerelease,assets
if ($LASTEXITCODE -ne 0) { throw 'Draft created but final remote verification failed.' }
