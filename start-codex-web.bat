@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "NODE_DIR=C:\web\nvm\v22.14.0"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
set "ROOT_DIR=%CD%"

if not exist "%NPM_CMD%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js is not installed or not in PATH.
    echo This project needs Node.js 22 or newer.
    pause
    exit /b 1
  )

  set "NODE_VERSION="
  for /f %%v in ('node -v') do set "NODE_VERSION=%%v"
  if not defined NODE_VERSION (
    echo Unable to detect the current Node.js version.
    pause
    exit /b 1
  )

  set "NODE_MAJOR=!NODE_VERSION:v=!"
  for /f "tokens=1 delims=." %%v in ("!NODE_MAJOR!") do set "NODE_MAJOR=%%v"
  if not defined NODE_MAJOR (
    echo Unable to parse the current Node.js major version.
    echo Detected:
    node -v
    pause
    exit /b 1
  )

  set /a NODE_MAJOR_NUM=!NODE_MAJOR! 2>nul
  if errorlevel 1 (
    echo Unable to parse the current Node.js major version.
    echo Detected:
    node -v
    pause
    exit /b 1
  )

  if !NODE_MAJOR_NUM! LSS 22 (
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

if not exist "node_modules" (
  echo Dependencies are not installed. Please run npm install first.
  pause
  exit /b 1
)

echo Starting codex-web in separate windows...
echo.
echo Shared types: TypeScript watch
echo Server:      http://127.0.0.1:9000
echo Web:         http://127.0.0.1:10000
echo.
echo Close the opened terminal windows to stop the dev services.

start "codex-web shared" cmd /k "cd /d ""%ROOT_DIR%"" && call ""%NPM_CMD%"" run dev:shared"
start "codex-web server" cmd /k "cd /d ""%ROOT_DIR%"" && call ""%NPM_CMD%"" run dev -w @codex-web/server"
start "codex-web web" cmd /k "cd /d ""%ROOT_DIR%"" && call ""%NPM_CMD%"" run dev -w @codex-web/web"

exit /b 0
