@echo off
setlocal EnableDelayedExpansion

rem ===================================================================
rem  start-release.bat - Ddalkkak Threads Factory (release launcher)
rem
rem  This script only runs an already-built release package.
rem  It never runs npm install / npm run build / npm test.
rem  If the installation is broken, it just reports an error and exits.
rem ===================================================================

rem ---- 0) Always operate from the folder this script lives in ----
cd /d "%~dp0"
set "APP_DIR=%~dp0"

rem ---- 1) Find node.exe: prefer bundled runtime\node.exe, else system PATH ----
set "NODE_EXE="
set "NODE_SOURCE="

if exist "%APP_DIR%runtime\node.exe" (
    set "NODE_EXE=%APP_DIR%runtime\node.exe"
    set "NODE_SOURCE=bundled"
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo.
        echo [ERROR] Node.js was not found.
        echo Node.js 22 or later is required to run this program.
        echo Please install Node.js 22 or later ^(LTS recommended^) from
        echo https://nodejs.org and try again.
        echo.
        goto :error_exit
    )
    for /f "usebackq delims=" %%N in (`where node`) do (
        if not defined NODE_EXE set "NODE_EXE=%%N"
    )
    set "NODE_SOURCE=system"
)

if not defined NODE_EXE (
    echo.
    echo [ERROR] Could not determine the Node.js executable.
    echo Please install Node.js 22 or later from https://nodejs.org and try again.
    echo.
    goto :error_exit
)

rem ---- 2) Only check the major version when using the system Node.js ----
rem      (the bundled runtime\node.exe is trusted as-is and not re-checked)
if "%NODE_SOURCE%"=="system" (
    set "NODE_VER="
    for /f "usebackq delims=" %%V in (`"%NODE_EXE%" -v 2^>nul`) do set "NODE_VER=%%V"

    if not defined NODE_VER (
        echo.
        echo [ERROR] Could not determine the Node.js version.
        echo Please install Node.js 22 or later from https://nodejs.org and try again.
        echo.
        goto :error_exit
    )

    set "NODE_MAJOR="
    for /f "delims=v" %%A in ("!NODE_VER!") do set "NODE_VER_NUM=%%A"
    for /f "delims=. tokens=1" %%M in ("!NODE_VER_NUM!") do set "NODE_MAJOR=%%M"

    echo !NODE_MAJOR!|findstr /r "^[0-9][0-9]*$" >nul
    if errorlevel 1 (
        echo.
        echo [ERROR] Could not parse the Node.js version string. ^(detected: !NODE_VER!^)
        echo Please install Node.js 22 or later from https://nodejs.org and try again.
        echo.
        goto :error_exit
    )

    if !NODE_MAJOR! LSS 22 (
        echo.
        echo [ERROR] The installed Node.js version is too old. ^(detected: !NODE_VER!^)
        echo Node.js 22 or later is required.
        echo Please install Node.js 22 or later ^(LTS recommended^) from
        echo https://nodejs.org and try again.
        echo.
        goto :error_exit
    )
)

rem ---- 3) Check that the built program file exists ----
if not exist "%APP_DIR%dist\server.js" (
    echo.
    echo [ERROR] Application files are missing or damaged.
    echo Please reinstall the program or contact the seller for support.
    echo.
    goto :error_exit
)

rem ---- 3b) Check that the publishing settings file is intact (release only) ----
rem      A proper release package always ships a .env whose publish mode is set
rem      for real publishing (build-windows-staging.js enforces this at build
rem      time). If the file is missing or that line was damaged/removed, the
rem      server would silently fall back to a safe non-publishing mode with no
rem      visible sign, so we stop here with a clear message instead of running.
rem      (Developer builds never start through this script, so dev/test setups
rem      are not affected by this check.)
if not exist "%APP_DIR%.env" (
    echo.
    echo [ERROR] The publishing settings file is missing.
    echo Scheduled posts cannot be published in this state.
    echo Please reinstall the program or contact the seller for support.
    echo.
    goto :error_exit
)
findstr /b /c:"DRY_RUN=false" "%APP_DIR%.env" >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] The publishing settings file is damaged.
    echo Scheduled posts cannot be published in this state.
    echo Please reinstall the program or contact the seller for support.
    echo.
    goto :error_exit
)

