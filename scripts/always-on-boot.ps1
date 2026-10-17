$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$node=(Get-Command 'node.exe' -ErrorAction Stop).Source
$lock=Join-Path $root 'data\web-session.lock'
# Only remove an abandoned file lock if the original owner is no longer
# running AND both databases have no potentially in-flight jobs.
if(Test-Path -LiteralPath $lock -PathType Leaf){
 $record=Get-Content -LiteralPath $lock -Raw|ConvertFrom-Json
 $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$record.pid) -ErrorAction SilentlyContinue
 if($owner -and $owner.CommandLine -match 'web-weixin-session[.]mjs|always-on-daemon[.]mjs|weixin-session[.]mjs') { exit 0 }
 & $node scripts/check-idle-databases.mjs
 if($LASTEXITCODE -ne 0) { throw 'ALWAYS_ON_STALE_LOCK_NEEDS_HUMAN_REVIEW' }
 Remove-Item -LiteralPath $lock -Force
}
$existing=Get-CimInstance Win32_Process | Where-Object {
 $_.Name -eq 'node.exe' -and $_.CommandLine -match 'always-on-daemon[.]mjs'
}
if($existing){exit 0}
$conf=Get-Content -LiteralPath 'data\always-on.json' -Raw|ConvertFrom-Json
if($conf.enabled -ne $true -or $conf.scope -cne 'ONE_PAIRED_PRIVATE_CHATGPT_TAB'){exit 0}
$authFile=Join-Path $root 'data\weixin-auth.protected'
$contextFile=Join-Path $root 'data\weixin-context-key.dpapi'
$keyFile=Join-Path $root 'data\web-host.key'
foreach($file in @($authFile,$contextFile,$keyFile)){
 if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'ALWAYS_ON_CREDENTIAL_FILE_MISSING'}
}
$key=[IO.File]::ReadAllText($keyFile).Trim()
if($key -cnotmatch '^[a-f0-9]{64}$'){throw 'ALWAYS_ON_WEB_HOST_KEY_INVALID'}
$origin='http://127.0.0.1:8799/bridge-'+$key
$key=$null
$secureSaved=ConvertTo-SecureString -String ([IO.File]::ReadAllText($contextFile).Trim())
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSaved)
try{$env:RIVEN_WEIXIN_CONTEXT_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
if($env:RIVEN_WEIXIN_CONTEXT_KEY -cnotmatch '^[a-fA-F0-9]{64}$'){throw 'ALWAYS_ON_DPAPI_CONTEXT_INVALID'}
$env:CHATGPT_BRIDGE_ORIGIN=$origin
$origin=$null
try{
 try{$h=Invoke-RestMethod -Uri 'http://127.0.0.1:8799/health' -TimeoutSec 3}catch{$h=$null}
 if(-not $h){
  $hostProc=Start-Process -FilePath $node -ArgumentList 'scripts/start-web-host.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  $h=Invoke-RestMethod -Uri 'http://127.0.0.1:8799/health' -TimeoutSec 3
 }
 if($h.ok -ne $true){throw 'ALWAYS_ON_HOST_FAILED'}
 # Edge is a user-profile browser: service can auto-start only after sign-in.
 $edge=Get-CimInstance Win32_Process | Where-Object{$_.Name -eq 'msedge.exe'}
 if(-not $edge){
   $edgePath='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
   if(-not(Test-Path -LiteralPath $edgePath)){
    $edgePath='C:\Program Files\Microsoft\Edge\Application\msedge.exe'
   }
   if(Test-Path -LiteralPath $edgePath){
    Start-Process -FilePath $edgePath -ArgumentList @('--no-first-run',$conf.chatUrl) | Out-Null
   }
 }
 $log=Join-Path $root 'data\always-on-status.log'
 if((Test-Path $log) -and (Get-Item $log).Length -gt 1048576){Move-Item -LiteralPath $log -Destination ($log+'.previous') -Force}
 & $node scripts/always-on-daemon.mjs *>> $log
} finally {
 Remove-Item Env:RIVEN_WEIXIN_CONTEXT_KEY -ErrorAction SilentlyContinue
 Remove-Item Env:CHATGPT_BRIDGE_ORIGIN -ErrorAction SilentlyContinue
}
