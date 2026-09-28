@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "LAUNCH_ROOT=%~dp0"

rem 先确保 Node.js 环境可用（缺失或版本过旧时自动安装到用户目录，无需管理员权限）
set "NODE_DIR="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_ROOT%scripts\bootstrap\ensure-node.ps1"`) do set "NODE_DIR=%%i"
if not defined NODE_DIR goto :bootstrap-failed
if not exist "%NODE_DIR%\node.exe" goto :bootstrap-failed

set "PATH=%NODE_DIR%;%PATH%"
node "%LAUNCH_ROOT%scripts\workspace-menu.cjs" %*
exit /b %errorlevel%

:bootstrap-failed
echo.
echo 工具环境准备失败，请查看上方提示；处理后重新运行 launch.bat。
pause
exit /b 1
