@echo off
setlocal EnableExtensions

cd /d "%~dp0"

echo [sfx-search] Checking prerequisites...
where uv >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 'uv' was not found on PATH. Install it from https://docs.astral.sh/uv/
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 'npm' was not found on PATH. Install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "config.toml" (
    if exist "config.example.toml" (
        echo [sfx-search] Creating config.toml from config.example.toml...
        copy /Y "config.example.toml" "config.toml" >nul
    )
)

echo [sfx-search] Syncing Python environment via uv...
call uv sync
if errorlevel 1 (
    echo [ERROR] 'uv sync' failed.
    pause
    exit /b 1
)

echo [sfx-search] Installing and building Web UI...
pushd web
if not exist "node_modules" (
    call npm install
    if errorlevel 1 (
        popd
        echo [ERROR] 'npm install' failed.
        pause
        exit /b 1
    )
)
call npm run build
if errorlevel 1 (
    popd
    echo [ERROR] 'npm run build' failed.
    pause
    exit /b 1
)
popd

echo [sfx-search] Starting server at http://127.0.0.1:8765 ...
start "" "http://127.0.0.1:8765"
call uv run sfxsearch serve
