Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$script:MetOriginRepositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot "..\..")
)

function Get-MetOriginRepositoryRoot {
    return $script:MetOriginRepositoryRoot
}

function Resolve-MetOriginPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $script:MetOriginRepositoryRoot $Path))
}

function Assert-MetOriginChildPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Parent
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $prefix = $fullParent + [System.IO.Path]::DirectorySeparatorChar

    if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside '$fullParent': '$fullPath'."
    }

    return $fullPath
}

function Reset-MetOriginDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$AllowedParent
    )

    $safePath = Assert-MetOriginChildPath -Path $Path -Parent $AllowedParent
    if (Test-Path -LiteralPath $safePath) {
        Remove-Item -LiteralPath $safePath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $safePath -Force | Out-Null
    return $safePath
}

function Get-MetOriginSha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant()
}

function Write-MetOriginUtf8File {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Content
    )

    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Read-MetOriginEngineLock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $resolved = Resolve-MetOriginPath -Path $Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Engine lock file not found: '$resolved'."
    }

    $lock = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
    if ($lock.schema_version -ne 1) {
        throw "Unsupported engine lock schema '$($lock.schema_version)'."
    }
    if ($lock.platform -ne "windows-x64") {
        throw "Expected a windows-x64 lock, got '$($lock.platform)'."
    }
    if ([string]::IsNullOrWhiteSpace([string]$lock.pack_version)) {
        throw "Engine lock pack_version is empty."
    }

    $required = @("ffmpeg", "colmap", "brush", "vcredist")
    foreach ($id in $required) {
        $property = $lock.components.PSObject.Properties[$id]
        if ($null -eq $property) {
            throw "Engine lock is missing component '$id'."
        }
        $component = $property.Value
        if ([string]$component.sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
            throw "Component '$id' has an invalid SHA-256."
        }
        if ([string]::IsNullOrWhiteSpace([string]$component.source_url)) {
            throw "Component '$id' has no source_url."
        }
        if ([string]::IsNullOrWhiteSpace([string]$component.archive_filename)) {
            throw "Component '$id' has no archive_filename."
        }
    }

    return $lock
}

function Get-MetOriginRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BasePath,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path '$full' is not below '$base'."
    }
    return $full.Substring($base.Length).Replace('\', '/')
}

function Write-MetOriginSha256Sums {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BasePath,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath,

        [string[]]$ExcludePaths = @()
    )

    $base = [System.IO.Path]::GetFullPath($BasePath)
    $excluded = @{}
    foreach ($exclude in $ExcludePaths) {
        $excluded[[System.IO.Path]::GetFullPath($exclude).ToUpperInvariant()] = $true
    }

    $lines = New-Object System.Collections.Generic.List[string]
    Get-ChildItem -LiteralPath $base -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            if (-not $excluded.ContainsKey($_.FullName.ToUpperInvariant())) {
                $relative = Get-MetOriginRelativePath -BasePath $base -Path $_.FullName
                $lines.Add("$(Get-MetOriginSha256 -Path $_.FullName)  $relative")
            }
        }
    Write-MetOriginUtf8File -Path $OutputPath -Content (($lines -join "`n") + "`n")
}
