# 构建 KnowGap 桌面安装包：Next 静态导出 + PyInstaller 后端 + electron-builder(NSIS)
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

function Assert-Exit([string]$name) {
    if ($LASTEXITCODE -ne 0) {
        throw "$name 失败（退出码 $LASTEXITCODE），已停止打包，避免把旧产物打进安装包。"
    }
    Write-Host "    完成" -ForegroundColor DarkGray
}

function Remove-BuildDir([string]$relative) {
    $target = Join-Path $root $relative
    if (Test-Path $target) {
        Write-Host "    清理 $relative" -ForegroundColor DarkGray
        Remove-Item -Recurse -Force $target
    }
}

Write-Host "==> 1/4 清理旧产物" -ForegroundColor Cyan
# 关键：Next 的 out/ 不会自动清掉已删除路由的 HTML；PyInstaller/electron-builder
# 也会复用 dist。旧产物混入会让安装包缺少 quick.html 之类的页面（曾发生过）。
Remove-BuildDir "frontend\out"
Remove-BuildDir "frontend\.next"
Remove-BuildDir "backend\build"
Remove-BuildDir "backend\dist"
Remove-BuildDir "desktop\dist"

Write-Host "==> 2/4 构建前端静态导出" -ForegroundColor Cyan
Push-Location (Join-Path $root "frontend")
try {
    $env:NEXT_PUBLIC_DATA_SOURCE = "api"
    $env:NEXT_PUBLIC_API_BASE_URL = "/"
    npm install --no-audit --no-fund
    Assert-Exit "npm install (frontend)"
    npm run build
    Assert-Exit "next build"
} finally {
    Pop-Location
}

Write-Host "==> 3/4 构建后端 (PyInstaller)" -ForegroundColor Cyan
Push-Location (Join-Path $root "backend")
try {
    if (-not (Test-Path ".venv\Scripts\python.exe")) { python -m venv .venv }
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt pyinstaller
    Assert-Exit "pip install (backend)"
    .\.venv\Scripts\pyinstaller.exe --noconfirm --clean knowgap.spec
    Assert-Exit "pyinstaller"
} finally {
    Pop-Location
}

Write-Host "==> 4/4 打包桌面安装包 (electron-builder)" -ForegroundColor Cyan
Push-Location (Join-Path $root "desktop")
try {
    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    npm install --no-audit --no-fund
    Assert-Exit "npm install (desktop)"
    npm run dist
    Assert-Exit "electron-builder"
} finally {
    Pop-Location
}

Write-Host "==> 校验打包结果" -ForegroundColor Cyan
$required = @(
    "frontend\out\index.html",
    "frontend\out\quick.html",
    "frontend\out\404.html",
    "backend\dist\knowgap\knowgap.exe",
    "desktop\dist\win-unpacked\KnowGap.exe",
    "desktop\dist\win-unpacked\resources\frontend\index.html",
    "desktop\dist\win-unpacked\resources\frontend\quick.html",
    "desktop\dist\win-unpacked\resources\backend\knowgap.exe",
    "desktop\dist\latest.yml"
)
$missing = $required | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missing) {
    throw "安装包缺少必要文件：`n$($missing -join "`n")`n请检查构建日志。"
}

$installer = Get-ChildItem (Join-Path $root "desktop\dist") -Filter "KnowGap-Setup-*.exe" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw "没有找到 NSIS 安装包（desktop\dist\KnowGap-Setup-*.exe）。" }
if ($installer.Length -lt 50MB) { throw "安装包体积异常（$([math]::Round($installer.Length / 1MB, 1)) MB），可能缺少后端或前端资源。" }
$version = (Get-Content -Raw (Join-Path $root "desktop\package.json") | ConvertFrom-Json).version
& node (Join-Path $PSScriptRoot "verify-update-artifacts.cjs") (Join-Path $root "desktop\package.json") (Join-Path $root "desktop\dist") "v$version"
Assert-Exit "自动更新产物校验（latest.yml / 安装包 / blockmap / SHA512）"

Write-Host ""
Write-Host "打包完成" -ForegroundColor Green
Write-Host "  安装包：$($installer.FullName)"
Write-Host "  体积：  $([math]::Round($installer.Length / 1MB, 1)) MB"
Write-Host "  免安装：$(Join-Path $root 'desktop\dist\win-unpacked\KnowGap.exe')"
