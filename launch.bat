@echo off
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
echo  [1] Start dev mode          (npm run dev)
echo  [2] Package release        (installer + portable, all to release\)
echo  [3] Installer only         (direct installer, reuse build dirs)
echo  [4] Dev with DevTools      (auto open DevTools)
echo  [5] Preview production     (npm run preview)
echo  [6] Clean install deps     (pnpm install at workspace root)
echo  [7] Installer dev          (tauri dev, hot reload)
echo  [8] Exit
echo.
set /p opt="Select option (1-8): "

if "%opt%"=="1" goto dev
if "%opt%"=="2" goto release
if "%opt%"=="3" goto installer
if "%opt%"=="4" goto devtools
if "%opt%"=="5" goto preview
if "%opt%"=="6" goto clean
if "%opt%"=="7" goto installer-dev
if "%opt%"=="8" goto end
echo Invalid option.
pause
goto menu

:dev
echo.
echo [launch] Starting dev mode...
call npm run dev
if errorlevel 1 echo [launch] Dev mode failed.
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
if errorlevel 1 echo [launch] Dev (DevTools) mode failed.
echo.
echo [launch] Dev (DevTools) mode exited. Press any key to return to menu...
pause >nul
goto menu

:release
echo.
echo [launch] Building release package: installer + portable...
echo [launch] Mirrors: ELECTRON_MIRROR=%ELECTRON_MIRROR%
echo [launch] Mirrors: ELECTRON_BUILDER_BINARIES_MIRROR=%ELECTRON_BUILDER_BINARIES_MIRROR%
echo [launch] Pre-clean release\ (remove stale Setup / Portable artifacts)...
call :clean-release-artifacts

echo [launch] Step 1/3: Building app payload dirs (x64 + arm64 win-unpacked)...
call npm run build:win
if errorlevel 1 goto release-fail

echo [launch] Step 1b/3: Building portable zip (green release)...
call npm run build:portable-zip
if errorlevel 1 goto release-fail

echo [launch] Step 2/3: Building Tauri installer wizard (single-file Setup exe)...
call npm run build:tauri-installer
if errorlevel 1 goto release-fail

echo [launch] Step 3/3: Collecting artifacts into release\ ...
call :collect-portable
call :show-release
pause
goto menu

:release-fail
echo.
echo [launch] Build failed. If it was a network/download error, clear the cache and retry:
echo   rm -rf "%LOCALAPPDATA%\electron-builder\Cache"
pause
goto menu

:installer
echo.
echo [launch] Building installer only (reuse existing build dirs)...
if not exist "dist\win-unpacked" goto installer-nodist
if not exist "dist\win-arm64-unpacked" goto installer-nodist
if not exist "build\tools\7zr.exe" goto installer-no7z
echo [launch] Pre-clean release\ (remove stale Setup artifacts)...
call :clean-release-artifacts
echo [launch] Building Tauri installer wizard (single-file Setup exe)...
call npm run build:tauri-installer
if errorlevel 1 goto installer-fail
call :show-release
pause
goto menu

:installer-nodist
echo [launch] Error: dist\win-unpacked / dist\win-arm64-unpacked not found.
echo [launch] Run option 2 (Package release) first, or rebuild with: npm run build:win
pause
goto menu

:installer-no7z
echo [launch] Error: build\tools\7zr.exe not found.
echo [launch] Download: curl -L -o build/tools/7zr.exe https://www.7-zip.org/a/7zr.exe
pause
goto menu

:installer-fail
echo [launch] Tauri installer build failed.
pause
goto menu

:clean-release-artifacts
if not exist "release" mkdir "release"
if exist "release\SidekickAI-Setup-*.exe" del /q "release\SidekickAI-Setup-*.exe"
if exist "release\SidekickAI-Portable-*.zip" del /q "release\SidekickAI-Portable-*.zip"
exit /b 0

:collect-portable
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VER=%%v
set PORTABLE_SRC=dist-portable\SidekickAI-Portable-%VER%-win-x64.zip
set PORTABLE_DST=release\SidekickAI-Portable-%VER%-win-x64.zip
if not exist "%PORTABLE_SRC%" goto collect-warn
if not exist "release" mkdir "release"
copy /y "%PORTABLE_SRC%" "%PORTABLE_DST%" >nul
if errorlevel 1 goto collect-warn
echo [launch] OK Portable -> %PORTABLE_DST%
del /q "%PORTABLE_SRC%"
exit /b 0

:collect-warn
echo [launch] Warning: portable zip not found: %PORTABLE_SRC%
exit /b 0

:show-release
echo.
echo [launch] Release artifacts (release\):
dir /b /o-s "release\*.*" 2>nul
echo.
echo [launch] Folder: %cd%\release\
exit /b 0

:clean
echo.
echo [launch] Cleaning dependencies (pnpm at workspace root)...
if exist "package-lock.json" del /q "package-lock.json"
echo [launch] Running pnpm install at workspace root...
call pnpm install
if errorlevel 1 goto clean-fail
echo.
echo [launch] Dependencies reinstalled successfully. Press any key to return to menu...
pause >nul
goto menu

:clean-fail
echo [launch] pnpm install failed.
pause
goto menu

:preview
echo.
echo [launch] Starting production preview...
call npm run preview
if errorlevel 1 echo [launch] Preview failed.
echo.
echo [launch] Preview exited. Press any key to return to menu...
pause >nul
goto menu

:installer-dev
echo.
echo [launch] Starting installer-tauri dev (Tauri + Vite hot reload)...
echo [launch] Edit src\App.tsx / styles.css or src-tauri\src\*.rs, changes apply live.
cd /d "%~dp0installer-tauri"
call npm run tauri dev
set _ided=%errorlevel%
cd /d "%~dp0"
if not "%_ided%"=="0" echo [launch] Installer dev failed.
echo.
echo [launch] Installer dev exited. Press any key to return to menu...
pause >nul
goto menu

:end