[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PythonRoot,
    [string]$RedistDirectory = $env:PDF_SEARCH_VC_REDIST_DIR
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$component = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json).msvc_runtime
if (-not $RedistDirectory) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $installations = @(& $vswhere -all -products '*' -property installationPath)
        if ($LASTEXITCODE -ne 0) { throw 'Unable to locate Visual Studio redistributable files.' }
        foreach ($installation in $installations) {
            $candidate = Join-Path $installation $component.relative_directory
            if (Test-Path -LiteralPath $candidate -PathType Container) {
                $RedistDirectory = $candidate
                break
            }
        }
    }
}
if (-not $RedistDirectory -or -not (Test-Path -LiteralPath $RedistDirectory -PathType Container)) {
    throw 'Pinned x64 Visual C++ redistributable missing. Install the matching VS 2022 Build Tools component or set PDF_SEARCH_VC_REDIST_DIR to its Microsoft.VC143.CRT directory; see docs/windows-runtime.md.'
}
$target = Get-Item -LiteralPath $PythonRoot -Force
if (-not $target.PSIsContainer -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    -not (Test-Path -LiteralPath (Join-Path $PythonRoot 'python.exe') -PathType Leaf)) {
    throw 'Private Python destination must be an ordinary runtime directory.'
}
# Validate the entire pinned input before copying. Never borrow CRT files from
# System32 or PATH: those would conceal missing clean-machine dependencies.
foreach ($entry in $component.files.PSObject.Properties) {
    $source = Join-Path $RedistDirectory $entry.Name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or
        ((Get-Item -LiteralPath $source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $entry.Value) {
        throw "Visual C++ runtime input is missing or has an unexpected checksum: $($entry.Name)"
    }
    $destination = Join-Path $PythonRoot $entry.Name
    if ((Test-Path -LiteralPath $destination) -and
        ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Refusing to overwrite a linked runtime file.'
    }
}
foreach ($entry in $component.files.PSObject.Properties) {
    Copy-Item -LiteralPath (Join-Path $RedistDirectory $entry.Name) -Destination (Join-Path $PythonRoot $entry.Name) -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../third-party/MSVC_RUNTIME_NOTICE.txt') -Destination (Join-Path $PythonRoot $component.notice_file)
Write-Output "Prepared app-local Visual C++ runtime $($component.version) ($($component.architecture))."
