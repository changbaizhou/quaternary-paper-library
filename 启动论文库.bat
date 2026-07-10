@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo ========================================
echo Quaternary Paper Library - Local Start
echo ========================================
echo.

if exist "%~dp0local.env.bat" (
  call "%~dp0local.env.bat"
) else (
  echo local.env.bat was not found.
  echo To enable translation, copy local.env.example.bat to local.env.bat and fill in your API settings.
  echo.
)

if not defined QPL_TRANSLATION_PROVIDER set "QPL_TRANSLATION_PROVIDER=qwen"
if not defined QPL_QWEN_MODEL set "QPL_QWEN_MODEL=qwen-plus"

if defined QWEN_API_KEY (
  if not defined QPL_TRANSLATION_ENABLED set "QPL_TRANSLATION_ENABLED=1"
) else if defined DASHSCOPE_API_KEY (
  if not defined QPL_TRANSLATION_ENABLED set "QPL_TRANSLATION_ENABLED=1"
) else (
  if not defined QPL_TRANSLATION_ENABLED set "QPL_TRANSLATION_ENABLED=0"
  echo Qwen API Key was not found. The app will start, but translation will be disabled.
  echo.
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js LTS first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please check your Node.js installation.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo This is not the project directory: %cd%
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo Installing dependencies. The first run may take a few minutes...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { exit 0 } exit 1" >nul 2>nul
if not errorlevel 1 (
  echo A service is already listening on port 8000. Opening the browser.
  start "" "http://127.0.0.1:8000"
  pause
  exit /b 0
)

echo Starting service: http://127.0.0.1:8000
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8000'"
call npm start

echo.
echo Service stopped.
pause
