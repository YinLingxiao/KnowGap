# 只校验和上传；不构建、不推送、不创建标签。需要负责人先推送同版本标签。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$NotesFile,
    [string]$ExpectedSha256,
    [switch]$CheckOnly
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$notes = (Resolve-Path -LiteralPath $NotesFile).Path
if (-not (Test-Path -LiteralPath $notes -PathType Leaf)) { throw "说明文件不存在。" }
$package = Join-Path $root "desktop\package.json"
$dist = Join-Path $root "desktop\dist"
$verify = Join-Path $PSScriptRoot "verify-update-artifacts.cjs"
$json = & node $verify $package $dist $Tag $ExpectedSha256
if ($LASTEXITCODE -ne 0) { throw "上传前校验未通过，未上传任何文件。" }
$result = ($json -join "`n") | ConvertFrom-Json
Write-Host "版本：$($result.version) / 标签：$Tag"
Write-Host "安装包：$($result.installer)"
Write-Host "清单：$($result.manifest)"
Write-Host "差分映射：$($result.blockmap)"
Write-Host "SHA512 (已与 latest.yml 比较)：$($result.sha512)"
Write-Host "SHA256 (独立计算，供负责人核对)：$($result.sha256)"
Write-Host "说明文件：$notes"
if ($CheckOnly) { Write-Host "仅校验完成；未调用 gh。"; return }
Write-Host "将向公开仓库 YinLingxiao/KnowGap 创建正式 Release 并上传以上三个文件。" -ForegroundColor Yellow
$answer = Read-Host "确认已完成安装升级验收并独占发布？输入完整标签 $Tag 确认；其他输入取消"
if ($answer -cne $Tag) { throw "已取消，未上传。" }
# Recheck after human confirmation to catch an accidental concurrent rebuild.
$again = & node $verify $package $dist $Tag $result.sha256
if ($LASTEXITCODE -ne 0) { throw "确认期间产物发生变化，已停止。" }
& gh release create $Tag $result.installer $result.blockmap $result.manifest --repo "YinLingxiao/KnowGap" --verify-tag --title "KnowGap $Tag" --notes-file $notes
if ($LASTEXITCODE -ne 0) { throw "gh release create 失败。检查远端是否留下未完整上传的 Release；不要直接重复发布。" }
Write-Host "上传完成。请检查 GitHub 资源名与 latest.yml，并用旧安装版验证更新。" -ForegroundColor Green
