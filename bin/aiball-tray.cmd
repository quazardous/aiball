@echo off
REM aiball-tray.cmd — Windows launcher for the system-tray helper.
REM Spawns PowerShell hidden (no console window). Doubled-clicked from
REM a Desktop / Start Menu / Startup-folder shortcut.

powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0aiball-tray.ps1"
