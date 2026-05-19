@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM aiball.cmd — Windows launcher mirroring bin/aiball. Preserves the
REM invoker's cwd via AIBALL_CWD (read by src/cli.ts), resolves the
REM install root, and execs the TS CLI via tsx. Same AIBALL_SOCK /
REM cli-env resolution as the bash script, so cmd.exe / PowerShell
REM users get the same behavior as Git Bash users.

set "BIN_DIR=%~dp0"
for %%I in ("%BIN_DIR%..") do set "ROOT=%%~fI"

REM Preserve invoker's cwd — cli.ts reads AIBALL_CWD so subcommands
REM that walk up from the user's project (autopoll, check, ...) see
REM the right starting point.
set "AIBALL_CWD=%CD%"
cd /d "%ROOT%"

if not defined AIBALL_HOME set "AIBALL_HOME=%USERPROFILE%\.local\share\aiball"

REM Win10+ supports AF_UNIX; prefer the daemon socket when present
REM (same-uid trust, no token needed).
if not defined AIBALL_SOCK if exist "%AIBALL_HOME%\sock" set "AIBALL_SOCK=%AIBALL_HOME%\sock"

REM cli-env is bash syntax (`export NAME=value`). Parse just enough
REM to inherit AIBALL_TOKEN etc. when no socket is available.
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

npx --no-install tsx "%ROOT%\src\cli.ts" %*
exit /b %errorlevel%
