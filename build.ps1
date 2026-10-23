#Requires -Version 5.1
<#
.SYNOPSIS
    Automated build, test, and release script for Gemini-Bridge.
.DESCRIPTION
    Conforms to project-standards: compiles native Rust binary, places versioned
    artifact in bin/, and archives source tree to archives/.
.PARAMETER Release
    Build optimized release binary.
.PARAMETER Clean
    Remove target/, bin/, and temporary files.
#>
[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$AppName = "gemini-bridge"
$Version = "0.1.0"
$Arch = "windows_amd64"
$Root = $PSScriptRoot

if ($Clean) {
    Write-Host "[*] Cleaning build artifacts..." -ForegroundColor Yellow
    if (Test-Path "$Root\target") { Remove-Item -Recurse -Force "$Root\target" }
    if (Test-Path "$Root\bin") { Get-ChildItem "$Root\bin" -Exclude ".gitkeep" | Remove-Item -Force }
    Write-Host "[+] Clean completed." -ForegroundColor Green
    exit 0
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Building $AppName v$Version ($Arch)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Ensure target directories exist
$BinDir = Join-Path $Root "bin"
$ArchiveDir = Join-Path $Root "archives"
if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }
if (-not (Test-Path $ArchiveDir)) { New-Item -ItemType Directory -Path $ArchiveDir | Out-Null }

# 2. Check Rust toolchain
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Error "cargo was not found in PATH. Please install Rust from https://rustup.rs"
}

# 3. Cargo Check & Test
Write-Host "`n[*] Running tests..." -ForegroundColor Yellow
cargo test --manifest-path "$Root\Cargo.toml"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Cargo tests failed with exit code $LASTEXITCODE"
}

# 4. Compilation
$TargetName = if ($Release) { "release" } else { "debug" }
$CargoArgs = @("build", "--manifest-path", "$Root\Cargo.toml")
if ($Release) {
    $CargoArgs += "--release"
}

Write-Host "`n[*] Compiling ($TargetName)..." -ForegroundColor Yellow
& cargo @CargoArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed with exit code $LASTEXITCODE"
}

$SourceExe = Join-Path $Root "target\$TargetName\$AppName.exe"
if (-not (Test-Path $SourceExe)) {
    Write-Error "Target executable not found at: $SourceExe"
}

# 5. Versioned artifact deployment
$VersionedExeName = "${AppName}_v${Version}_${Arch}.exe"
$VersionedExePath = Join-Path $BinDir $VersionedExeName
$StandardExePath = Join-Path $BinDir "${AppName}.exe"

Copy-Item -Path $SourceExe -Destination $VersionedExePath -Force
Copy-Item -Path $SourceExe -Destination $StandardExePath -Force
Write-Host "[+] Binary deployed to: $VersionedExePath" -ForegroundColor Green
Write-Host "[+] Standard alias at: $StandardExePath" -ForegroundColor Green

# 6. Source Tree Archive (on Release)
if ($Release) {
    $Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $ZipName = "src_${AppName}_v${Version}_${Timestamp}.zip"
    $ZipPath = Join-Path $ArchiveDir $ZipName

    Write-Host "`n[*] Creating source archive: $ZipName..." -ForegroundColor Yellow
    
    # Gather non-ignored source files
    $TempZipDir = Join-Path $Root "target\temp_archive"
    if (Test-Path $TempZipDir) { Remove-Item -Recurse -Force $TempZipDir }
    New-Item -ItemType Directory -Path $TempZipDir | Out-Null

    # Copy tracked directories and root files
    Copy-Item -Path "$Root\Cargo.toml" -Destination $TempZipDir -Force
    Copy-Item -Path "$Root\Cargo.lock" -Destination $TempZipDir -Force -ErrorAction SilentlyContinue
    Copy-Item -Path "$Root\*.md" -Destination $TempZipDir -Force
    Copy-Item -Path "$Root\build.ps1" -Destination $TempZipDir -Force
    Copy-Item -Path "$Root\.gitignore" -Destination $TempZipDir -Force
    Copy-Item -Path "$Root\src" -Destination $TempZipDir -Recurse -Force
    Copy-Item -Path "$Root\extension" -Destination $TempZipDir -Recurse -Force

    Compress-Archive -Path "$TempZipDir\*" -DestinationPath $ZipPath -Force
    Remove-Item -Recurse -Force $TempZipDir
    Write-Host "[+] Source archive created: $ZipPath" -ForegroundColor Green
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Build & Verification Succeeded!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
