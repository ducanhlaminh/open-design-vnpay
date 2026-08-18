@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Open Design - Install

set "OD_CMD_PAUSE=1"
if /I "%~1"=="--no-pause" set "OD_CMD_PAUSE=0"
set "OD_HOME=%USERPROFILE%\.open-design"
set "OD_INSTALLER=%~dp0install.ps1"
set "OD_BOOTSTRAP_INSTALLER="
rem Computed BEFORE the if-block below on purpose: cmd expands %VAR% for a
rem whole parenthesised block when it parses the block, so a variable set
rem inside the block reads as EMPTY on the very next line of that block
rem (bug 0.8.32: `powershell -File ''` on a fresh install from Downloads).
set "OD_BOOTSTRAP_CANDIDATE=%TEMP%\open-design-install-%RANDOM%-%RANDOM%.ps1"

rem Install = CLEAN install. An existing ~\.open-design is removed by
rem install.ps1 (Remove-ExistingInstallation; project data is kept) before
rem the new version goes in. In-place updates are OpenDesign-Update.cmd /
rem the web "Cap nhat" button / `od self-update` -- never this file.
rem The installer is always the latest install.ps1 from `main` unless one
rem sits next to this .cmd (release tarball layout / dev checkout).
rem OD_RELEASE_URL (mirror base URL, see install.ps1 -ReleaseUrl) also
rem changes WHERE the bootstrap installer comes from: <mirror>/install.ps1
rem instead of raw.githubusercontent.com. Networks that TLS-inspect GitHub
rem throttle both the installer and the runtime download; the mirror carries
rem both. install.ps1 itself reads the same variable for the runtime.
set "OD_BOOTSTRAP_URL=https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.ps1"
if defined OD_RELEASE_URL (
  set "OD_BOOTSTRAP_URL=%OD_RELEASE_URL%"
  if "%OD_RELEASE_URL:~-1%"=="/" set "OD_BOOTSTRAP_URL=%OD_RELEASE_URL:~0,-1%"
  set "OD_BOOTSTRAP_URL=!OD_BOOTSTRAP_URL!/install.ps1"
)
if not exist "%OD_INSTALLER%" (
  set "OD_BOOTSTRAP_INSTALLER=%OD_BOOTSTRAP_CANDIDATE%"
  set "OD_INSTALLER=%OD_BOOTSTRAP_CANDIDATE%"
  echo Downloading the latest Open Design installer...
  echo   from !OD_BOOTSTRAP_URL!
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:OD_BOOTSTRAP_URL -OutFile $env:OD_BOOTSTRAP_CANDIDATE"
  if errorlevel 1 goto :download_failed
)

echo.
if exist "%OD_HOME%\current\install.ps1" (
  echo Open Design is already installed. Removing the previous version first, then installing the latest one...
  echo ^(project data is kept^)
) else (
  echo Installing Open Design...
)
echo.
rem Everything below runs inside ONE parenthesised block so cmd has parsed
rem it all before install.ps1 runs: this very file may live under
rem %OD_HOME% (Install-OdCommandFiles copies it there) and gets deleted
rem together with the old installation mid-run -- cmd would otherwise fail
rem with "The batch file cannot be found" when it tries to read the next
rem line. Delayed expansion (!VAR!) is required for values set inside.
(
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%OD_INSTALLER%"
  set "OD_EXIT=!ERRORLEVEL!"
  if defined OD_BOOTSTRAP_INSTALLER del /f /q "%OD_BOOTSTRAP_INSTALLER%" >nul 2>&1
  if not "!OD_EXIT!"=="0" (
    echo.
    echo Open Design installation did not complete. Review the message above.
  ) else (
    echo.
    echo Open Design is ready.
  )
  echo.
  if "%OD_CMD_PAUSE%"=="1" pause
  exit /b !OD_EXIT!
)

:download_failed
if defined OD_BOOTSTRAP_INSTALLER del /f /q "%OD_BOOTSTRAP_INSTALLER%" >nul 2>&1
echo.
echo Could not download the installer. Check your network connection and try again.
echo.
if "%OD_CMD_PAUSE%"=="1" pause
exit /b 1
