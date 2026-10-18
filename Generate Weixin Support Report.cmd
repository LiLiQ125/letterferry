@echo off
cd /d "%~dp0"
title LetterFerry Weixin Support Report
echo Generating a redacted Weixin support report.
echo No cursor commit. No Weixin reply. No chat body or raw token output.
echo.
node scripts\generate-weixin-support-report.mjs
echo.
pause