rem ---- 4) Try to locate the Claude Code CLI (optional, never fatal) ----
rem      Search order (DdalkkakLauncher.exe performs the same search in the
rem      same order, so the two never disagree):
rem        0) an explicit CLAUDE_BIN that points at a file that exists
rem        1) current PATH: claude.exe
rem        2) current PATH: claude, claude.cmd
rem        3) standalone install: %USERPROFILE%\.local\bin\claude.exe or claude
rem        4) npm global install: %APPDATA%\npm\claude.cmd or claude.exe
rem        5) Claude Desktop bundle: %APPDATA%\Claude\claude-code\<version>\claude.exe
rem      Whenever a concrete file is found, its FULL PATH is exported as
rem      CLAUDE_BIN so node does not have to resolve the name again - the
rem      Desktop bundle lives in a per-version folder that is not on PATH, and
rem      npm's claude.cmd cannot be launched by name at all. The folder is also
rem      prepended to this batch process's own PATH (never the user or machine
rem      PATH) for compatibility. If nothing is found the server still starts
rem      normally; the program screen already shows Claude Code as not connected.
set "CLAUDE_FOUND=0"

if defined CLAUDE_BIN (
    if exist "%CLAUDE_BIN%" set "CLAUDE_FOUND=1"
)

if "%CLAUDE_FOUND%"=="0" (
    for %%I in (claude.exe claude claude.cmd) do (
        if "!CLAUDE_FOUND!"=="0" (
            for /f "delims=" %%P in ('where %%I 2^>nul') do (
                if "!CLAUDE_FOUND!"=="0" (
                    set "CLAUDE_BIN=%%P"
                    set "CLAUDE_FOUND=1"
                )
            )
        )
    )
)

if "%CLAUDE_FOUND%"=="0" (
    for %%I in (claude.exe claude) do (
        if "!CLAUDE_FOUND!"=="0" (
            if exist "%USERPROFILE%\.local\bin\%%I" (
                set "CLAUDE_BIN=%USERPROFILE%\.local\bin\%%I"
                set "PATH=%USERPROFILE%\.local\bin;%PATH%"
                set "CLAUDE_FOUND=1"
            )
        )
    )
)

if "%CLAUDE_FOUND%"=="0" (
    for %%I in (claude.cmd claude.exe) do (
        if "!CLAUDE_FOUND!"=="0" (
            if exist "%APPDATA%\npm\%%I" (
                set "CLAUDE_BIN=%APPDATA%\npm\%%I"
                set "PATH=%APPDATA%\npm;%PATH%"
                set "CLAUDE_FOUND=1"
            )
        )
    )
)

rem      Claude Desktop keeps several version folders side by side. "dir /b /o-n"
rem      lists them newest-name-first, and the first one that actually contains
rem      claude.exe wins. No path is ever guessed - each candidate is checked.
if "%CLAUDE_FOUND%"=="0" (
    if exist "%APPDATA%\Claude\claude-code" (
        for /f "delims=" %%V in ('dir /b /ad /o-n "%APPDATA%\Claude\claude-code" 2^>nul') do (
            if "!CLAUDE_FOUND!"=="0" (
                if exist "%APPDATA%\Claude\claude-code\%%V\claude.exe" (
                    set "CLAUDE_BIN=%APPDATA%\Claude\claude-code\%%V\claude.exe"
                    set "PATH=%APPDATA%\Claude\claude-code\%%V;%PATH%"
                    set "CLAUDE_FOUND=1"
                )
            )
        )
    )
)

rem ---- 5) Lightweight check for an already-running server (port 3970 only) ----
rem      Limitation: this only checks whether port 3970 is LISTENING; it does
rem      not verify which process owns it, and there is a small race window
rem      between this check and actually connecting. Finding and terminating
rem      processes is avoided here because it can be risky.
set "SERVER_ALREADY_RUNNING=0"
netstat -ano | findstr ":3970 " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 set "SERVER_ALREADY_RUNNING=1"

if "%SERVER_ALREADY_RUNNING%"=="1" (
    echo.
    echo The program already appears to be running on port 3970.
    echo Opening the browser window without starting a new server.
    start "" "http://localhost:3970"
    goto :end
)

rem ---- 6) Start the server (working folder = app install folder, own window) ----
echo.
echo Starting Ddalkkak Threads Factory...
echo.

start "Ddalkkak Threads Factory" /D "%APP_DIR%" "%NODE_EXE%" "%APP_DIR%dist\server.js"

rem ---- 7) Wait up to 10 seconds for the server, then open the default browser ----
set "SERVER_READY=0"
for /l %%I in (1,1,10) do (
    if "!SERVER_READY!"=="0" (
        netstat -ano | findstr ":3970 " | findstr /i "LISTENING" >nul 2>nul
        if not errorlevel 1 (
            set "SERVER_READY=1"
        ) else (
            timeout /t 1 /nobreak >nul
        )
    )
)

start "" "http://localhost:3970"

goto :end

:error_exit
echo Please review the error above, then close this window.
pause
endlocal
exit /b 1

:end
endlocal
exit /b 0
