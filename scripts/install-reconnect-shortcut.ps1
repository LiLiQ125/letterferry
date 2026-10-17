$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$desktop=[Environment]::GetFolderPath('Desktop')
if([string]::IsNullOrWhiteSpace($desktop)){throw 'DESKTOP_FOLDER_NOT_FOUND'}
if(-not(Test-Path -LiteralPath $desktop -PathType Container)){throw 'DESKTOP_FOLDER_MISSING'}
$runner=Join-Path $root 'scripts\reconnect-desktop.ps1'
if(-not(Test-Path -LiteralPath $runner -PathType Leaf)){throw 'RECONNECT_SCRIPT_MISSING'}
$name=([string][char]0x4E00)+([char]0x952E)+([char]0x91CD)+([char]0x8FDE)+' Riven.lnk'
$target=Join-Path $desktop $name
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($target)
$shortcut.TargetPath=(Get-Command powershell.exe -ErrorAction Stop).Source
$shortcut.Arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$runner+'"'
$shortcut.WorkingDirectory=$root
$shortcut.Description='Safe reconnect: checks live status and resumes only missing services, never replays uncertain messages'
$shortcut.IconLocation=Join-Path $env:SystemRoot 'System32\shell32.dll'
$shortcut.Save()
$verified=$shell.CreateShortcut($target)
if(-not(Test-Path -LiteralPath $target -PathType Leaf) -or $verified.Arguments -notlike '*reconnect-desktop.ps1*' -or $verified.WorkingDirectory -ne $root){
 throw 'RECONNECT_SHORTCUT_VALIDATION_FAILED'
}
'RECONNECT_DESKTOP_SHORTCUT_CREATED=TRUE'
'RECONNECT_SHORTCUT_FILENAME='+$name
'RECONNECT_TARGET_VALIDATED=TRUE'
