param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$TargetDirectory,
    [ValidateSet('preview', 'install', 'uninstall', 'reject', 'busy')][string]$Mode = 'preview',
    [string]$Screenshots,
    [string]$RejectedDirectory,
    [switch]$NoDesktopShortcut,
    [switch]$UseDefaultDirectory,
    [string]$ExpectedDirectory
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Mode -ne 'uninstall') {
    & (Join-Path $PSScriptRoot 'installer-wpf-ui.ps1') @PSBoundParameters
    exit 0
}
$target = [IO.Path]::GetFullPath($TargetDirectory)
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $target.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or $target.Substring($temporaryRoot.Length) -notmatch '^harness-installer-test-[^\\]+\\') { throw 'Installer verification requires an isolated harness-installer-test directory in TEMP.' }
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'installer-window.cs') -ReferencedAssemblies System.Drawing
[void][InstallerWindow]::SetProcessDPIAware()
if ($Screenshots) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($Screenshots)) }
$argumentsList = if ($Mode -eq 'uninstall') { @('/currentuser') } else { @('/currentuser', "/D=$target") }
$process = Start-Process -FilePath $executablePath -ArgumentList $argumentsList -WindowStyle Hidden -PassThru
$ownedIds = [Collections.Generic.HashSet[int]]::new()
[void]$ownedIds.Add($process.Id)

function Get-OwnedWindows {
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name LIKE '%exe'" | Where-Object { $_.ParentProcessId -eq $process.Id -or ($_.CommandLine -and $_.CommandLine.Contains("_?=$target")) })) { [void]$ownedIds.Add([int]$candidate.ProcessId) }
    [InstallerWindow]::Windows([int[]]@($ownedIds))
}
function Wait-For($Action, [string]$Description, [int]$Timeout = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Timeout)
    do {
        $value = & $Action
        if ($value) { return $value }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out: $Description"
}
function Text-Of([IntPtr]$Window) { (([InstallerWindow]::Children($Window) | Where-Object { $_.Visible } | ForEach-Object { $_.Text }) -join "`n") }
function Click-Id([IntPtr]$Window, [int]$Identifier) {
    $button = Wait-For { $candidate = [InstallerWindow]::GetDlgItem($Window, $Identifier); if ($candidate -ne [IntPtr]::Zero -and [InstallerWindow]::IsWindowEnabled($candidate)) { $candidate } } "enabled installer button $Identifier" 15
    [void][InstallerWindow]::PostMessage($button, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
}
function Capture([IntPtr]$Window, [string]$Name) {
    if ($Screenshots) { Start-Sleep -Milliseconds 300; [InstallerWindow]::Capture($Window, (Join-Path ([IO.Path]::GetFullPath($Screenshots)) "installer-$Name.png")) }
    if ($env:HARNESS_INSTALLER_DEBUG) { [InstallerWindow]::Children($Window) | Select-Object Id,Visible,Left,Top,Width,Height,Text | Format-Table -AutoSize | Out-String | Write-Output }
}
try {
    $window = Wait-For { Get-OwnedWindows | Where-Object { $_.ClassName -eq '#32770' -and $_.Width -gt 400 } | Sort-Object Width -Descending | Select-Object -First 1 } 'installer window'
    [void][InstallerWindow]::ShowWindow($window.Handle, 4)
    if (([InstallerWindow]::WindowStyle($window.Handle, -16) -band 0xC40000) -ne 0) { throw 'Installer must not have a native caption or resize border.' }
    [void](Wait-For { if ((Text-Of $window.Handle) -match '保留作品') { $true } } 'themed uninstall page')
    Capture $window.Handle 'uninstall'
    Click-Id $window.Handle 1
    [void](Wait-For {
        $text = Text-Of $window.Handle
        if ($text -match '程序已卸载|已从你的计算机解除安装') { return $true }
        $next = [InstallerWindow]::GetDlgItem($window.Handle, 1)
        if ($text -match '已完成|卸载完成' -and [InstallerWindow]::IsWindowEnabled($next)) { Click-Id $window.Handle 1 }
    } 'uninstall completion' 120)
    Capture $window.Handle 'uninstalled'
    Click-Id $window.Handle 1
    [void](Wait-For { if (-not @(Get-OwnedWindows | Where-Object { $_.Visible -and $_.ClassName -eq '#32770' }).Count) { $true } } 'installer close' 30)
    if (-not $process.HasExited) { [void]$process.WaitForExit(15000) }
    if ($Mode -eq 'uninstall' -and (Test-Path -LiteralPath (Join-Path $target 'resources\app.asar'))) { throw 'Uninstall did not remove the app payload.' }
    Write-Output "Installer GUI verification passed: $Mode"
} catch {
    Write-Output $_.ScriptStackTrace
    foreach ($owned in @(Get-OwnedWindows | Where-Object { $_.Visible })) {
        Write-Output ("Owned window: " + $owned.Handle + ' / ' + $owned.Text)
        [InstallerWindow]::Children($owned.Handle) | Where-Object { $_.Visible } | Select-Object Id,ClassName,Enabled,Text | Format-Table -AutoSize | Out-String | Write-Output
    }
    if ($window) { Capture $window.Handle 'failure' }
    throw
} finally {
    foreach ($identifier in $ownedIds) { $remaining = Get-Process -Id $identifier -ErrorAction SilentlyContinue; if ($remaining) { Stop-Process -Id $identifier -Force -ErrorAction SilentlyContinue } }
}
