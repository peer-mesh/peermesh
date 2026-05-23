@echo off
title PeerMesh Setup
color 0A

set AGENT_DIR=%USERPROFILE%\peermesh-agent
set AGENT_URL=https://peermesh-0unl.onrender.com/api/agent-download
set TASK_NAME=PeerMeshAgent
set VBS_FILE=%AGENT_DIR%\start-silent.vbs

:: Uninstall mode: install-windows.bat uninstall
if /i "%1"=="uninstall" goto :uninstall

echo.
echo  PEERMESH AGENT SETUP
echo  ================================================
echo.

:: Check if already installed and running
tasklist /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq PeerMesh*" 2>NUL | find /I "node.exe" >NUL
if %errorlevel%==0 (
    echo  Agent is already running!
    echo  You can close this window.
    timeout /t 3
    exit /b 0
)

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [1/4] Installing Node.js...
    set NODE_MSI=%TEMP%\nodejs-setup.msi
    curl -L "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi" -o "%NODE_MSI%" 2>nul
    if not exist "%NODE_MSI%" (
        %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -Command "(New-Object Net.WebClient).DownloadFile('https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi','%NODE_MSI%')"
    )
    if exist "%NODE_MSI%" (
        msiexec /i "%NODE_MSI%" /qn /norestart
        del "%NODE_MSI%"
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
        echo  [1/4] Node.js installed!
    ) else (
        echo  ERROR: Could not install Node.js. Visit https://nodejs.org
        pause
        exit /b 1
    )
) else (
    for /f %%v in ('node --version') do echo  [1/4] Node.js %%v found
)

:: Download agent
echo.
echo  [2/4] Downloading agent...
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"

curl -L "%AGENT_URL%" -o "%AGENT_DIR%\peermesh-agent.js" 2>nul
if not exist "%AGENT_DIR%\peermesh-agent.js" (
    %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -Command "(New-Object Net.WebClient).DownloadFile('%AGENT_URL%','%AGENT_DIR%\peermesh-agent.js')"
)
if not exist "%AGENT_DIR%\peermesh-agent.js" (
    echo  ERROR: Could not download agent.
    pause
    exit /b 1
)
echo  [2/4] Agent downloaded!

:: Install dependencies
echo.
echo  [3/4] Installing dependencies...
cd /d "%AGENT_DIR%"
echo {"name":"peermesh-agent","version":"1.0.0","type":"module","dependencies":{"ws":"^8.18.0"}} > "%AGENT_DIR%\package.json"
call npm install ws --save >nul 2>&1
echo  [3/4] Done!

:: Create silent launcher VBS (runs node without any window)
echo.
echo  [4/4] Setting up to run automatically...

echo Set WShell = CreateObject("WScript.Shell") > "%VBS_FILE%"
echo WShell.Run "node %AGENT_DIR%\peermesh-agent.js", 0, False >> "%VBS_FILE%"

:: Register as Windows startup task (runs on login, no window)
schtasks /create /tn "%TASK_NAME%" /tr "wscript.exe \"%VBS_FILE%\"" /sc onlogon /ru "%USERNAME%" /f >nul 2>&1

if %errorlevel%==0 (
    echo  [4/4] Set to start automatically on login!
) else (
    echo  [4/4] Could not set auto-start (no admin rights). Will start manually.
)

:: Start the agent silently right now
echo.
echo  ================================================
echo   Starting PeerMesh agent silently...
echo  ================================================
echo.
wscript.exe "%VBS_FILE%"

:: Wait a moment then verify it started
timeout /t 3 /nobreak >nul
tasklist /FI "IMAGENAME eq node.exe" 2>NUL | find /I "node.exe" >NUL
if %errorlevel%==0 (
    echo  Agent is running in the background!
    echo  Go back to your browser - the toggle will activate automatically.
    echo.
    echo  The agent will also start automatically next time you log in.
    echo  You can close this window now.
) else (
    echo  Starting agent in foreground instead...
    node "%AGENT_DIR%\peermesh-agent.js"
)

echo.
timeout /t 5

:uninstall
echo.
echo  PEERMESH AGENT UNINSTALL
echo  ================================================
echo.

:: 1. Ask agent to shut down gracefully via HTTP
curl -s -X POST http://127.0.0.1:7654/shutdown >nul 2>&1
timeout /t 1 /nobreak >nul

:: 2. Kill any remaining node processes running the agent
for /f "tokens=2" %%p in ('wmic process where "commandline like '%%peermesh-agent%%'" get processid /format:list 2^>nul ^| findstr ProcessId') do (
    taskkill /PID %%p /F >nul 2>&1
)

:: 3. Remove scheduled task
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: 4. Remove agent files
if exist "%AGENT_DIR%" rd /s /q "%AGENT_DIR%"

echo  Agent stopped and removed.
echo  You can reinstall cleanly by running this script again.
echo.
timeout /t 3
exit /b 0
