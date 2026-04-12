@echo off
setlocal
cd /d "%~dp0"

set "NODE_DIR=C:\web\nvm\v22.14.0"
set "NPM_CMD=%NODE_DIR%\npm.cmd"

if not exist "%NPM_CMD%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js is not installed or not in PATH.
    echo This project needs Node.js 22 or newer.
    pause
    exit /b 1
  )

  for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
  if "%NODE_MAJOR%"=="" (
    echo Unable to detect the current Node.js version.
    pause
    exit /b 1
  )

  if %NODE_MAJOR% LSS 22 (
    echo Current Node.js version does not meet this project's requirement.
    echo Detected:
    node -v
    echo Required: Node.js 22+
    echo.
    echo Node.js 22.14.0 is already installed via nvm, but this script could not find it at:
    echo %NPM_CMD%
    pause
    exit /b 1
  )

  set "NPM_CMD=npm.cmd"
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
)

echo Starting codex-web...
call "%NPM_CMD%" run dev
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Startup failed. Check whether dependencies are installed and the codex CLI is available.
  pause
)

exit /b %EXIT_CODE%
