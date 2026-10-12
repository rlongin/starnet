@echo off
setlocal
title EF Council Local Repair Agent
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. This PC previously used C:\Program Files\nodejs.
  echo Open the ChatGPT Windows desktop app and attach REPAIR-BRIEF.md instead.
  pause
  exit /b 1
)
node.exe "%~dp0launch-agent.mjs"
set "agentExit=%errorlevel%"
if not "%agentExit%"=="0" (
  echo.
  echo The agent stopped with an error. No antivirus setting was changed.
  echo Keep this window open so the exact message above is available.
)
pause
exit /b %agentExit%
