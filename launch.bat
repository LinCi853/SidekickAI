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
echo  [5] Clean install deps   (rm node_modules + npm install)
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
echo [launch]   - x64 installer + arm64 installer + portable zip
call npm run build:win-all
if errorlevel 1 (
  echo [launch] Build failed.
  echo [launch] If the failure is a network/download error, clear the cache and retry:
  echo   rm -rf "%LOCALAPPDATA%\electron-builder\Cache"
  pause
  goto menu
)

echo [launch] Step 2/2: Collecting release artifacts...
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VER=%%v

if not exist "release" mkdir "release"

REM Copy x64 and arm64 installer EXEs (only files with -x64/-arm64 suffix)
powershell -NoProfile -Command "$d='dist'; $found=0; Get-ChildItem $d -Filter '*.exe' -EA SilentlyContinue | Where-Object { $_.Name -notmatch 'elevate|uninstall|win-unpacked' } | ForEach-Object { if ($_.Name -match '-x64\.exe$' -or $_.Name -match '-arm64\.exe$') { Copy-Item $_.FullName release\; Write-Host ('  Installer: ' + $_.Name + ' (' + [math]::Round($_.Length/1MB,1) + ' MB)'); $found++ } }; if ($found -eq 0) { Write-Host '  WARNING: No architecture-specific installer EXE found.'; exit 1 }"

REM Copy portable ZIP
powershell -NoProfile -Command "$f=Get-ChildItem dist-portable\*.zip -EA SilentlyContinue|Sort-Object LastWriteTime -Descending|Select-Object -First 1;if($f){Copy-Item $f.FullName release\;Write-Host ('  Portable: '+$f.Name+' ('+[math]::Round($f.Length/1MB,1)+' MB)')}else{Write-Host '  WARNING: Portable ZIP not found'; exit 1}"

REM Generate release README
node scripts\gen-release-readme.cjs

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
echo [launch] Cleaning node_modules and reinstalling dependencies...
echo [launch] Mirrors: ELECTRON_MIRROR=%ELECTRON_MIRROR%
echo [launch] Mirrors: ELECTRON_BUILDER_BINARIES_MIRROR=%ELECTRON_BUILDER_BINARIES_MIRROR%
if exist "node_modules" rmdir /s /q "node_modules"
if exist "package-lock.json" del /q "package-lock.json"
call npm install
if errorlevel 1 (
  echo [launch] npm install failed.
  pause
  goto menu
)
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
