[CmdletBinding()]
param(
    [string]$RuntimeDirectory = 'target/windows-brush/runtime',
    [string]$Dataset = 'target/windows-colmap/smoke-cuda-cpu-gp-02/dataset',
    [ValidateSet('dx12', 'vulkan')][string]$Backend = 'dx12',
    [ValidatePattern('^[a-fA-F0-9-]{36}$')][string]$RunId = ([guid]::NewGuid().ToString())
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The directory DACL contract requires native Windows.' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskAllowed = [IO.Path]::GetFullPath((Join-Path $taskRoot 'target/windows-brush'))
$taskOutput = [IO.Path]::GetFullPath((Join-Path $taskAllowed ('acl-' + $RunId)))
if (-not $taskOutput.StartsWith($taskAllowed + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $taskOutput) -ne ('acl-' + $RunId)) { throw 'Unsafe ACL evidence directory.' }
if (Test-Path -LiteralPath $taskOutput) { throw 'ACL evidence already exists; choose a fresh run ID.' }
New-Item -ItemType Directory -Path $taskOutput | Out-Null

function Resolve-TaskInput([string]$Path) {
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $taskRoot $Path))
}

function Assert-TaskAclTarget([string]$Path) {
    $taskChecked = [IO.Path]::GetFullPath($Path)
    if (-not $taskChecked.StartsWith($taskOutput + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ACL mutation escaped the newly created test directory.'
    }
    # Refuse junction/symlink ancestors rather than applying a DACL through a
    # lexical path that resolves to a different directory on the filesystem.
    $taskAncestor = $taskChecked
    while ($taskAncestor -and $taskAncestor -ne $taskRoot) {
        $taskItem = Get-Item -LiteralPath $taskAncestor -Force
        if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ACL test paths cannot contain reparse points.' }
        $taskAncestor = Split-Path -Parent $taskAncestor
    }
    if ($taskAncestor -ne $taskRoot) { throw 'ACL test directory is outside the workspace.' }
}

$taskRuntime = Resolve-TaskInput $RuntimeDirectory
$taskDataset = Resolve-TaskInput $Dataset
$taskBinary = Join-Path $taskRuntime 'bin/brush-cli.exe'
$taskInfo = Get-Content -LiteralPath (Join-Path $taskRuntime 'BUILD-INFO.json') -Raw | ConvertFrom-Json
$taskBinaryHash = (Get-FileHash -LiteralPath $taskBinary -Algorithm SHA256).Hash.ToLowerInvariant()
if ($taskBinaryHash -ne $taskInfo.binary_sha256) { throw 'Brush executable does not match BUILD-INFO.' }
$taskExpected = Get-Content -LiteralPath (Join-Path $taskRoot 'integrations/brush-windows/source-lock.json') -Raw | ConvertFrom-Json
if (($taskInfo.inputs.lock | ConvertTo-Json -Depth 30 -Compress) -ne ($taskExpected | ConvertTo-Json -Depth 30 -Compress)) {
    throw 'Brush build does not match the current frozen Windows source lock.'
}
$taskRecord = [ordered]@{
    schema_version = 1
    scope = 'Native Windows directory DACL denial, final Brush subprocess, last complete checkpoint preserved'
    binary_sha256 = $taskBinaryHash
    backend = $Backend
    source_lock = $taskExpected
    checks = [Collections.Generic.List[object]]::new()
    status = 'running'
    acl_restored = $false
    temporary_probe_removed = $false
    child_processes_exited = $true
}
function Save-TaskEvidence {
    $taskRecord | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $taskOutput 'evidence.json') -Encoding utf8
}

