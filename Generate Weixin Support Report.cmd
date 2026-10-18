@echo off
cd /d "%~dp0"
title LetterFerry Weixin Support Report
echo Generating a redacted Weixin support report.
echo No LOCAL persisted cursor commit. No Weixin reply. Server replay/consumption semantics are unknown. No chat body or raw token output.
echo.
node scripts\generate-weixin-support-report.mjs
echo.
pause
