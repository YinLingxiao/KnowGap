# The workflow's protected main-branch job is the publication authorization.
[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$planJson = & node (Join-Path $PSScriptRoot 'release-plan.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Release metadata validation failed.' }
$plan = $planJson | ConvertFrom-Json
$dist = Join-Path $root 'desktop\dist'
$package = Join-Path $root 'desktop\package.json'
$verify = Join-Path $PSScriptRoot 'verify-update-artifacts.cjs'
$verifiedJson = & node $verify $package $dist $plan.tag
if ($LASTEXITCODE -ne 0) { throw 'Artifact validation failed; nothing was published.' }
$verified = $verifiedJson | ConvertFrom-Json
if ($CheckOnly) { $verified; return }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'YinLingxiao/KnowGap' -or
    $env:GITHUB_REF -ne 'refs/heads/main' -or $env:GITHUB_EVENT_NAME -notin @('push', 'workflow_dispatch')) {
    throw 'Automated publication is only allowed from the official main-branch workflow.'
}
# Recheck after the build: another release may have finished while this job waited.
$remoteJson = & node (Join-Path $PSScriptRoot 'release-plan.cjs') --github
if ($LASTEXITCODE -ne 0) { throw 'Remote release preflight failed.' }
$remote = $remoteJson | ConvertFrom-Json
if (-not $remote.shouldPublish) { Write-Host 'This version is already published; left unchanged.'; return }
if (-not $remote.draftExists) {
    & gh release create $plan.tag --repo $env:GITHUB_REPOSITORY --target $env:GITHUB_SHA --draft --title "KnowGap $($plan.tag)" --notes-file (Join-Path $root $plan.notes)
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the draft release.' }
}
# A draft stays invisible to installed clients until every required asset exists.
& gh release upload $plan.tag $verified.installer $verified.blockmap $verified.manifest --repo $env:GITHUB_REPOSITORY --clobber
if ($LASTEXITCODE -ne 0) { throw 'Asset upload failed; the release remains a draft.' }
$assetsJson = & gh release view $plan.tag --repo $env:GITHUB_REPOSITORY --json assets
if ($LASTEXITCODE -ne 0) { throw 'Could not verify uploaded assets; the release remains a draft.' }
$assets = ($assetsJson | ConvertFrom-Json).assets
foreach ($file in @($verified.installer, $verified.blockmap, $verified.manifest)) {
    $local = Get-Item -LiteralPath $file
    $asset = @($assets | Where-Object name -CEQ $local.Name)
    if ($asset.Count -ne 1 -or $asset[0].size -ne $local.Length) { throw 'Uploaded assets are incomplete; the release remains a draft.' }
}
& gh release edit $plan.tag --repo $env:GITHUB_REPOSITORY --draft=false --latest
if ($LASTEXITCODE -ne 0) { throw 'Could not publish the completed draft.' }
Write-Host "Published $($plan.tag) with a validated installer, blockmap and latest.yml."
