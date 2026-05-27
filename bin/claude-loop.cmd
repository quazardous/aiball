@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM claude-loop.cmd — Windows launcher mirroring bin/claude-loop. Same
REM CWD preservation + AIBALL_SOCK/cli-env resolution as the bash
REM script, so cmd.exe / PowerShell users get the same behavior as Git
REM Bash users. Invokes the TS CLI via tsx.

REM claude-loop's inner command (run by tmux/psmux new-session) is
REM `bash -lc 'source env; exec claude --settings <json>'`. The bash
REM it needs is Git Bash. Problem: Windows ships a WSL bash launcher
REM at %SystemRoot%\System32\bash.exe which sits in machine PATH and
REM preempts Git\bin in user PATH. WSL launcher tries to exec
REM /bin/bash inside a (often missing) WSL distro and dies. So:
REM prepend Git\bin to PATH in THIS process so the chain
REM cmd -> npx tsx cli.ts -> spawn(psmux) -> bash resolves to Git
REM Bash via PATH inheritance.
if exist "C:\Program Files\Git\bin\bash.exe" set "PATH=C:\Program Files\Git\bin;%PATH%"

set "BIN_DIR=%~dp0"
for %%I in ("%BIN_DIR%..") do set "ROOT=%%~fI"

REM Preserve invoker's cwd — cli.ts (and aiball.cmd) reads AIBALL_CWD
REM so subcommands that walk up from the user's project (project cwd
REM resolution, tmux cwd, state-dir naming) see the right starting
REM point. Same name as bin/claude-loop (bash) and bin/aiball.cmd —
REM single canonical var across the whole aiball product surface.
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

npx --no-install tsx "%ROOT%\src\claude-loop\cli.ts" %*
exit /b %errorlevel%
