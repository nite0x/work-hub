param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$originalAppData = $env:LOCALAPPDATA
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('work-hub-install-' + [guid]::NewGuid())
$directory = Join-Path $temporary 'Install with spaces'
$env:LOCALAPPDATA = Join-Path $temporary 'appdata'
$data = Join-Path $env:LOCALAPPDATA 'WorktreeHub'
$backend = Join-Path $directory 'work-hub-backend.exe'
function Install-WorkHub {
    $p = Start-Process -FilePath $Installer -ArgumentList "/S /D=$directory" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "NSIS installation failed: $($p.ExitCode)" }
}
try {
    Install-WorkHub
    foreach ($file in @('work-hub.exe', 'work-hub-backend.exe', 'agents\worktree-hub-linux-amd64', 'notices\THIRD-PARTY-NOTICES.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $directory $file))) { throw "Missing installed file: $file" }
    }
    $info = (& $backend --desktop-start --root (Join-Path $temporary 'workspaces') | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Installed backend did not start' }
    $descriptor = Get-Content -LiteralPath (Join-Path $data 'service.json') -Raw | ConvertFrom-Json
    $headers = @{ 'X-CSRF-Token' = $descriptor.token }
    Invoke-RestMethod -Uri ($info.url + '/api/settings/master-sync') -Method Put -Headers $headers -ContentType 'application/json' -Body '{"enabled":false,"time":"09:25"}' | Out-Null
    Install-WorkHub # preinstall must stop the detached default backend.
    if (Test-Path -LiteralPath (Join-Path $data 'service.json')) { throw 'Installer left the old backend running' }
    $info = (& $backend --desktop-start | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Upgraded backend did not start' }
    $descriptor = Get-Content -LiteralPath (Join-Path $data 'service.json') -Raw | ConvertFrom-Json
    $state = Invoke-RestMethod -Uri ($info.url + '/api/state') -Headers @{ 'X-CSRF-Token' = $descriptor.token }
    if ($state.master_sync.settings.time -ne '09:25') { throw 'Upgrade lost saved settings' }
    $uninstaller = Join-Path $temporary 'uninstall-test.exe'
    Copy-Item -LiteralPath (Join-Path $directory 'uninstall.exe') -Destination $uninstaller
    $p = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$directory" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw 'Uninstallation failed' }
    if (-not (Test-Path -LiteralPath (Join-Path $data 'worktree-hub.db'))) { throw 'Uninstaller removed user data' }
    if (Test-Path -LiteralPath (Join-Path $data 'service.json')) { throw 'Uninstaller left the backend running' }
    Write-Host 'Windows install, running-backend upgrade, saved settings and uninstall retention passed.'
} finally {
    if (Test-Path -LiteralPath $backend) { & $backend --prepare-upgrade | Out-Null }
    $env:LOCALAPPDATA = $originalAppData
}
