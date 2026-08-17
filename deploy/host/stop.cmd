@echo off
setlocal
chcp 65001 >nul 2>&1
title Open Design - Stop

set "OD_CMD_PAUSE=1"
if /I "%~1"=="--no-pause" set "OD_CMD_PAUSE=0"
set "OD_INSTALLER=%USERPROFILE%\.open-design\current\install.ps1"

if not exist "%OD_INSTALLER%" (
  echo Open Design is not installed. Run OpenDesign-Install.cmd first.
  set "OD_EXIT=1"
  goto :finish
)

echo Stopping Open Design...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%OD_INSTALLER%" -Stop
set "OD_EXIT=%ERRORLEVEL%"
echo.
if "%OD_EXIT%"=="0" (
  echo Open Design was stopped.
) else (
  echo Open Design could not be stopped cleanly. Review the message above.
)

:finish
echo.
if "%OD_CMD_PAUSE%"=="1" pause
exit /b %OD_EXIT%
