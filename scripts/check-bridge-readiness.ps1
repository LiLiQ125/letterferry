$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$auth = Test-Path -LiteralPath (Join-Path $root 'data\weixin-auth.protected') -PathType Leaf
$binding = Test-Path -LiteralPath (Join-Path $root 'data\weixin-runtime.json') -PathType Leaf
$mcpPort = [bool](Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8797 -State Listen -ErrorAction SilentlyContinue)
$browser = [bool](Get-Process msedge -ErrorAction SilentlyContinue)
$webHost = 'OFFLINE'
$webQueueBlocked = $false
$webSmokeVerified = $false
try {
  $webHealth = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:8799/health' -TimeoutSec 2
  if ($webHealth.ok) {
    $webHost = [string]$webHealth.host
    $webQueueBlocked = [bool]($webHealth.queue.DELIVERY_UNKNOWN -or $webHealth.queue.ASSIGNED_UNKNOWN -or $webHealth.queue.BROWSER_SUBMITTED)
  }
} catch {}
try { $webSmokeVerified = ((& node (Join-Path $root 'scripts\verify-web-smoke-history.mjs')) -ceq 'VERIFIED') } catch {}
$state = if (-not $auth -or -not $binding) { 'SETUP_INCOMPLETE' } elseif ($webQueueBlocked) { 'NEEDS_MANUAL_REVIEW' } elseif ($webHost -eq 'HOST_READY' -and $webSmokeVerified) { 'WEB_BRIDGE_VERIFIED_WEIXIN_GATE_PENDING' } elseif ($webHost -eq 'HOST_READY') { 'WEB_EDITOR_CONNECTED_NOT_DELIVERY_VERIFIED' } elseif ($mcpPort) { 'MCP_BRIDGE_WAITING_FOR_HOST' } else { 'BRIDGE_OFFLINE' }
[pscustomobject]@{
  State = $state
  WeixinCredentialsPresent = $auth
  WeixinBindingPresent = $binding
  McpBridgePortListening = $mcpPort
  EdgeRunning = $browser
  WebHost = $webHost
  WebQueueBlocked = $webQueueBlocked
  ChatGPTRealReplyVerified = $webSmokeVerified
  CanClaimReadyToChat = $false
} | ConvertTo-Json -Compress
