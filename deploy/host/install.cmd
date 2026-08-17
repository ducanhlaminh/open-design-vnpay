@echo off
setlocal
chcp 65001 >nul 2>&1
title Open Design - Install

set "OD_CMD_PAUSE=1"
if /I "%~1"=="--no-pause" set "OD_CMD_PAUSE=0"
set "OD_HOME=%USERPROFILE%\.open-design"
set "OD_INSTALLER=%~dp0install.ps1"
set "OD_BOOTSTRAP_INSTALLER="
set "OD_ACTION="
rem Computed BEFORE the if-block below on purpose: cmd expands %VAR% for a
rem whole parenthesised block when it parses the block, so a variable set
rem inside the block reads as EMPTY on the very next line of that block
rem (bug 0.8.32: `powershell -File ''` on a fresh install from Downloads).
set "OD_BOOTSTRAP_CANDIDATE=%TEMP%\open-design-install-%RANDOM%-%RANDOM%.ps1"

if exist "%OD_HOME%\current\install.ps1" (
  set "OD_INSTALLER=%OD_HOME%\current\install.ps1"
  set "OD_ACTION=-Update"
) else if not exist "%OD_INSTALLER%" (
  set "OD_BOOTSTRAP_INSTALLER=%OD_BOOTSTRAP_CANDIDATE%"
  set "OD_INSTALLER=%OD_BOOTSTRAP_CANDIDATE%"
  echo Downloading the latest Open Design installer...
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.ps1' -OutFile $env:OD_BOOTSTRAP_CANDIDATE"
  if errorlevel 1 goto :download_failed
)

echo.
if defined OD_ACTION (
  echo Open Design is already installed. Running a safe update instead...
) else (
  echo Installing Open Design...
)
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%OD_INSTALLER%" %OD_ACTION%
set "OD_EXIT=%ERRORLEVEL%"
if defined OD_BOOTSTRAP_INSTALLER del /f /q "%OD_BOOTSTRAP_INSTALLER%" >nul 2>&1

if not "%OD_EXIT%"=="0" (
  echo.
  echo Open Design installation did not complete. Review the message above.
) else (
  echo.
  echo Open Design is ready.
)
goto :finish

:download_failed
set "OD_EXIT=1"
if defined OD_BOOTSTRAP_INSTALLER del /f /q "%OD_BOOTSTRAP_INSTALLER%" >nul 2>&1
echo.
echo Could not download the installer. Check your network connection and try again.

:finish
echo.
if "%OD_CMD_PAUSE%"=="1" pause
exit /b %OD_EXIT%
