param([ValidateSet('receive','send','receive-natural')][string]$Stage = 'receive')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (Test-Path -LiteralPath 'data\web-session.lock' -PathType Leaf) { throw 'ACTIVE_WEB_SESSION_LOCK_REQUIRES_REVIEW' }
if (Test-Path Env:RIVEN_WEIXIN_AUTH_KEY) { throw 'ONE_SHOT_REQUIRES_EXISTING_DPAPI_AUTH' }
$authFile = Join-Path $root 'data\weixin-auth.protected'
$contextFile = Join-Path $root 'data\weixin-context-key.dpapi'
$webKeyFile = Join-Path $root 'data\web-host.key'
foreach ($file in @($authFile,$contextFile,$webKeyFile)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'ONE_SHOT_PREREQUISITE_MISSING' }
}
if ($Stage -ne 'send') {
  try { $health = Invoke-RestMethod 'http://127.0.0.1:8799/health' -TimeoutSec 4 }
  catch { throw 'WEB_HOST_OFFLINE' }
  if ($health.ok -ne $true -or $health.host -cne 'HOST_READY') { throw 'WEB_HOST_NOT_READY' }
  foreach ($key in @('DELIVERY_UNKNOWN','ASSIGNED_UNKNOWN','BROWSER_SUBMITTED','QUEUED')) {
    if ($health.queue.$key) { throw 'WEB_HOST_HAS_UNRESOLVED_TASK' }
  }
}
$bridgeKey = [IO.File]::ReadAllText($webKeyFile).Trim()
if ($bridgeKey -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'WEB_KEY_INVALID' }
$origin = 'http://127.0.0.1:8799/bridge-' + $bridgeKey.ToLowerInvariant()
$bridgeKey = $null
# Read the existing protected key under the logged-in Windows user; never rekey.
$stored = [IO.File]::ReadAllText($contextFile).Trim()
$secure = ConvertTo-SecureString -String $stored
$stored = $null
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:RIVEN_WEIXIN_CONTEXT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$nodeExitCode = 0
try {
  if ($env:RIVEN_WEIXIN_CONTEXT_KEY -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'CONTEXT_KEY_INVALID' }
  $env:CHATGPT_BRIDGE_ORIGIN = $origin
  $origin = $null
  if ($Stage -eq 'receive') {
    & node scripts\web-weixin-inbound-once.mjs
  } elseif ($Stage -eq 'receive-natural') {
    & node scripts\web-weixin-inbound-once.mjs --natural
  } else {
    & node scripts\web-weixin-send-reviewed.mjs
  }
  $nodeExitCode = $LASTEXITCODE
} finally {
  Remove-Item Env:RIVEN_WEIXIN_CONTEXT_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:CHATGPT_BRIDGE_ORIGIN -ErrorAction SilentlyContinue
}
if ($nodeExitCode -ne 0) {
  Write-Output 'ONE_SHOT_STOPPED. Inspect the safe error code above. No automatic retry.'
  exit 1
}
