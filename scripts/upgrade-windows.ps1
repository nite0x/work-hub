param(
    [string]$InstallDir,
    [string]$BackupRoot = (Join-Path $env:LOCALAPPDATA 'WorktreeHubBackups'),
    [switch]$Launch
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDirectory = Join-Path $env:LOCALAPPDATA 'WorktreeHub'

# Run from the extracted release directory, alongside the installer, helper and
# SHA256SUMS. Refuse incomplete or damaged packages before stopping anything.
$checksums = Join-Path $packageRoot 'SHA256SUMS'
if (-not (Test-Path -LiteralPath $checksums)) { throw 'Missing SHA256SUMS. Extract the complete release package first.' }
foreach ($line in Get-Content -LiteralPath $checksums) {
    if ($line -notmatch '^([a-fA-F0-9]{64})  ([^\\/]+)$') { throw "Invalid checksum entry: $line" }
    $expected = $Matches[1]
    $name = $Matches[2]
    $actual = (Get-FileHash -LiteralPath (Join-Path $packageRoot $name) -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw "Checksum mismatch: $name" }
}
$installers = @(Get-ChildItem -LiteralPath $packageRoot -Filter '*-setup.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows installer.' }
$helper = Join-Path $packageRoot 'work-hub-upgrade.exe'
if (-not (Test-Path -LiteralPath $helper)) { throw 'Missing work-hub-upgrade.exe.' }

if (-not $InstallDir) {
    $installed = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Work Hub' })
    if ($installed.Count -eq 1 -and $installed[0].PSObject.Properties['InstallLocation']) {
        $InstallDir = $installed[0].InstallLocation.Trim('"')
    }
    if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Work Hub' }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$BackupRoot = [IO.Path]::GetFullPath($BackupRoot)
function Test-NestedPath([string]$Candidate, [string]$Parent) {
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    return $Candidate.Equals($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        $Candidate.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)
}
if ((Test-NestedPath $BackupRoot $dataDirectory) -or (Test-NestedPath $BackupRoot $InstallDir) -or
    (Test-NestedPath $InstallDir $dataDirectory) -or (Test-NestedPath $dataDirectory $InstallDir) -or
    (Test-NestedPath $InstallDir $packageRoot) -or (Test-NestedPath $packageRoot $InstallDir)) {
    throw 'Install, package, data and backup directories must not overlap.'
}

# Closing the desktop window leaves the backend running. Only the authenticated
# helper may stop it; a busy operation aborts this upgrade without killing it.
foreach ($app in @(Get-Process -Name 'work-hub' -ErrorAction SilentlyContinue)) {
    if ($app.Path -and (Test-NestedPath $app.Path $InstallDir)) {
        if (-not $app.CloseMainWindow() -or -not $app.WaitForExit(15000)) {
            throw 'Close the Work Hub desktop window, then retry this script.'
        }
    }
}
$stop = Start-Process -FilePath $helper -ArgumentList '--prepare-upgrade' -WindowStyle Hidden -Wait -PassThru
if ($stop.ExitCode -ne 0) { throw 'Backend could not stop safely. Finish active Git operations, then retry.' }

$backup = Join-Path $BackupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $backup | Out-Null
if (Test-Path -LiteralPath $dataDirectory) {
    Copy-Item -LiteralPath $dataDirectory -Destination (Join-Path $backup 'data') -Recurse -Force
    foreach ($file in Get-ChildItem -LiteralPath $dataDirectory -Recurse -File -Filter '*.db*') {
        $relative = $file.FullName.Substring($dataDirectory.Length).TrimStart('\')
        $copy = Join-Path (Join-Path $backup 'data') $relative
        if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) {
            throw "Database backup verification failed: $relative"
        }
    }
}
if (Test-Path -LiteralPath $InstallDir) {
    Copy-Item -LiteralPath $InstallDir -Destination (Join-Path $backup 'application') -Recurse -Force
}
@{ installed_at = (Get-Date -Format o); data_directory = $dataDirectory; install_directory = $InstallDir } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'upgrade.json') -Encoding UTF8
Write-Host "Backup: $backup"

$process = Start-Process -FilePath $installers[0].FullName -ArgumentList "/S /D=$InstallDir" -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installation failed ($($process.ExitCode)). Backup: $backup" }
$backend = Join-Path $InstallDir 'work-hub-backend.exe'
if ((Get-FileHash -LiteralPath $backend).Hash -ne (Get-FileHash -LiteralPath $helper).Hash) {
    throw "Installed backend does not match this release. Backup: $backup"
}
Write-Host "Installed: $InstallDir"
Write-Host "Existing data retained: $dataDirectory"
Write-Host 'Project repositories, worktrees and Codex history remain in their original locations.'
if ($Launch) { Start-Process -FilePath (Join-Path $InstallDir 'work-hub.exe') -WindowStyle Hidden }
