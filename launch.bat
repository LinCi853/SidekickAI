@echo off
setlocal
cd /d "%~dp0"

:menu
cls
echo ============================================
echo   SidekickAI OpenSource
echo   Workspace: %cd%
echo ============================================
echo.
echo  [1] Start development
echo  [2] Verify desktop reliability
echo  [3] Build x64 portable candidate
echo  [4] Preview production build
echo  [5] Install locked dependencies
echo  [6] Exit
echo.
set /p opt="Select option (1-6): "
if "%opt%"=="1" goto dev
if "%opt%"=="2" goto verify
if "%opt%"=="3" goto portable
if "%opt%"=="4" goto preview
if "%opt%"=="5" goto dependencies
if "%opt%"=="6" goto end
goto menu

:dev
call npm run dev
goto result

:verify
call npm run typecheck
if errorlevel 1 goto result
call npm test -- --maxWorkers=4 --minWorkers=1
if errorlevel 1 goto result
call npm run test:desktop
goto result

:portable
call npm run build:portable-zip
goto result

:preview
call npm run preview
goto result

:dependencies
call npm ci
goto result

:result
if errorlevel 1 echo [launch] The command failed. Review its output before continuing.
pause
goto menu

:end
endlocal