function Invoke-TaskProcess([string]$Executable, [string[]]$Arguments, [string]$Label, [int]$TimeoutSeconds = 180) {
    $taskStart = [Diagnostics.ProcessStartInfo]::new()
    $taskStart.FileName = $Executable
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    foreach ($taskArgument in $Arguments) { $taskStart.ArgumentList.Add($taskArgument) }
    $taskProcess = [Diagnostics.Process]::new()
    $taskProcess.StartInfo = $taskStart
    $taskTimer = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $taskProcess.Start()) { throw 'Unable to start the owned test subprocess.' }
        $taskStdout = $taskProcess.StandardOutput.ReadToEndAsync()
        $taskStderr = $taskProcess.StandardError.ReadToEndAsync()
        if (-not $taskProcess.WaitForExit($TimeoutSeconds * 1000)) { throw "Test subprocess timed out: $Label" }
        $taskOutText = $taskStdout.GetAwaiter().GetResult()
        $taskErrText = $taskStderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $taskOutput ($Label + '.stdout.log')), $taskOutText)
        [IO.File]::WriteAllText((Join-Path $taskOutput ($Label + '.stderr.log')), $taskErrText)
        $taskEntry = [ordered]@{ label = $Label; argv = $Arguments; exit_code = $taskProcess.ExitCode; seconds = $taskTimer.Elapsed.TotalSeconds }
        $taskRecord.checks.Add($taskEntry)
        Save-TaskEvidence
        return [pscustomobject]@{ ExitCode = $taskProcess.ExitCode; Stdout = $taskOutText; Stderr = $taskErrText }
    } finally {
        # This retained Process object identifies only the child started above.
        # Never enumerate or kill unrelated engine/application process names.
        try {
            if ($taskProcess.Id -and -not $taskProcess.HasExited) {
                $taskProcess.Kill($true)
                if (-not $taskProcess.WaitForExit(30000)) { throw 'Owned test subprocess did not exit after termination.' }
            }
        } catch {
            $taskRecord.child_processes_exited = $false
            throw
        } finally { $taskProcess.Dispose() }
    }
}

