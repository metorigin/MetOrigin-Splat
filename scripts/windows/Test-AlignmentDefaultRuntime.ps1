[CmdletBinding()]
param(
    [string]$BrushPath = 'target/distribution/windows-x64-alignment/engines/brush/bin/brush-cli.exe',
    [string]$OutputRoot = 'target/windows-default-runtime-validation',
    [string]$CargoTargetDirectory = 'target'
)
. (Join-Path $PSScriptRoot 'Packaging.Common.ps1')
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'This acceptance entry requires native Windows x64.' }
$root = Get-MetOriginRepositoryRoot
$brush = Resolve-MetOriginPath -Path $BrushPath
$outputParent = Assert-MetOriginChildPath -Path $OutputRoot -Parent (Join-Path $root 'target')
$target = Assert-MetOriginChildPath -Path $CargoTargetDirectory -Parent $root
if (-not (Test-Path -LiteralPath $brush -PathType Leaf)) { throw 'The selected paired Windows1 Brush executable is missing.' }
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$runRoot = Join-Path $outputParent $stamp
New-Item -ItemType Directory -Path $runRoot | Out-Null
$probeOutput = Join-Path $runRoot 'probe'
$variables = @('METORIGIN_BRUSH_BACKEND','METORIGIN_BRUSH_DEVICE_ID','METORIGIN_TEST_BRUSH','METORIGIN_TEST_DEFAULT_PROBE_OUTPUT','CARGO_TARGET_DIR')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$sourceInputs = @('Cargo.lock','crates/splat-engine-brush/src/runtime.rs','crates/splat-engine-brush/tests/windows_default_runtime.rs','scripts/windows/Test-AlignmentDefaultRuntime.ps1')
$hashes = [ordered]@{}
foreach ($relative in $sourceInputs) { $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $root $relative) -Algorithm SHA256).Hash.ToLowerInvariant() }
$record = [ordered]@{ schema_version=1; status='running'; started_utc=[DateTime]::UtcNow.ToString('o');
    brush_path=$brush; brush_sha256=(Get-FileHash -LiteralPath $brush -Algorithm SHA256).Hash.ToLowerInvariant();
    source_inputs=$hashes; probe_evidence='probe/evidence.json';
    override_environment_in_child='both_absent'; environment_scope='owned_cargo_child_only_parent_process_unmodified';
    scope='Opt-in production Windows1 preflight; tiny real DX12 compute only; no application UI, dataset, project or training' }
$launcherEvidence = Join-Path $runRoot 'launcher.json'
function Save-LauncherEvidence { Write-MetOriginUtf8File -Path $launcherEvidence -Content (($record | ConvertTo-Json -Depth 8)+"`n") }
Push-Location $root
try {
    Save-LauncherEvidence
    $arguments = @('test','--locked','-p','splat-engine-brush','--test','windows_default_runtime',
        'windows_default_runtime_without_backend_or_device_environment','--','--ignored','--exact','--nocapture','--test-threads=1')
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command cargo.exe -ErrorAction Stop).Source
    $startInfo.Arguments = $arguments -join ' '
    $startInfo.WorkingDirectory = $root
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables.Remove('METORIGIN_BRUSH_BACKEND')
    $startInfo.EnvironmentVariables.Remove('METORIGIN_BRUSH_DEVICE_ID')
    $startInfo.EnvironmentVariables['METORIGIN_TEST_BRUSH'] = $brush
    $startInfo.EnvironmentVariables['METORIGIN_TEST_DEFAULT_PROBE_OUTPUT'] = $probeOutput
    $startInfo.EnvironmentVariables['CARGO_TARGET_DIR'] = $target
    if ($startInfo.EnvironmentVariables.ContainsKey('METORIGIN_BRUSH_BACKEND') -or
        $startInfo.EnvironmentVariables.ContainsKey('METORIGIN_BRUSH_DEVICE_ID')) { throw 'Override keys must be absent from the native child environment.' }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Cannot start the native default-runtime test.' }
        $ownedHandle = $process.Handle
        $record['test_process_id'] = $process.Id
        $record['test_argv'] = $arguments
        Save-LauncherEvidence
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        [IO.File]::WriteAllText((Join-Path $runRoot 'native-test.stdout.log'), $stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $runRoot 'native-test.stderr.log'), $stderr.GetAwaiter().GetResult())
        $record['exit_code'] = $process.ExitCode
    } finally { $process.Dispose() }
    if ($record['exit_code'] -ne 0) { throw 'The native default-DX12 preflight failed; raw test logs and probe evidence are preserved.' }
    foreach ($relative in $sourceInputs) {
        if ((Get-FileHash -LiteralPath (Join-Path $root $relative) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$relative]) { throw "Validation source changed while the test ran: $relative" }
    }
    $result = Get-Content -LiteralPath (Join-Path $probeOutput 'evidence.json') -Raw | ConvertFrom-Json
    if ($result.status -ne 'passed' -or $result.probe.backend -ne 'dx12' -or
        $result.backend_environment_present -or $result.device_environment_present) { throw 'No-environment compute evidence did not match the requested acceptance scope.' }
    $record['status'] = 'passed'
} catch {
    $record['status'] = 'failed'
    $record['error'] = $_.Exception.Message
    throw
} finally {
    # Only the owned child environment was changed; the caller's environment
    # and machine/user environment were never modified.
    $record['environment_restored'] = $true
    foreach ($name in $variables) {
        if ([Environment]::GetEnvironmentVariable($name, 'Process') -ne $previous[$name]) { $record['environment_restored'] = $false }
    }
    $record['completed_utc'] = [DateTime]::UtcNow.ToString('o')
    Save-LauncherEvidence
    Pop-Location
    Write-Host "Default-runtime validation evidence: $runRoot"
}
