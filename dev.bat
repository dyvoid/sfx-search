@echo off
setlocal EnableExtensions

cd /d "%~dp0"

echo [sfx-search] Checking prerequisites...
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 'npm' was not found on PATH. Install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
)

pushd web

if not exist "node_modules" (
    echo [sfx-search] Installing Web UI dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        popd
        echo [ERROR] 'npm install' failed.
        pause
        exit /b 1
    )
)

echo [sfx-search] Starting Vite dev server at http://localhost:5173 ...
echo [sfx-search] /api requests proxy to http://127.0.0.1:8765 - make sure the backend is running (start.bat or 'uv run sfxsearch serve')
call npm run dev
popd
