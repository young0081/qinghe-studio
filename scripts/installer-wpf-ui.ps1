param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$TargetDirectory,
    [ValidateSet('preview', 'install', 'reject', 'busy')][string]$Mode = 'preview',
    [string]$Screenshots,
    [string]$RejectedDirectory,
    [switch]$NoDesktopShortcut,
    [switch]$UseDefaultDirectory,
    [string]$ExpectedDirectory
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$target = [IO.Path]::GetFullPath($TargetDirectory)
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $target.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or $target.Substring($temporaryRoot.Length) -notmatch '^harness-installer-test-[^\\]+\\') { throw 'Installer verification requires an isolated harness-installer-test directory in TEMP.' }
Add-Type -AssemblyName System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type -Path (Join-Path $PSScriptRoot 'installer-window.cs') -ReferencedAssemblies System.Drawing
[void][InstallerWindow]::SetProcessDPIAware()
if ($Screenshots) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($Screenshots)) }
if ($UseDefaultDirectory -and ($Mode -ne 'preview' -or -not $ExpectedDirectory)) { throw 'Default directory inspection requires preview mode and an expected path.' }
$launchArguments = if ($UseDefaultDirectory) { @('/currentuser') } else { @('--directory', ('"' + $target + '"')) }
$process = Start-Process -FilePath (Resolve-Path -LiteralPath $Executable).Path -ArgumentList $launchArguments -WindowStyle Hidden -PassThru
$window = $null
$automation = $null

function Wait-For($Action, [string]$Description, [int]$Timeout = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Timeout)
    do {
        $value = & $Action
        if ($value) { return $value }
        if ($process.HasExited) { throw "Installer exited $($process.ExitCode) while waiting for $Description" }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out: $Description"
}
function Element([string]$Identifier) {
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Identifier)
    $found = $automation.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($found -and -not $found.Current.IsOffscreen) { return $found }
}
function Invoke-Control([string]$Identifier) {
    $control = Wait-For { $found = Element $Identifier; if ($found -and $found.Current.IsEnabled) { $found } } "enabled $Identifier" 15
    ([System.Windows.Automation.InvokePattern]$control.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
}
function Set-Value([string]$Identifier, [string]$Value) {
    $control = Wait-For { Element $Identifier } $Identifier
    ([System.Windows.Automation.ValuePattern]$control.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($Value)
}
function Capture([string]$Name) {
    if ($Screenshots) { Start-Sleep -Milliseconds 500; [InstallerWindow]::Capture($window.Handle, (Join-Path ([IO.Path]::GetFullPath($Screenshots)) "installer-$Name.png")) }
}

try {
    $window = Wait-For { [InstallerWindow]::Windows(@($process.Id)) | Where-Object { $_.ClassName -like 'HwndWrapper*' -and $_.Width -gt 400 } | Select-Object -First 1 } 'self-drawn WPF window'
    [void][InstallerWindow]::ShowWindow($window.Handle, 4)
    $automation = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)
    if (([InstallerWindow]::WindowStyle($window.Handle, -16) -band 0xC40000) -ne 0) { throw 'Installer must not have a native caption or resize border.' }
    Capture 'welcome'
    Invoke-Control 'PrimaryAction'
    $pathControl = Wait-For { Element 'InstallPath' } 'installation settings'
    $pathValue = ([System.Windows.Automation.ValuePattern]$pathControl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value
    $expectedPath = if ($UseDefaultDirectory) { $ExpectedDirectory } else { $target }
    if ($pathValue -ne $expectedPath) { throw "Unexpected target: $pathValue; expected $expectedPath" }
    Write-Output "Verified install path: $pathValue"
    $shortcut = [System.Windows.Automation.TogglePattern](Element 'DesktopShortcut').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $expectedToggle = if ($NoDesktopShortcut) { [System.Windows.Automation.ToggleState]::Off } else { [System.Windows.Automation.ToggleState]::On }
    if ($shortcut.Current.ToggleState -ne $expectedToggle) { $shortcut.Toggle() }
    Capture 'options'
    if ($Mode -eq 'preview') {
        Invoke-Control 'Back'
        [void](Wait-For { $button = Element 'PrimaryAction'; if ($button.Current.Name -match '开始设置') { $true } } 'back navigation')
        Invoke-Control 'Close'
    } elseif ($Mode -eq 'reject') {
        if (-not $RejectedDirectory) { throw 'Missing RejectedDirectory' }
        Set-Value 'InstallPath' $RejectedDirectory
        Invoke-Control 'PrimaryAction'
        $errorControl = Wait-For { Element 'ErrorText' } 'inline path validation' 15
        if ($errorControl.Current.Name -notmatch '已有其他文件|符号链接|根目录|本地磁盘|安装路径') { throw "Unexpected validation: $($errorControl.Current.Name)" }
        if (-not (Element 'InstallPath')) { throw 'Invalid directory must remain editable.' }
        Capture 'validation'
        Invoke-Control 'Close'
    } else {
        Invoke-Control 'PrimaryAction'
        [void](Wait-For { Element 'ProgressStatus' } 'real installer task')
        if ((Element 'Close').Current.IsEnabled) { throw 'Close must be disabled while installing.' }
        [void][InstallerWindow]::PostMessage($window.Handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 300
        if ($process.HasExited) { throw 'Closing must not kill an active installation.' }
        Capture 'progress'
        if ($Mode -eq 'busy') {
            $failure = Wait-For { Element 'ErrorText' } 'running application rejection' 45
            if ($failure.Current.Name -notmatch '关闭.*青禾 Studio') { throw "Unexpected busy error: $($failure.Current.Name)" }
            Invoke-Control 'Close'
        } else {
            [void](Wait-For {
                $failure = Element 'ErrorText'
                if ($failure) { throw $failure.Current.Name }
                $button = Element 'PrimaryAction'
                if ($button -and $button.Current.Name -match '^完成') { $true }
            } 'automatic transition to completion' 180)
            if (-not (Element 'InstalledPath').Current.Name.Contains($target)) { throw 'Wrong installed location.' }
            $launch = [System.Windows.Automation.TogglePattern](Element 'LaunchAfter').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            if ($launch.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { throw 'Application must not launch by default.' }
            Capture 'finished'
            Invoke-Control 'PrimaryAction'
        }
    }
    if (-not $process.WaitForExit(15000)) { throw 'Installer failed to close.' }
    $expectedCode = if ($Mode -eq 'busy') { 3 } else { 0 }
    if ($process.ExitCode -ne $expectedCode) { throw "Installer exited $($process.ExitCode), expected $expectedCode" }
    Write-Output "Self-drawn installer verification passed: $Mode"
} catch {
    Write-Output $_.ScriptStackTrace
    if ($automation) {
        $automation.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { if (-not $_.Current.IsOffscreen) { "$($_.Current.AutomationId) / $($_.Current.Name)" } } | Write-Output
    }
    if ($window -and -not $process.HasExited) { Capture 'failure' }
    throw
} finally {
    if ($window -and -not $process.HasExited) {
        [void][InstallerWindow]::PostMessage($window.Handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
        if (-not $process.WaitForExit(5000)) { Write-Warning "Test installer $($process.Id) retained; never kill an active install engine." }
    }
}
