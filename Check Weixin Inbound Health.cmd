@echo off
cd /d "%~dp0"
title LetterFerry Weixin Inbound Health
echo LetterFerry Weixin inbound health check
echo Read-only getUpdates check: no cursor commit, no Weixin reply.
echo.
node scripts\check-weixin-inbound-health.mjs
echo.
pause
