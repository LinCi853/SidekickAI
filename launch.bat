@echo off
setlocal EnableExtensions
chcp 65001 >nul
node "%~dp0scripts\workspace-menu.cjs" %*
exit /b %errorlevel%
