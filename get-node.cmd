@echo off
rem ============================================================
rem  get-node.cmd - make sure we have a Node.js to run launcher.js
rem
rem  Order: bundled runtime\node -> PATH -> common install dirs
rem         -> (if still missing) download the portable Node zip
rem            with Windows built-in curl + tar, no admin needed.
rem  ASCII only on purpose (see README: non-ASCII .cmd breaks on
rem  machines whose console code page is not UTF-8).
rem
rem  Called by start.cmd / setup-deps.cmd via:  call "%~dp0get-node.cmd"
rem  On success it sets NODE_BIN (no setlocal here on purpose).
rem ============================================================
set "NODE_BIN="
if exist "%~dp0runtime\node\node.exe" set "NODE_BIN=%~dp0runtime\node\node.exe"
for %%N in (node.exe) do if not defined NODE_BIN if exist "%%~$PATH:N" set "NODE_BIN=%%~$PATH:N"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "%APPDATA%\npm\node.exe" set "NODE_BIN=%APPDATA%\npm\node.exe"
if not defined NODE_BIN if exist "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" set "NODE_BIN=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if defined NODE_BIN exit /b 0

echo.
echo   [!] Node.js not found on this machine.
echo.
echo   This tool can download a PORTABLE Node.js (about 30 MB, no install,
echo   no admin) into its own runtime\node folder, then keep working offline.
echo.
set "NODE_VER=v22.22.2"
set "NODE_ZIP=node-%NODE_VER%-win-x64.zip"
set "STAGE=%~dp0runtime\_stage"
set "TMPZIP=%~dp0runtime\%NODE_ZIP%"
set "TRY="

if exist "%~dp0runtime\node\node.exe" goto FOUND
if not exist "%~dp0runtime" mkdir "%~dp0runtime"

echo   Downloading %NODE_ZIP% ...
echo.
curl.exe -L --fail --retry 2 --connect-timeout 20 --progress-bar -o "%TMPZIP%" "https://nodejs.org/dist/%NODE_VER%/%NODE_ZIP%"
if not errorlevel 1 if exist "%TMPZIP%" set "TRY=1"
if not defined TRY (
  echo.
  echo   nodejs.org failed, trying mirror npmmirror.com ...
  curl.exe -L --fail --retry 2 --connect-timeout 20 --progress-bar -o "%TMPZIP%" "https://registry.npmmirror.com/-/binary/node/%NODE_VER%/%NODE_ZIP%"
  if not errorlevel 1 if exist "%TMPZIP%" set "TRY=1"
)
if not defined TRY goto MANUAL

echo.
echo   Extracting ...
if exist "%STAGE%" rd /s /q "%STAGE%"
mkdir "%STAGE%"
tar.exe -xf "%TMPZIP%" -C "%STAGE%"
if errorlevel 1 (
  echo   tar.exe failed, trying PowerShell Expand-Archive ...
  powershell -NoProfile -Command "Expand-Archive -Force '%TMPZIP%' '%STAGE%'"
)
if not exist "%STAGE%\node-%NODE_VER%-win-x64\node.exe" goto MANUAL
if exist "%~dp0runtime\node" rd /s /q "%~dp0runtime\node"
move "%STAGE%\node-%NODE_VER%-win-x64" "%~dp0runtime\node" >nul
rd /s /q "%STAGE%" 2>nul
del /q "%TMPZIP%" 2>nul

:FOUND
if exist "%~dp0runtime\node\node.exe" set "NODE_BIN=%~dp0runtime\node\node.exe"
if defined NODE_BIN (
  echo.
  echo   [OK] Portable Node.js is ready: %NODE_BIN%
  echo        (it stays inside this folder; nothing was installed system-wide)
  echo.
  exit /b 0
)
goto MANUAL

:MANUAL
echo.
echo   [!] Could not prepare Node.js automatically.
echo.
echo   Please do ONE of these:
echo     1) Install Node.js LTS from  https://nodejs.org  (or run: winget install OpenJS.NodeJS.LTS)
echo     2) Or download the zip  https://nodejs.org/dist/%NODE_VER%/%NODE_ZIP%
echo        and unzip it so that this file exists:
echo        %~dp0runtime\node\node.exe
echo     3) Then double-click this tool again.
echo.
exit /b 1
