@echo off
rem ============================================================
rem  Install dependencies (only ffmpeg) - Tongzhan Challenge Cutter
rem  ASCII only on purpose (a .cmd with non-ASCII text breaks on
rem  machines whose console code page is not UTF-8).
rem ============================================================
chcp 65001 >nul
title Install dependencies - Tongzhan Challenge Cutter
cd /d "%~dp0"

set "NODE_BIN="
if exist "%~dp0runtime\node\node.exe" set "NODE_BIN=%~dp0runtime\node\node.exe"
for %%N in (node.exe) do if not defined NODE_BIN if exist "%%~$PATH:N" set "NODE_BIN=%%~$PATH:N"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "%APPDATA%\npm\node.exe" set "NODE_BIN=%APPDATA%\npm\node.exe"
if not defined NODE_BIN if exist "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" set "NODE_BIN=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not defined NODE_BIN call "%~dp0get-node.cmd"
if not defined NODE_BIN goto NONODE

"%NODE_BIN%" "%~dp0setup-deps.js"
echo.
pause
exit /b 0

:NONODE
echo.
echo   [!] Node.js is still not available (see the messages above).
echo.
echo   Install it from :  https://nodejs.org
echo   or run          :  winget install OpenJS.NodeJS.LTS
echo.
pause
exit /b 1
