@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM aiball-mcp.cmd — Windows launcher mirroring bin/aiball-mcp.
REM stdio MCP server: cd to install root and exec `tsx src/mcp.ts`.
REM Honors AIBALL_URL / AIBALL_HOME / AIBALL_AGENT env vars (see README).
REM Same AIBALL_SOCK / cli-env resolution as the bash script.

set "BIN_DIR=%~dp0"
for %%I in ("%BIN_DIR%..") do set "ROOT=%%~fI"

REM #591 — preserve the caller's PWD so the MCP server (welcome resolver
REM etc.) can find the right `.aiball.yaml` by walking up from the project
REM the agent was launched in, not from the install root we cd into below.
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

npx --no-install tsx "%ROOT%\src\mcp.ts" %*
exit /b %errorlevel%
