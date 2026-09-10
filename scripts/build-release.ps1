[CmdletBinding()]
param([ValidateSet('Core', 'Ocr')][string]$Edition = 'Core')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previousCargoTarget = [Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR', 'Process')
Push-Location $projectRoot
try {
    $sourceCommit = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Source commit unavailable.' }
    $pendingChanges = & git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'Unable to verify source status.' }
    if ($pendingChanges) { throw 'Commit or preserve pending source changes before building a release.' }
    $runtime = Join-Path $projectRoot '.build/runtime/python'
    & (Join-Path $PSScriptRoot 'prepare-runtime.ps1') -Edition $Edition -Rebuild:([bool](Test-Path -LiteralPath (Join-Path $projectRoot '.build/runtime')))
    if ($LASTEXITCODE -ne 0) { throw 'Runtime preparation failed.' }
    & bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    $cargoMetadataPath = Join-Path $projectRoot '.build/cargo-metadata.json'
    & cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --locked --filter-platform x86_64-pc-windows-msvc | Set-Content -LiteralPath $cargoMetadataPath -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve third-party Rust components.' }
    & (Join-Path $runtime 'python.exe') -B -I (Join-Path $PSScriptRoot 'collect-third-party-notices.py') --cargo-metadata $cargoMetadataPath --output-dir $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Third-party license collection failed.' }
    & (Join-Path $runtime 'python.exe') -B -I (Join-Path $PSScriptRoot 'audit-public-tree.py')
    if ($LASTEXITCODE -ne 0) { throw 'Public tree audit failed.' }
    # No developer-machine filenames in Python bytecode shipped in the package.
    Get-ChildItem -LiteralPath $runtime -Recurse -File -Filter '*.pyc' | Remove-Item -Force
    # Pin output location and architecture; never pick up an old default-path asset.
    $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'src-tauri/target'
    $buildStarted = [DateTime]::UtcNow
    & bun run tauri build --bundles nsis --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed.' }
    $afterCommit = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Unable to verify source commit after build.' }
    $afterChanges = & git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'Unable to verify source status after build.' }
    if ($afterCommit -ne $sourceCommit -or $afterChanges) {
        throw 'Source changed while building; package not promoted to a release.'
    }
    $package = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
    $version = $package.version
    $sourcePackage = Join-Path $projectRoot ("src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/银行回单工作台_${version}_x64-setup.exe")
    if (-not (Test-Path -LiteralPath $sourcePackage -PathType Leaf)) { throw 'Expected NSIS package missing.' }
    if ((Get-Item -LiteralPath $sourcePackage).LastWriteTimeUtc -lt $buildStarted) { throw 'Refusing to publish a stale installer.' }
    $outputRoot = Join-Path $projectRoot ("outputs/releases/$version-" + $Edition.ToLowerInvariant())
    if (Test-Path -LiteralPath $outputRoot) { throw 'Release output already exists; preserve it or choose another version before rebuilding.' }
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    $assetName = "银行回单工作台_${version}_$($Edition.ToLowerInvariant())_x64-setup.exe"
    $asset = Join-Path $outputRoot $assetName
    Copy-Item -LiteralPath $sourcePackage -Destination $asset
    Copy-Item -LiteralPath (Join-Path $runtime 'runtime-info.json') -Destination $outputRoot
    Copy-Item -LiteralPath (Join-Path $runtime 'third-party-inventory.json') -Destination $outputRoot
    Copy-Item -LiteralPath (Join-Path $runtime 'THIRD_PARTY_LICENSES.txt') -Destination $outputRoot
    $bunVersion = & bun --version
    if ($LASTEXITCODE -ne 0) { throw 'Unable to record Bun version.' }
    $rustVersion = & rustc --version
    if ($LASTEXITCODE -ne 0) { throw 'Unable to record Rust version.' }
    $record = [ordered]@{
        version = $version; edition = $Edition; asset = $assetName
        bytes = (Get-Item -LiteralPath $asset).Length
        sha256 = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash
        source_commit = $sourceCommit; source_has_uncommitted_changes = $false
        built_at_utc = [DateTime]::UtcNow.ToString('o')
        target = 'x86_64-pc-windows-msvc'
        build_command = "scripts/build-release.ps1 -Edition $Edition"
        bun_version = $bunVersion; rust_version = $rustVersion
        runtime_manifest_sha256 = (Get-FileHash -LiteralPath (Join-Path $outputRoot 'runtime-info.json') -Algorithm SHA256).Hash
        third_party_inventory_sha256 = (Get-FileHash -LiteralPath (Join-Path $outputRoot 'third-party-inventory.json') -Algorithm SHA256).Hash
        python_version = '3.12.14'; clean_windows_verified = $false
        signed = ((Get-AuthenticodeSignature -LiteralPath $asset).Status -eq 'Valid')
        release_status = 'local preparation; public release pending'
    }
    $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot 'build-info.json') -Encoding utf8
    Write-Output "Prepared release: $asset"
} finally {
    [Environment]::SetEnvironmentVariable('CARGO_TARGET_DIR', $previousCargoTarget, 'Process')
    Pop-Location
}
