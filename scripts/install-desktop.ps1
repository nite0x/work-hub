param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\WorktreeHub'))
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
# Keep the existing install and data directories so upgrades reuse saved settings.
$targetExe = Join-Path $InstallDir 'WorkHub.exe'
$installedExe = $targetExe
if (-not (Test-Path -LiteralPath $installedExe)) {
    $installedExe = Join-Path $InstallDir 'WorktreeHub.exe'
}
$dataDirectory = Join-Path $env:LOCALAPPDATA 'WorktreeHub'
if (Test-Path -LiteralPath $installedExe) {
    if (Test-Path -LiteralPath (Join-Path $dataDirectory 'service.json')) {
        $stopProcess = Start-Process -FilePath $installedExe -ArgumentList '--stop' -WindowStyle Hidden -Wait -PassThru
        if ($stopProcess.ExitCode -ne 0) { throw '后台尚未退出。请完成正在执行的 Git 操作，然后重试安装。' }
    }
}
New-Item -ItemType Directory -Path (Join-Path $InstallDir 'agents') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'WorkHub.exe') -Destination $targetExe -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'agents\worktree-hub-linux-amd64') -Destination (Join-Path $InstallDir 'agents\worktree-hub-linux-amd64') -Force
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $programs 'Work Hub.lnk'))
$shortcut.TargetPath = $targetExe
$shortcut.WorkingDirectory = $InstallDir
$shortcut.IconLocation = "$targetExe,0"
$shortcut.Save()
$legacyShortcut = Join-Path $programs 'Worktree Hub.lnk'
if (Test-Path -LiteralPath $legacyShortcut) {
    Remove-Item -LiteralPath $legacyShortcut -Force
}
Write-Host "已安装到 $InstallDir。可从开始菜单打开 Work Hub。"
Write-Host 'Windows 本机项目不需要 WSL。桌面窗口需要 Microsoft Edge WebView2 Runtime。'
