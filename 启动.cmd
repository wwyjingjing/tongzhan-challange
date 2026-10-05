@echo off
chcp 65001 >nul
title 童站挑战剪辑器
cd /d "%~dp0"

rem 找一个可用的 node：先看 PATH，再看内置兜底路径
set "NODE_BIN="
for %%N in (node.exe) do if not defined NODE_BIN if exist "%%~$PATH:N" set "NODE_BIN=%%~$PATH:N"
if not defined NODE_BIN if exist "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" set "NODE_BIN=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not defined NODE_BIN goto NONODE

rem 其余全部交给 Node 助手（挑端口 / 启动服务 / 就绪后开浏览器），不依赖 PowerShell
"%NODE_BIN%" "%~dp0launcher.js"
echo.
pause
exit /b 0

:NONODE
echo [错误] 找不到 node.exe。
echo        请安装 Node.js 18+ 并加入 PATH，或确认兜底路径存在：
echo        C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe
echo.
pause
exit /b 1