$taskExport = Join-Path $taskOutput '输出 checkpoints'
$taskLocalDataset = Join-Path $taskOutput '输入 数据集'
$taskSentinel = Join-Path $taskExport '.acl-write-probe'
$taskOriginalAcl = $null
$taskDaclChanged = $false
$taskRestoreError = $null
$taskFailure = $null
$taskSections = [Security.AccessControl.AccessControlSections]::Access -bor
    [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
try {
    $taskCapsResult = Invoke-TaskProcess $taskBinary @('--capabilities-json') 'capabilities'
    $taskCaps = $taskCapsResult.Stdout | ConvertFrom-Json
    if ($taskCapsResult.ExitCode -ne 0 -or $taskCaps.target -ne $taskExpected.target -or
        $taskCaps.build_id -ne $taskExpected.build_id -or $taskCaps.source_commit -ne $taskExpected.source_commit) {
        throw 'Brush machine identity does not match the frozen Windows engine.'
    }
    $taskProbeResult = Invoke-TaskProcess $taskBinary @('--probe-json', '--graphics-backend', $Backend) 'probe'
    $taskProbe = $taskProbeResult.Stdout | ConvertFrom-Json
    if ($taskProbeResult.ExitCode -ne 0 -or $taskProbe.status -ne 'supported' -or $taskProbe.backend -ne $Backend -or
        -not $taskProbe.device_id -or $taskProbe.compute.gradient_l1 -le 0) { throw 'Actual GPU compute probe failed.' }
    $taskRecord.probe = $taskProbe
    Copy-Item -LiteralPath $taskDataset -Destination $taskLocalDataset -Recurse
    New-Item -ItemType Directory -Path $taskExport | Out-Null
    $taskArguments = @($taskLocalDataset, '--graphics-backend', $Backend, '--graphics-device', $taskProbe.device_id,
        '--total-train-iters', '1', '--start-iter', '0', '--max-resolution', '960', '--max-splats', '300000',
        '--max-scene-batch-cache-size', '512MiB', '--sh-degree', '0', '--lod-levels', '0', '--num-loader-threads', '2',
        '--export-every', '1', '--export-name', 'checkpoint_{iter}.ply', '--export-path', $taskExport)
    $taskBaseline = Invoke-TaskProcess $taskBinary $taskArguments 'baseline'
    if ($taskBaseline.ExitCode -ne 0) { throw 'Baseline checkpoint creation failed before ACL injection.' }
    $taskCheckpoints = @(Get-ChildItem -LiteralPath $taskExport -Filter 'checkpoint_*.ply' -File)
    if ($taskCheckpoints.Count -ne 1) { throw 'Baseline did not create exactly one complete checkpoint.' }
    $taskCheckpoint = $taskCheckpoints[0].FullName
    $taskOldHash = (Get-FileHash -LiteralPath $taskCheckpoint -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskValidationCode = 'import sys;sys.path.insert(0,sys.argv[1]);from check_brush_runtime import load_smoke;import json;print(json.dumps(load_smoke().validate_ply(sys.argv[2])))'
    $taskValidated = Invoke-TaskProcess 'python' @('-X', 'utf8', '-c', $taskValidationCode, $PSScriptRoot, $taskCheckpoint) 'validate-before'
    if ($taskValidated.ExitCode -ne 0) { throw 'Baseline checkpoint is not a valid finite Gaussian PLY.' }
    $taskRecord.checkpoint_before = $taskValidated.Stdout | ConvertFrom-Json
    Assert-TaskAclTarget $taskExport
    $taskOriginalAcl = Get-Acl -LiteralPath $taskExport
    $taskOriginalSddl = $taskOriginalAcl.GetSecurityDescriptorSddlForm($taskSections)
    [IO.File]::WriteAllText((Join-Path $taskOutput 'original-acl.sddl'), $taskOriginalSddl)
    $taskDeniedAcl = Get-Acl -LiteralPath $taskExport
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $taskRights = [Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories
    $taskRule = [Security.AccessControl.FileSystemAccessRule]::new($taskSid, $taskRights,
        [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Deny)
    $taskDeniedAcl.AddAccessRule($taskRule)
    # The only DACL mutation is this freshly created child directory.
    # Ownership and WRITE_DAC remain intact, allowing restoration in finally.
    $taskDaclChanged = $true
    Set-Acl -LiteralPath $taskExport -AclObject $taskDeniedAcl
    $taskWriteDenied = $false
    try {
        $taskStream = [IO.File]::Open($taskSentinel, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $taskStream.Dispose()
    } catch [UnauthorizedAccessException] { $taskWriteDenied = $true }
    if (-not $taskWriteDenied) { throw 'Native DACL did not deny file creation; the fault injection is invalid.' }
    $taskRecord.direct_create_denied = $true
    $taskDenied = Invoke-TaskProcess $taskBinary $taskArguments 'denied-export'
    if ($taskDenied.ExitCode -eq 0) { throw 'Brush falsely succeeded while checkpoint publication was denied.' }
    if ($taskDenied.Stdout.Contains('Done training!')) { throw 'Denied checkpoint publication was reported as successful completion.' }
    $taskRecord.denied_export_exit_code = $taskDenied.ExitCode
    $taskRecord.checkpoint_hash_preserved_under_denial = ((Get-FileHash -LiteralPath $taskCheckpoint -Algorithm SHA256).Hash.ToLowerInvariant() -eq $taskOldHash)
    if (-not $taskRecord.checkpoint_hash_preserved_under_denial) { throw 'ACL failure changed the last valid checkpoint.' }
    if (@(Get-ChildItem -LiteralPath $taskExport -Force -Filter '*.part').Count -ne 0) { throw 'Denied creation left unpublished checkpoint temporary files.' }
    $taskAfter = Invoke-TaskProcess 'python' @('-X', 'utf8', '-c', $taskValidationCode, $PSScriptRoot, $taskCheckpoint) 'validate-after-denial'
    if ($taskAfter.ExitCode -ne 0) { throw 'The checkpoint became invalid after publication denial.' }
    $taskRecord.checkpoint_after_denial = $taskAfter.Stdout | ConvertFrom-Json
    $taskRecord.status = 'passed'
} catch {
    $taskFailure = $_
    $taskRecord.status = 'failed'
    $taskRecord.failure = $_.Exception.Message
} finally {
    try {
        if ($taskOriginalAcl -and $taskDaclChanged) {
            Assert-TaskAclTarget $taskExport
            Set-Acl -LiteralPath $taskExport -AclObject $taskOriginalAcl
            $taskRestored = (Get-Acl -LiteralPath $taskExport).GetSecurityDescriptorSddlForm($taskSections)
            if ($taskRestored -ne $taskOriginalSddl) { throw 'Restored DACL/owner/group differ from the saved native descriptor.' }
            [IO.File]::WriteAllText($taskSentinel, 'restored permission probe')
            Remove-Item -LiteralPath $taskSentinel
            $taskRecord.acl_restored = $true
            $taskRecord.temporary_probe_removed = -not (Test-Path -LiteralPath $taskSentinel)
        }
    } catch {
        $taskRestoreError = $_
        $taskRecord.status = 'failed'
        $taskRecord.restore_failure = $_.Exception.Message
    }
    Save-TaskEvidence
}
if ($taskRestoreError) { throw $taskRestoreError }
if ($taskFailure) { throw $taskFailure }
Write-Host "Passed native directory DACL failure and checkpoint preservation: $taskOutput"
