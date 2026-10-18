@echo off
setlocal
cd /d "%~dp0"
echo Riven Weixin one-shot: inbound then ChatGPT, NO Weixin reply
echo Foreground only. Confirm the test at the prompts. Clean server-empty reads may re-arm only inside one bounded receive window; no outbound auto-retry.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\web-weixin-one-shot.ps1" -Stage receive
if errorlevel 1 echo Test stopped or requires manual review. Do not retry automatically.
pause