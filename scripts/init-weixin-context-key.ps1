$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$path=Join-Path $root 'data\weixin-context-key.dpapi'
if(Test-Path -LiteralPath $path){throw 'CONTEXT_KEY_ALREADY_EXISTS'}
[IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
$bytes=New-Object byte[] 32
$rng=$null
try {
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $hex=-join ($bytes | ForEach-Object { $_.ToString('x2') })
  if($hex -cnotmatch '^[a-f0-9]{64}$'){throw 'CONTEXT_KEY_GENERATION_FAILED'}
  $secure=ConvertTo-SecureString -String $hex -AsPlainText -Force
  $protected=ConvertFrom-SecureString -SecureString $secure
  $utf8=New-Object Text.UTF8Encoding($false)
  $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
    $writer=New-Object IO.StreamWriter($stream,$utf8)
    try {$writer.Write($protected)} finally {$writer.Dispose()}
  } finally {
    if($stream){$stream.Dispose()}
  }
  'CONTEXT_KEY_DPAPI_CREATED'
} finally {
  if($rng){$rng.Dispose()}
  if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
  $hex=$null
  $secure=$null
  $protected=$null
}
