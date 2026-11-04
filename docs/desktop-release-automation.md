# PR 合并与桌面自动更新

**发版在负责人本机完成**（2026-11-04 起）：推送到 `main` 只跑检查，不再自动发布 Release。GitHub 的 Windows 机器跑完整流程要 15–20 分钟，且慢机器上计时类测试偶尔超时。功能分支不要改版本号，版本递增只放在 `release/vX.Y.Z` 分支的 `chore: release` 提交里。

## 本机发版

1. 在 `release/vX.Y.Z` 分支递增 `desktop/package.json`、`frontend/package.json` 及两份 lock 的版本，添加 `docs/release-notes-v<版本>.md`，提交 `chore: release vX.Y.Z`，合并进 `main` 并推送。
2. 停掉本机的 `next dev`（构建脚本会删除 `frontend\.next`），在 PowerShell 里依次运行下面「本地复核」的命令。不要从 Git Bash 运行构建脚本。
3. 用 `gh` 按与 `scripts/publish-release-ci.ps1` 相同的顺序发布：以该次合并的提交为 `--target` 建草稿 Release，上传安装包、差分映射和 `latest.yml`，核对三个资源的文件名和字节数，再 `--draft=false --latest` 公开。
4. 需要时仍可在 Actions 里手动运行 `Desktop checks and release`（workflow_dispatch），由 GitHub 构建并发布。

## 原自动流程（现需手动触发）

1. 向 `YinLingxiao/KnowGap` 的 `main` 提交 PR。工作流会在 Windows 上运行前后端、桌面和发布回归，构建完整安装包，并对冻结后的后端、静态资源、待发送接口和重启持久化进行检查。PR 仅产生测试用构建产物，不发布 Release。
2. 负责人审核并合并 PR。推送到 `main` 只跑相同的检查和构建；手动触发且版本高于当前最新正式版时，发布任务使用该次提交创建 `v<版本>` 标签。
3. 先创建草稿 Release，上传安装包、差分映射和 `latest.yml`，核对文件名及体积后再公开并设为最新正式版。上传中断时保持草稿，已安装客户端不会读到半套更新。已公开版本不会被覆盖。
4. 其他人打开设置 → 通用 → 软件更新 → 检查更新，下载完成后确认重启安装。默认也会后台检查和下载。更新沿用项目现有机制，保留本地学习数据与模型配置。

手动触发时不需要负责人再本机构建或上传安装包，也不需要预先推送标签。没有更新器的早期安装版仍需先手动安装一次。用户自定义了更新镜像时，镜像需要同步上述三个文件。

## 仓库端前提

仓库必须允许 GitHub Actions 运行，以及发布任务申请 `contents: write` 权限。发布任务只接受官方仓库 `main` 上的手动运行；不接受 PR、fork 或其他分支的发布。无需新增模型 API Key 或个人访问令牌，使用工作流内置的临时 GitHub token。

首次合并新增工作流后，应查看 Actions 的 `Desktop checks and release` 结果；只有 GitHub 上确实出现完整正式 Release 后，其他人才会收到更新。本地验证不能代替这次线上运行。若组织策略禁止创建 Release、标签规则不允许工作流建标签，负责人需要先调整对应仓库权限。

## 后续版本和失败恢复

- 下一次发布同时递增 `desktop/package.json`、`desktop/package-lock.json` 两处版本，并添加 `docs/release-notes-v<版本>.md`。相同已发布版本只做验证，不覆盖安装包。
- 测试或打包失败时不会发布。修复代码后重新构建。
- 上传中断时保留草稿。可对同一提交重跑失败的发布任务；它只补齐同一提交的草稿。已有标签或草稿属于另一提交时直接停止，避免混用产物。
- 已发布版本有问题时，以更高版本发布修复；不打开自动降级，不手改 `latest.yml` 中的校验值。
- 保留现有 [手动发布脚本](../scripts/publish-release.ps1) 作为人工发布方式，执行前仍需要校验和确认；不要与自动流程同时发布相同版本。

## 本地复核

```powershell
cd frontend
npm ci
npm run test:api
cd ../desktop
npm ci
npm test
cd ..
node scripts/release-plan.cjs
./scripts/build-desktop.ps1
backend/.venv/Scripts/python.exe scripts/smoke-desktop.py
./scripts/publish-release-ci.ps1 -CheckOnly
```

`-CheckOnly` 只检查三个更新文件及其哈希，不调用 GitHub 发布。测试构建产物也可以直接从对应 PR 的 Actions → Artifacts 下载。

前端类型检查随生产构建执行，以保证 Next.js 自动生成的路由声明已存在；全新检出时不要先对尚未生成的 `.next/types` 运行类型检查。
