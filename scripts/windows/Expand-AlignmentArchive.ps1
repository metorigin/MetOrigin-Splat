[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ([IO.Path]::IsPathRooted($name) -or $name.Contains(':') -or ($name.Split('/') -contains '..')) {
            throw "Unsafe archive entry: $name"
        }
        $candidate = [IO.Path]::GetFullPath((Join-Path $Destination $name))
        if (-not $candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Archive entry escapes staging: $name"
        }
        if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
            throw "Archive symbolic links are not accepted: $name"
        }
    }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
