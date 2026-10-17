param([Parameter(Mandatory=$true)][string]$EventId)
$ErrorActionPreference='Stop'
if ($EventId -cnotmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'INVALID_RECOVERY_ID' }
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (Test-Path 'data\web-session.lock' -PathType Leaf) { throw 'ACTIVE_WEB_SESSION_LOCK_REQUIRES_REVIEW' }
$other=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'web-weixin-session[.]mjs|web-weixin-inbound-once[.]mjs|weixin-session[.]mjs|web-weixin-send-reviewed[.]mjs' }
if ($other) { throw 'COMPETING_WEIXIN_SESSION_REQUIRES_REVIEW' }
if (Test-Path Env:RIVEN_WEIXIN_AUTH_KEY) { throw 'RECOVERY_REQUIRES_DPAPI_AUTH' }
foreach ($file in @('data\weixin-auth.protected','data\weixin-context-key.dpapi','data\web-host.sqlite')) {
 if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'RECOVERY_PREREQUISITE_MISSING' }
}
$cfg=Get-Content -LiteralPath 'data\weixin-runtime.json' -Raw | ConvertFrom-Json
if ($cfg.inboundEnabled -ne $false -or $cfg.outboundEnabled -ne $false) { throw 'PERSISTENT_WEIXIN_FLAGS_MUST_BE_OFF' }
$stored=[IO.File]::ReadAllText((Join-Path $root 'data\weixin-context-key.dpapi')).Trim()
$secure=ConvertTo-SecureString -String $stored
$stored=$null
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:RIVEN_WEIXIN_CONTEXT_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
try {
 if ($env:RIVEN_WEIXIN_CONTEXT_KEY -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'RECOVERY_CONTEXT_KEY_INVALID' }
 & node scripts\recover-stalled-web-session.mjs send $EventId
 $result=$LASTEXITCODE
} finally { Remove-Item Env:RIVEN_WEIXIN_CONTEXT_KEY -ErrorAction SilentlyContinue }
if ($result -ne 0) { Write-Output 'RECOVERY_STOPPED. Do not retry an ambiguous send.';exit 1 }
