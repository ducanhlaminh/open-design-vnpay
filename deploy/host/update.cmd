@echo off
setlocal
chcp 65001 >nul 2>&1
title Open Design - Update

set "OD_CMD_PAUSE=1"
if /I "%~1"=="--no-pause" set "OD_CMD_PAUSE=0"
set "OD_INSTALLER=%USERPROFILE%\.open-design\current\install.ps1"

if not exist "%OD_INSTALLER%" (
  echo Open Design is not installed. Run OpenDesign-Install.cmd first.
  set "OD_EXIT=1"
  goto :finish
)

echo Updating Open Design...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%OD_INSTALLER%" -Update
set "OD_EXIT=%ERRORLEVEL%"
echo.
if "%OD_EXIT%"=="0" (
  echo Open Design was updated successfully.
) else if "%OD_EXIT%"=="75" (
  echo The update is installed and will activate after you sign out and back in to Windows.
  set "OD_EXIT=0"
) else (
  echo Open Design update failed. Review the message above; the previous healthy release was preserved when rollback was possible.
)

:finish
echo.
if "%OD_CMD_PAUSE%"=="1" pause
exit /b %OD_EXIT%
