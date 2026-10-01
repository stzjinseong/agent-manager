@echo off
rem Claude Kiugi - start server (skip if running) and open browser
cd /d "%~dp0"
node app\launch.mjs
if errorlevel 1 pause
