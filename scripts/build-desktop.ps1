$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

Set-Location "$root\frontend"
$env:NEXT_PUBLIC_DATA_SOURCE = "api"
$env:NEXT_PUBLIC_API_BASE_URL = "/"
npm install
npm run build

Set-Location "$root\backend"
if (-not (Test-Path .venv\Scripts\python.exe)) { python -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r requirements.txt pyinstaller
.\.venv\Scripts\pyinstaller --noconfirm knowgap.spec

Set-Location "$root\desktop"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install
npm run dist
