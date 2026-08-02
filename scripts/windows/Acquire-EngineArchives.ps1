[CmdletBinding()]
param(
    [string]$LockFile = "packaging/windows-x64/engine-lock.json",
    [string]$CacheDirectory = ".engines/downloads",
    [string]$VCRedistPath,
    [switch]$Offline,
    [switch]$Force
)

. (Join-Path $PSScriptRoot "Packaging.Common.ps1")

$lock = Read-MetOriginEngineLock -Path $LockFile
$cache = Resolve-MetOriginPath -Path $CacheDirectory
New-Item -ItemType Directory -Path $cache -Force | Out-Null

function Test-LockedComponentFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        $Component
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $item = Get-Item -LiteralPath $Path
    if ([int64]$item.Length -ne [int64]$Component.size_bytes) {
        return $false
    }
    return (Get-MetOriginSha256 -Path $Path) -eq ([string]$Component.sha256).ToUpperInvariant()
}

function Find-LocalVCRedist {
    param(
        [Parameter(Mandatory = $true)]
        $Component
    )

    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($VCRedistPath)) {
        $candidates.Add((Resolve-MetOriginPath -Path $VCRedistPath))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:METORIGIN_VC_REDIST_PATH)) {
        $candidates.Add([System.IO.Path]::GetFullPath($env:METORIGIN_VC_REDIST_PATH))
    }

    $programFilesRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -Unique
    foreach ($programFilesRoot in $programFilesRoots) {
        $vsRoot = Join-Path $programFilesRoot "Microsoft Visual Studio\2022"
        if (Test-Path -LiteralPath $vsRoot -PathType Container) {
            Get-ChildItem -LiteralPath $vsRoot -Directory -ErrorAction SilentlyContinue |
                ForEach-Object {
                    $redistRoot = Join-Path $_.FullName "VC\Redist\MSVC"
                    if (Test-Path -LiteralPath $redistRoot -PathType Container) {
                        Get-ChildItem -LiteralPath $redistRoot -Directory -ErrorAction SilentlyContinue |
                            Sort-Object Name -Descending |
                            ForEach-Object {
                                $candidates.Add((Join-Path $_.FullName "vc_redist.x64.exe"))
                            }
                    }
                }
        }
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (Test-LockedComponentFile -Path $candidate -Component $Component) {
            return $candidate
        }
    }
    return $null
}

function Save-LockedDownload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,

        [Parameter(Mandatory = $true)]
        [string]$Destination,

        [Parameter(Mandatory = $true)]
        $Component
    )

    $partial = "$Destination.partial"
    if (Test-Path -LiteralPath $partial) {
        Remove-Item -LiteralPath $partial -Force
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Host "Downloading $Uri"
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $partial
        if (-not (Test-LockedComponentFile -Path $partial -Component $Component)) {
            $actualLength = (Get-Item -LiteralPath $partial).Length
            $actualHash = Get-MetOriginSha256 -Path $partial
            throw "Downloaded file failed lock verification (size=$actualLength, sha256=$actualHash)."
        }
        Move-Item -LiteralPath $partial -Destination $Destination -Force
    }
    finally {
        if (Test-Path -LiteralPath $partial) {
            Remove-Item -LiteralPath $partial -Force
        }
    }
}

foreach ($property in $lock.components.PSObject.Properties) {
    $id = $property.Name
    $component = $property.Value
    $destination = Join-Path $cache ([string]$component.archive_filename)

    if (-not $Force -and (Test-LockedComponentFile -Path $destination -Component $component)) {
        Write-Host "Using locked $id archive: $destination"
        continue
    }

    if ($id -eq "vcredist") {
        $localVCRedist = Find-LocalVCRedist -Component $component
        if ($null -ne $localVCRedist) {
            Copy-Item -LiteralPath $localVCRedist -Destination $destination -Force
            Write-Host "Copied locked VC++ Runtime from: $localVCRedist"
            continue
        }
    }

    if ($Offline) {
        throw "Locked component '$id' is unavailable or invalid in '$cache' and -Offline was specified."
    }

    Save-LockedDownload `
        -Uri ([string]$component.source_url) `
        -Destination $destination `
        -Component $component
    Write-Host "Acquired locked $id archive: $destination"
}

foreach ($property in $lock.components.PSObject.Properties) {
    $id = $property.Name
    $component = $property.Value
    $path = Join-Path $cache ([string]$component.archive_filename)
    if (-not (Test-LockedComponentFile -Path $path -Component $component)) {
        throw "Final verification failed for '$id': '$path'."
    }
}

Write-Host "All locked Windows x64 components are available and verified."
