param([ValidateSet(30,60)][int]$Minutes = 60, [ValidateSet('mcp','web')][string]$BridgeMode = 'mcp')
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
if (Test-Path -LiteralPath 'data\web-session.lock' -PathType Leaf) { throw 'ACTIVE_WEB_SESSION_LOCK_REQUIRES_REVIEW' }
$authFile = Join-Path $project 'data\weixin-auth.protected'
$contextFile = Join-Path $project 'data\weixin-context-key.dpapi'
$bridgeKeyFile = if ($BridgeMode -eq 'web') { Join-Path $project 'data\web-host.key' } else { $env:RIVEN_FIXED_LISTENER_KEY_FILE }
$bridgePort = if ($BridgeMode -eq 'web') { 8799 } else { 8797 }

if ($BridgeMode -eq 'web') {
  try { $hostHealth = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:8799/health' -TimeoutSec 3 }
  catch { throw 'WEB_HOST_NOT_RUNNING' }
  if ($hostHealth.host -cne 'HOST_READY') { throw 'WEB_CHATGPT_TAB_NOT_READY' }
  if ($hostHealth.queue.DELIVERY_UNKNOWN -or $hostHealth.queue.ASSIGNED_UNKNOWN -or $hostHealth.queue.BROWSER_SUBMITTED) { throw 'WEB_DELIVERY_NEEDS_REVIEW' }
}

if (-not (Test-Path -LiteralPath $authFile -PathType Leaf)) { throw 'AUTH_NOT_PRESENT' }
if (-not (Test-Path -LiteralPath $contextFile -PathType Leaf)) { throw 'CONTEXT_KEY_NOT_PRESENT' }
if (-not (Test-Path -LiteralPath $bridgeKeyFile -PathType Leaf)) { throw 'BRIDGE_PRIVATE_KEY_NOT_PRESENT' }
if (Test-Path Env:RIVEN_WEIXIN_AUTH_KEY) { throw 'SESSION_REQUIRES_DPAPI_AUTH' }

$bridgeKey = [IO.File]::ReadAllText($bridgeKeyFile).Trim()
if ($bridgeKey -cnotmatch '^[a-f0-9]{64}$') { throw 'BRIDGE_PRIVATE_KEY_INVALID' }
$origin = 'http://127.0.0.1:' + $bridgePort + '/bridge-' + $bridgeKey
$bridgeKey = $null

# Node resolves the existing auth file with Windows DPAPI CurrentUser. This wrapper
# only unprotects the existing context key into this child process environment.
$secureSaved = ConvertTo-SecureString -String ([IO.File]::ReadAllText($contextFile).Trim())
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSaved)
try { $env:RIVEN_WEIXIN_CONTEXT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if ($env:RIVEN_WEIXIN_CONTEXT_KEY -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'CONTEXT_KEY_INVALID' }

$env:CHATGPT_BRIDGE_ORIGIN = $origin
$env:RIVEN_WEIXIN_SESSION_MINUTES = [string]$Minutes
$origin = $null
try {
  & node scripts\weixin-session.mjs
  if ($LASTEXITCODE -ne 0) { throw 'WEIXIN_SESSION_EXITED_WITH_ERROR' }
} finally {
  Remove-Item Env:RIVEN_WEIXIN_CONTEXT_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:CHATGPT_BRIDGE_ORIGIN -ErrorAction SilentlyContinue
  Remove-Item Env:RIVEN_WEIXIN_SESSION_MINUTES -ErrorAction SilentlyContinue
}
