@echo off
cd /d "%~dp0"
title LetterFerry Weixin Inbound Health
echo LetterFerry Weixin inbound health check
echo Diagnostic getUpdates check: no LOCAL persisted cursor commit, no Weixin reply. Server replay/consumption semantics are unknown.
echo.
node scripts\check-weixin-inbound-health.mjs
echo.
pause
