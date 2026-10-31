[CmdletBinding()]
param(
    [string]$OutputRoot = 'target/distribution/windows-x64-alignment',
    [string]$CacheDirectory = '.engines/downloads',
    [string]$CargoTargetDirectory = 'target/windows-alignment-release-build',
    [switch]$OfflineEngines,
    [switch]$SkipAcquire,
    [switch]$NoBundle,
    [switch]$CheckOnly
)
. (Join-Path $PSScriptRoot 'Packaging.Common.ps1')
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Alignment candidates require native Windows x64.' }
$root = Get-MetOriginRepositoryRoot
$previousTarget = $env:CARGO_TARGET_DIR
$buildLockStream = $null
$buildLockPath = $null
Push-Location $root
try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
    $nodeVersion = (& $node --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v26\.') { throw 'Node 26 is required.' }
    $pnpmVersion = (& $pnpm --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne '11.12.0') { throw 'pnpm 11.12.0 is required.' }
    $rustVersion = (& rustc --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $rustVersion -notmatch '^rustc 1\.97\.0 ') { throw 'Rust 1.97.0 is required.' }
    if (-not $SkipAcquire) {
        & (Join-Path $PSScriptRoot 'Prepare-AlignmentEnginePack.ps1') -OutputRoot $OutputRoot -CacheDirectory $CacheDirectory -Offline:$OfflineEngines
    }
    # Every entry point verifies the complete current candidate before bundling.
    & (Join-Path $PSScriptRoot 'Test-AlignmentEnginePack.ps1') -OutputRoot $OutputRoot
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $generatedConfig = Join-Path $root "target/alignment-bundle/$stamp/tauri.conf.json"
    & $node (Join-Path $PSScriptRoot 'AlignmentPack.mjs') bundle-config --output $OutputRoot --config $generatedConfig
    if ($LASTEXITCODE -ne 0) { throw 'Candidate resource configuration failed verification.' }
    $configuration = Get-Content -LiteralPath $generatedConfig -Raw | ConvertFrom-Json
    $package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $desktopPackage = Get-Content -LiteralPath (Join-Path $root 'apps/desktop/package.json') -Raw | ConvertFrom-Json
    $appVersion = [string]$package.version
    if ([string]$configuration.version -ne $appVersion -or [string]$desktopPackage.version -ne $appVersion) { throw 'Candidate/root/desktop application versions differ.' }
    $binaryName = [string]$configuration.mainBinaryName
    if ($CheckOnly) { Write-Host "Candidate inputs/config verified: $generatedConfig"; return }
    $target = Resolve-MetOriginPath -Path $CargoTargetDirectory
    # Keep candidates away from the legacy application/installer cache.
    if ($target -eq (Resolve-MetOriginPath -Path 'target/windows-release-build')) { throw 'Candidate builds require a separate Cargo target directory.' }
    $buildLockPath = $target + '.alignment-build.lock'
    New-Item -ItemType Directory -Path (Split-Path -Parent $buildLockPath) -Force | Out-Null
    try { $buildLockStream = [IO.File]::Open($buildLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read) }
    catch {
        if (Test-Path -LiteralPath $buildLockPath) { throw "Candidate build cache is already locked: $buildLockPath. Check the owning process before removing a stale lock." }
        throw "Cannot create the candidate build-cache lock: $($_.Exception.Message)"
    }
    $ownerBytes = [Text.Encoding]::UTF8.GetBytes((@{pid=$PID; started_utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json))
    $buildLockStream.Write($ownerBytes,0,$ownerBytes.Length)
    $buildLockStream.Flush()
    $env:CARGO_TARGET_DIR = $target
    # Materialize the deterministic public assets before freezing source inputs;
    # the normal beforeBuild hooks will independently check/prepare them again.
    & $pnpm prepare:supersplat
    if ($LASTEXITCODE -ne 0) { throw 'Frontend asset preparation failed before source capture.' }
    $sourceInventory = Join-Path (Split-Path -Parent $generatedConfig) 'source-inventory.json'
    $outputInventory = Join-Path (Split-Path -Parent $generatedConfig) 'build-outputs.json'
    $bundleIdentity = Join-Path (Split-Path -Parent $generatedConfig) 'bundle-identity.json'
    $bundlerReceipt = Join-Path (Split-Path -Parent $generatedConfig) 'bundler-inputs.json'
    $bundlerOutputs = Join-Path (Split-Path -Parent $generatedConfig) 'bundler-outputs.json'
    $rustSysroot = (& rustc --print sysroot | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the actual Rust compiler.' }
    $rustCompiler = Join-Path $rustSysroot 'bin/rustc.exe'
    & $node (Join-Path $PSScriptRoot 'BuildSourceInventory.mjs') capture --pack $OutputRoot --config $generatedConfig --inventory $sourceInventory
    if ($LASTEXITCODE -ne 0) { throw 'Cannot freeze actual application source inputs.' }
    if (-not $NoBundle) {
        & $node (Join-Path $PSScriptRoot 'BuildBundlerReceipt.mjs') capture $target $node $pnpm $rustCompiler $bundlerReceipt
        if ($LASTEXITCODE -ne 0) { throw 'Cannot freeze cached NSIS/WebView2 and bundler tool inputs. Prewarm the Tauri NSIS cache before this provenance-bound build.' }
    }
    $started = [DateTime]::UtcNow
    if ($NoBundle) { & $pnpm --dir apps/desktop tauri build --config $generatedConfig --no-bundle }
    else { & $pnpm --dir apps/desktop tauri build --config $generatedConfig --bundles nsis }
    if ($LASTEXITCODE -ne 0) { throw 'Internal alignment candidate Tauri build failed.' }
    $application = Join-Path $target "release/$binaryName.exe"
    # Cargo may reuse a verified artifact and Tauri renames that executable;
    # its original mtime is not evidence of stale source after a successful build.
    if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
        throw 'Candidate build did not produce the configured application executable.'
    }
    & $node (Join-Path $PSScriptRoot 'BuildSourceInventory.mjs') verify --pack $OutputRoot --config $generatedConfig --inventory $sourceInventory --outputs $outputInventory --application $application
    if ($LASTEXITCODE -ne 0) { throw 'Application build inputs changed; no candidate will be published.' }
    $bundleKind = if ($NoBundle) { 'none' } else { 'nsis' }
    & $node (Join-Path $PSScriptRoot 'BundleIdentity.mjs') $application $bundleKind $bundleIdentity
    if ($LASTEXITCODE -ne 0) { throw 'Cannot bind the expected bundled application identity.' }
    if (-not $NoBundle) {
        & $node (Join-Path $PSScriptRoot 'BuildBundlerReceipt.mjs') verify $target $node $pnpm $rustCompiler $bundlerReceipt $bundlerOutputs
        if ($LASTEXITCODE -ne 0) { throw 'Bundler inputs changed; no candidate will be published.' }
    }
    $identityProof = Get-Content -LiteralPath $bundleIdentity -Raw | ConvertFrom-Json
    $pack = Resolve-MetOriginPath -Path $OutputRoot
    $manifest = Get-Content -LiteralPath (Join-Path $pack 'engines/engine-manifest.json') -Raw | ConvertFrom-Json
    $artifactParent = Join-Path $root "artifacts/windows/alignment-candidate/$($manifest.pack_version)"
    $artifact = Join-Path $artifactParent ".staging-$stamp"
    $finalArtifact = Join-Path $artifactParent $stamp
    New-Item -ItemType Directory -Path $artifact | Out-Null
    if ($NoBundle) {
        Copy-Item -LiteralPath $application -Destination (Join-Path $artifact "$binaryName.exe")
        New-Item -ItemType Directory -Path (Join-Path $artifact 'resources') | Out-Null
        foreach ($name in @('engines','licenses')) { Copy-Item -LiteralPath (Join-Path $pack $name) -Destination (Join-Path $artifact 'resources') -Recurse }
    } else {
        $installers = @(Get-ChildItem -LiteralPath (Join-Path $target 'release/bundle/nsis') -Filter '*.exe' -File | Where-Object { $_.LastWriteTimeUtc -ge $started.AddMinutes(-1) })
        if ($installers.Count -ne 1) { throw 'Expected exactly one fresh candidate NSIS installer.' }
        Copy-Item -LiteralPath $installers[0].FullName -Destination (Join-Path $artifact 'MetOrigin-Splat-Setup.exe')
    }
    # Recheck that build hooks did not alter the frozen engine inputs.
    & (Join-Path $PSScriptRoot 'Test-AlignmentEnginePack.ps1') -OutputRoot $OutputRoot
    $metadata = Join-Path $artifact 'metadata'
    New-Item -ItemType Directory -Path $metadata | Out-Null
    Copy-Item -LiteralPath (Join-Path $pack 'engines/engine-manifest.json') -Destination $metadata
    Copy-Item -LiteralPath (Join-Path $pack 'engines/BUILD-INFO.json') -Destination $metadata
    Copy-Item -LiteralPath (Join-Path $pack 'engines/brush/BUILD-INFO.json') -Destination (Join-Path $metadata 'brush-build-info.json')
    Copy-Item -LiteralPath (Join-Path $pack 'checksums.json') -Destination (Join-Path $metadata 'pack-checksums.json')
    Copy-Item -LiteralPath $generatedConfig -Destination (Join-Path $metadata 'tauri.conf.json')
    Copy-Item -LiteralPath $sourceInventory -Destination (Join-Path $metadata 'source-inventory.json')
    Copy-Item -LiteralPath $outputInventory -Destination (Join-Path $metadata 'build-outputs.json')
    Copy-Item -LiteralPath $bundleIdentity -Destination (Join-Path $metadata 'bundle-identity.json')
    if (-not $NoBundle) {
        Copy-Item -LiteralPath $bundlerReceipt -Destination (Join-Path $metadata 'bundler-inputs.json')
        Copy-Item -LiteralPath $bundlerOutputs -Destination (Join-Path $metadata 'bundler-outputs.json')
    }
    $sourceProof = Get-Content -LiteralPath $sourceInventory -Raw | ConvertFrom-Json
    $outputProof = Get-Content -LiteralPath $outputInventory -Raw | ConvertFrom-Json
    $revision = (& git rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to determine candidate source revision.' }
    $dirty = (& git status --porcelain | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to determine candidate source state.' }
    $record = [ordered]@{ schema_version=1; platform='windows-x64'; application_version=$appVersion; executable="$binaryName.exe"; pack_version=$manifest.pack_version;
        candidate=$true; public_release_approved=$false; native_macos_regression='pending'; dependency_license_review='pending';
        source_revision=$revision; working_tree_dirty=(-not [string]::IsNullOrWhiteSpace($dirty));
        source_inventory_digest=$sourceProof.digest; source_inventory_file='source-inventory.json';
        build_outputs_digest=$outputProof.digest; build_outputs_file='build-outputs.json';
        raw_application_sha256=$identityProof.raw_application_sha256; application_sha256=$identityProof.expected_payload_sha256;
        application_identity_kind='expected_payload_from_raw_build'; bundle_identity_file='bundle-identity.json';
        bundler_inputs_file=$(if ($NoBundle) { $null } else { 'bundler-inputs.json' });
        bundler_outputs_file=$(if ($NoBundle) { $null } else { 'bundler-outputs.json' });
        created_utc=[DateTime]::UtcNow.ToString('o') }
    Write-MetOriginUtf8File -Path (Join-Path $metadata 'candidate-build.json') -Content (($record | ConvertTo-Json -Depth 6)+"`n")
    Write-MetOriginSha256Sums -BasePath $artifact -OutputPath (Join-Path $artifact 'SHA256SUMS.txt') -ExcludePaths @((Join-Path $artifact 'SHA256SUMS.txt'))
    $safeArtifact = Assert-MetOriginChildPath -Path $artifact -Parent $artifactParent
    $safeFinal = Assert-MetOriginChildPath -Path $finalArtifact -Parent $artifactParent
    if (Test-Path -LiteralPath $safeFinal) { throw 'A candidate artifact with this identity already exists.' }
    Move-Item -LiteralPath $safeArtifact -Destination $safeFinal
    Write-Host "Internal unaccepted alignment candidate: $safeFinal"
} finally {
    if ($null -ne $buildLockStream) { $buildLockStream.Dispose(); Remove-Item -LiteralPath $buildLockPath -Force }
    $env:CARGO_TARGET_DIR=$previousTarget
    Pop-Location
}
