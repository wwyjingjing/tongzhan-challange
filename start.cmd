@echo off
rem ============================================================
rem  Tongzhan Challenge Cutter - launcher
rem  ASCII only on purpose: a .cmd containing non-ASCII text breaks
rem  on machines whose console code page is not UTF-8 (GBK etc.),
rem  so every Chinese message is printed by Node instead.
rem ============================================================
chcp 65001 >nul
title Tongzhan Challenge Cutter
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

"%NODE_BIN%" "%~dp0launcher.js"
echo.
pause
exit /b 0

:NONODE
echo.
echo   [!] Node.js is still not available (see the messages above).
echo.
echo   This tool needs Node.js 18+ - it only starts the local service,
echo   the tool itself runs fully offline.
echo.
echo   Install it from :  https://nodejs.org
echo   or run          :  winget install OpenJS.NodeJS.LTS
echo.
echo   After installing, close this window and double-click this file again.
echo   (Installed but still seeing this? Log out and back in, or check that
echo    node.exe exists under C:\Program Files\nodejs\)
echo.
pause
exit /b 1
