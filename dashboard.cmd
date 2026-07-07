@echo off
REM Launches the watch-pr dashboard and opens it in your default browser.
cd /d "%~dp0"
start "" http://localhost:7878/
node server.js
