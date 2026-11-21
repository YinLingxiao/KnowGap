// 数据文件夹：安装时用户选的位置（默认 D 盘），和安装目录分开，升级重装都不会动到它。
// 安装程序在默认数据目录（%APPDATA%\knowgap-desktop）里留一个 data-location.txt 指针，写着选定的路径；
// 启动时读它，必要时把旧位置的数据整体搬过去，再把 Electron 的 userData 指过去。
// 依赖全部注入，方便不启动 Electron 也能测试。

const POINTER = "data-location.txt";
// 有这些文件说明这里已经是一份 KnowGap 数据，不再从旧位置搬
const DATA_SIGNS = ["knowgap.sqlite3", "desktop-settings.json", "data-reset.json", "ai-settings.json"];

/** 指针文件由 NSIS 写成 UTF-16LE（带 BOM），也兼容手写的 UTF-8。 */
function readPointer(fs, file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return "";
  }
  let text;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString("utf16le");
  else text = buffer.toString("utf8").replace(/^﻿/, "");
  return text.replace(/\0/g, "").trim();
}

function samePath(path, a, b) {
  const norm = (value) => path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function hasData(fs, path, dir) {
  return DATA_SIGNS.some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * 把 from 里除指针以外的全部内容搬到 to。先整体复制、全部成功后再删旧的；
 * 复制中途失败就删掉已复制的部分，旧数据原样保留。返回 true 表示搬完了。
 */
function migrate(fs, path, from, to) {
  const names = fs.readdirSync(from).filter((name) => name !== POINTER);
  const copied = [];
  try {
    for (const name of names) {
      const target = path.join(to, name);
      fs.cpSync(path.join(from, name), target, { recursive: true, force: true, errorOnExist: false });
      copied.push(target);
    }
  } catch (error) {
    for (const target of copied) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    }
    throw error;
  }
  for (const name of names) {
    try { fs.rmSync(path.join(from, name), { recursive: true, force: true }); } catch { /* 删不掉的留在旧位置，不影响新位置 */ }
  }
  return names.length > 0;
}

/**
 * 决定本次启动用哪个数据文件夹。必须在 app ready 和 requestSingleInstanceLock 之前调用。
 * 返回 { dir, moved, warning }：warning 有值时说明选定的文件夹用不了，暂时回退到默认位置。
 */
function resolveDataDir({ app, fs, path }) {
  const fallback = app.getPath("userData");
  const chosen = readPointer(fs, path.join(fallback, POINTER));
  if (!chosen || samePath(path, chosen, fallback)) return { dir: fallback, moved: false, warning: "" };
  if (!path.isAbsolute(chosen)) {
    return { dir: fallback, moved: false, warning: `数据文件夹「${chosen}」不是完整路径，已暂时使用默认位置。` };
  }
  try {
    fs.mkdirSync(chosen, { recursive: true });
  } catch {
    return { dir: fallback, moved: false, warning: `无法访问数据文件夹「${chosen}」（磁盘是否已拔出？），已暂时使用默认位置。` };
  }
  let moved = false;
  if (!hasData(fs, path, chosen) && fs.existsSync(fallback) && hasData(fs, path, fallback)) {
    try {
      moved = migrate(fs, path, fallback, chosen);
    } catch {
      return { dir: fallback, moved: false, warning: `把数据搬到「${chosen}」时出错（空间不足或没有写入权限），本次继续使用原来的位置。` };
    }
  }
  app.setPath("userData", chosen);
  return { dir: chosen, moved, warning: "" };
}

module.exports = { POINTER, readPointer, resolveDataDir };
