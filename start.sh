#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[sfx-search] Checking prerequisites..."
if ! command -v uv >/dev/null 2>&1; then
    echo "[ERROR] 'uv' was not found on PATH. Install it from https://docs.astral.sh/uv/" >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] 'npm' was not found on PATH. Install Node.js 20+ from https://nodejs.org/" >&2
    exit 1
fi

if [ ! -f "config.toml" ] && [ -f "config.example.toml" ]; then
    echo "[sfx-search] Creating config.toml from config.example.toml..."
    cp "config.example.toml" "config.toml"
fi

echo "[sfx-search] Syncing Python environment via uv..."
uv sync

echo "[sfx-search] Installing and building Web UI..."
pushd web >/dev/null
npm install --no-audit --no-fund
npm run build
popd >/dev/null

URL="http://127.0.0.1:8765"
echo "[sfx-search] Starting server at ${URL} ..."
if command -v explorer.exe >/dev/null 2>&1; then
    explorer.exe "$URL" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
fi

exec uv run sfxsearch serve "$@"
