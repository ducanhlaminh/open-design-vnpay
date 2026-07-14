@echo off
REM Double-click this file. It runs the real setup script
REM (setup-open-design-windows.ps1) with the right PowerShell flags so you
REM don't have to change any Windows security settings by hand.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-open-design-windows.ps1"
pause
