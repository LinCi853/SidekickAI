@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM China-friendly mirrors for Electron & electron-builder binaries
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

:menu
cls
echo ============================================
echo   SidekickAI Launcher / Packager
echo   Workspace: %cd%
echo ============================================
echo.
echo  [1] Start dev mode       (npm run dev)
echo  [2] Package release      (build + collect to release\)
echo  [3] Dev with DevTools    (auto open DevTools)
echo  [4] Preview production   (npm run preview)
echo  [5] Clean install deps   (pnpm install @ workspace root)
echo  [6] Exit
echo.
set /p opt="Select option (1-6): "

if "%opt%"=="1" goto dev
if "%opt%"=="2" goto release
if "%opt%"=="3" goto devtools
if "%opt%"=="4" goto preview
if "%opt%"=="5" goto clean
if "%opt%"=="6" goto end

echo Invalid option.
pause
goto menu

:dev
echo.
echo [launch] Starting dev mode...
call npm run dev
if errorlevel 1 (
  echo [launch] Dev mode failed.
)
echo.
echo [launch] Dev mode exited. Press any key to return to menu...
pause >nul
goto menu

:devtools
echo.
echo [launch] Starting dev mode with DevTools auto-open...
set DEV_TOOLS=1
call npm run dev
set DEV_TOOLS=
if errorlevel 1 (
  echo [launch] Dev (DevTools) mode failed.
)
echo.
echo [launch] Dev (DevTools) mode exited. Press any key to return to menu...
pause >nul
goto menu

:release
echo.
echo [launch] Building release package (x64 + arm64 installers + portable)...
echo [launch] Mirrors: ELECTRON_MIRROR=%ELECTRON_MIRROR%
echo [launch] Mirrors: ELECTRON_BUILDER_BINARIES_MIRROR=%ELECTRON_BUILDER_BINARIES_MIRROR%
echo [launch] Step 1/2: Building packages (this may take several minutes)...
echo [launch]   - x64 + arm64 NSIS payloads (SidekickAI-Payload-*.exe)
echo [launch]   - x64 + arm64 portable zip
call npm run build:win-all
if errorlevel 1 (
  echo [launch] Build failed.
  echo [launch] If the failure is a network/download error, clear the cache and retry:
  echo   rm -rf "%LOCALAPPDATA%\electron-builder\Cache"
  pause
  goto menu
)

echo [launch] Step 1b/2: Building Tauri installer wizard (single-file Setup exe)...
call npm run build:tauri-installer
if errorlevel 1 (
  echo [launch] Tauri installer build failed (continuing, portable zips are still usable).
  pause
  goto menu
)

echo [launch] Step 2/2: Collecting release artifacts...
for /f "delims=" %%v in (
'node -p "require('./package.json').version"') do set VER=%%v

if not exist "release" mkdir "release"

echo.
echo [launch] Release package ready in release\ :
dir /b /o-s "release\*.*" 2>nul
echo.
echo [launch] Folder: %cd%\release\
echo.
pause
goto menu

:clean
echo.
echo [launch] Cleaning dependencies (pnpm monorepo, at workspace root E:\Oniroixs)...
echo [launch] Removing stale package-lock.json (npm leftover)...
if exist "package-lock.json" del /q "package-lock.json"
echo [launch] Running pnpm install at workspace root...
cd /d "%~dp0..\.."
call pnpm install
if errorlevel 1 (
  cd /d "%~dp0"
  echo [launch] pnpm install failed.
  pause
  goto menu
)
cd /d "%~dp0"
echo.
echo [launch] Dependencies reinstalled successfully. Press any key to return to menu...
pause >nul
goto menu

:preview
echo.
echo [launch] Starting production preview...
call npm run preview
if errorlevel 1 (
  echo [launch] Preview failed.
)
echo.
echo [launch] Preview exited. Press any key to return to menu...
pause >nul
goto menu

:end
