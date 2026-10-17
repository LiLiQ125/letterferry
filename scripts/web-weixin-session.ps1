$ErrorActionPreference='Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (Test-Path -LiteralPath 'data\web-session.lock' -PathType Leaf) { throw 'ACTIVE_WEB_SESSION_LOCK_REQUIRES_REVIEW' }
$other=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -match 'web-weixin-inbound-once[.]mjs|web-weixin-send-reviewed[.]mjs|weixin-session[.]mjs') }
if ($other) { throw 'COMPETING_WEIXIN_SESSION_REQUIRES_REVIEW' }
if (Test-Path Env:RIVEN_WEIXIN_AUTH_KEY) { throw 'SESSION_REQUIRES_EXISTING_DPAPI_AUTH' }
$authFile = Join-Path $root 'data\weixin-auth.protected'
$contextFile = Join-Path $root 'data\weixin-context-key.dpapi'
$webKeyFile = Join-Path $root 'data\web-host.key'
foreach ($f in @($authFile,$contextFile,$webKeyFile)) {
 if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw 'WEB_SESSION_CREDENTIAL_PREREQUISITE_MISSING' }
}
try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/health' -TimeoutSec 4 }
catch { throw 'WEB_HOST_OFFLINE' }
if ($h.host -cne 'HOST_READY') { throw 'WEB_HOST_NOT_READY' }
foreach ($k in @('QUEUED','ASSIGNED_UNKNOWN','BROWSER_SUBMITTED','DELIVERY_UNKNOWN')) {
 if ($h.queue.$k) { throw 'WEB_SESSION_UNRESOLVED_HOST_TASK' }
}
$key = [IO.File]::ReadAllText($webKeyFile).Trim()
if ($key -cnotmatch '^[a-f0-9]{64}$') { throw 'WEB_BRIDGE_KEY_INVALID' }
$origin = 'http://127.0.0.1:8799/bridge-' + $key
$key = $null
$secureSaved = ConvertTo-SecureString -String ([IO.File]::ReadAllText($contextFile).Trim())
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSaved)
try { $env:RIVEN_WEIXIN_CONTEXT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
try {
 if ($env:RIVEN_WEIXIN_CONTEXT_KEY -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'WEB_SESSION_CONTEXT_KEY_INVALID' }
 $env:CHATGPT_BRIDGE_ORIGIN = $origin
 $origin = $null
 & node scripts\web-weixin-session.mjs
 $nodeExitCode = $LASTEXITCODE
} finally {
 Remove-Item Env:RIVEN_WEIXIN_CONTEXT_KEY -ErrorAction SilentlyContinue
 Remove-Item Env:CHATGPT_BRIDGE_ORIGIN -ErrorAction SilentlyContinue
}
if ($nodeExitCode -ne 0) { Write-Output 'WEB_SESSION_STOPPED. Review safe error code. Never retry unresolved deliveries.'; exit 1 }
