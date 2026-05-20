@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Windows .cmd wrapper for src/autopoll/hook-stop.ts. Mirrors the
REM POSIX wrapper aiball-autopoll-stop.sh — wired into Claude Code's
REM `Stop` hook via .claude/settings.json (use `aiball init --stop-hook`
REM to set this up). Never blocks Claude due to a hook failure.

set "BIN_DIR=%~dp0"
for %%I in ("%BIN_DIR%..\..") do set "INSTALL_ROOT=%%~fI"

if not defined AIBALL_HOME set "AIBALL_HOME=%USERPROFILE%\.local\share\aiball"

REM Win10+ supports AF_UNIX but `net.createServer.listen(path)` maps
REM to Named Pipes on Windows, not AF_UNIX files — so UDS is TCP-only
REM by daemon default. Source cli-env for AIBALL_TOKEN instead.
if not defined AIBALL_SOCK if exist "%AIBALL_HOME%\sock" set "AIBALL_SOCK=%AIBALL_HOME%\sock"
if not defined AIBALL_SOCK if not defined AIBALL_TOKEN if exist "%AIBALL_HOME%\cli-env" (
    for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "export " "%AIBALL_HOME%\cli-env"`) do (
        set "_k=%%A"
        set "_k=!_k:export =!"
        set "_v=%%B"
        if "!_v:~0,1!"=="^"" set "_v=!_v:~1,-1!"
        if "!_v:~0,1!"=="'" set "_v=!_v:~1,-1!"
        set "!_k!=!_v!"
    )
)

cd /d "%INSTALL_ROOT%"
npx --no-install tsx "%INSTALL_ROOT%\src\autopoll\hook-stop.ts"
exit /b %errorlevel%
