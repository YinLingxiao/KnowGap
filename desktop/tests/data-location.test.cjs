// 数据文件夹：安装时选的位置（指针文件），启动时搬旧数据、用不了就回退。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { POINTER, readPointer, resolveDataDir } = require("../dataLocation");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kg-data-"));
  const fallback = path.join(root, "AppData", "knowgap-desktop");
  fs.mkdirSync(fallback, { recursive: true });
  const app = {
    paths: { userData: fallback },
    getPath(name) { return this.paths[name]; },
    setPath(name, value) { this.paths[name] = value; },
  };
  return { root, fallback, app };
}

function writePointer(dir, target, encoding = "utf16le") {
  const body = encoding === "utf16le"
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(target, "utf16le")])
    : Buffer.from(target, "utf8");
  fs.writeFileSync(path.join(dir, POINTER), body);
}

test("reads the installer's UTF-16LE pointer and a hand-written UTF-8 one", () => {
  const { fallback } = sandbox();
  writePointer(fallback, "D:\\KnowGap Data\\中文");
  assert.equal(readPointer(fs, path.join(fallback, POINTER)), "D:\\KnowGap Data\\中文");
  writePointer(fallback, "\uFEFFE:\\学习数据\r\n", "utf8");
  assert.equal(readPointer(fs, path.join(fallback, POINTER)), "E:\\学习数据");
  assert.equal(readPointer(fs, path.join(fallback, "missing.txt")), "");
});

test("without a pointer the default folder is used and nothing moves", () => {
  const { fallback, app } = sandbox();
  fs.writeFileSync(path.join(fallback, "knowgap.sqlite3"), "db");
  const result = resolveDataDir({ app, fs, path });
  assert.deepEqual(result, { dir: fallback, moved: false, warning: "" });
  assert.equal(app.getPath("userData"), fallback);
});

test("old data moves to the chosen folder once and the pointer stays behind", () => {
  const { root, fallback, app } = sandbox();
  const chosen = path.join(root, "D", "KnowGap Data");
  fs.writeFileSync(path.join(fallback, "knowgap.sqlite3"), "db");
  fs.writeFileSync(path.join(fallback, "desktop-settings.json"), "{}");
  fs.mkdirSync(path.join(fallback, "logs"));
  fs.writeFileSync(path.join(fallback, "logs", "backend.log"), "log");
  writePointer(fallback, chosen);

  const result = resolveDataDir({ app, fs, path });
  assert.equal(result.dir, chosen);
  assert.equal(result.moved, true);
  assert.equal(app.getPath("userData"), chosen);
  assert.equal(fs.readFileSync(path.join(chosen, "knowgap.sqlite3"), "utf8"), "db");
  assert.equal(fs.readFileSync(path.join(chosen, "logs", "backend.log"), "utf8"), "log");
  assert.deepEqual(fs.readdirSync(fallback), [POINTER], "only the pointer is left in the old place");

  // 第二次启动：新位置已有数据，不再搬
  app.setPath("userData", fallback);
  fs.writeFileSync(path.join(fallback, "knowgap.sqlite3"), "stale");
  const again = resolveDataDir({ app, fs, path });
  assert.equal(again.moved, false);
  assert.equal(fs.readFileSync(path.join(chosen, "knowgap.sqlite3"), "utf8"), "db", "never overwrites the chosen folder");
});

test("a fresh install just switches to the chosen folder", () => {
  const { root, fallback, app } = sandbox();
  const chosen = path.join(root, "D", "KnowGap Data");
  writePointer(fallback, chosen);
  const result = resolveDataDir({ app, fs, path });
  assert.deepEqual(result, { dir: chosen, moved: false, warning: "" });
  assert.ok(fs.existsSync(chosen));
});

test("an unusable chosen folder falls back to the default with a warning", () => {
  const { root, fallback, app } = sandbox();
  fs.writeFileSync(path.join(fallback, "knowgap.sqlite3"), "db");
  const blocker = path.join(root, "not-a-folder");
  fs.writeFileSync(blocker, "x");
  writePointer(fallback, path.join(blocker, "KnowGap Data"));
  const result = resolveDataDir({ app, fs, path });
  assert.equal(result.dir, fallback);
  assert.match(result.warning, /无法访问数据文件夹/);
  assert.equal(app.getPath("userData"), fallback);
  assert.equal(fs.readFileSync(path.join(fallback, "knowgap.sqlite3"), "utf8"), "db");

  writePointer(fallback, "relative\\folder");
  assert.match(resolveDataDir({ app, fs, path }).warning, /不是完整路径/);
});

test("a failed copy keeps the old data and removes the half-copied files", () => {
  const { root, fallback, app } = sandbox();
  const chosen = path.join(root, "D", "KnowGap Data");
  fs.writeFileSync(path.join(fallback, "a.txt"), "a");
  fs.writeFileSync(path.join(fallback, "knowgap.sqlite3"), "db");
  writePointer(fallback, chosen);
  const failing = {
    ...fs,
    cpSync(from, to, options) {
      if (from.endsWith("knowgap.sqlite3")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return fs.cpSync(from, to, options);
    },
  };
  const result = resolveDataDir({ app, fs: failing, path });
  assert.equal(result.dir, fallback);
  assert.match(result.warning, /搬到/);
  assert.equal(app.getPath("userData"), fallback);
  assert.ok(fs.existsSync(path.join(fallback, "knowgap.sqlite3")), "old data untouched");
  assert.ok(!fs.existsSync(path.join(chosen, "a.txt")), "partial copy cleaned up");
});

test("main.js settles the data folder before anything reads userData", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const resolveAt = main.indexOf("resolveDataDir({ app, fs, path })");
  assert.ok(resolveAt > 0);
  assert.ok(resolveAt < main.indexOf('app.getPath("userData")'), "resolved before the first userData read");
  assert.ok(resolveAt < main.indexOf("requestSingleInstanceLock"), "resolved before the single-instance lock");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("dataLocation.js"), "packaged with the app");
});

test("the installer asks for a data folder, keeps it out of the install folder and writes the pointer", () => {
  const nsh = fs.readFileSync(path.join(__dirname, "..", "installer.nsh"), "utf8");
  assert.match(nsh, /!macro customPageAfterChangeDir[\s\S]*Page custom kgDataPage kgDataPageLeave/);
  assert.match(nsh, /GetDriveType\(t "D:\\"\)/, "defaults to D: when it is a fixed disk");
  assert.match(nsh, /数据文件夹不能放在安装目录/);
  assert.match(nsh, /FileWriteWord \$0 65279[\s\S]*FileWriteUTF16LE \$0 \$kgDataDir/, "UTF-16LE pointer with BOM");
  assert.match(nsh, /\$\{if\} \$kgDataDir != ""/, "silent updates leave the pointer alone");
  assert.match(nsh, /\$\{if\} \$\{isUpdated\}\s+Abort/, "page skipped on updates");
  // 卸载只删确实是 KnowGap 数据的文件夹
  assert.match(nsh, /FileExists\} "\$R2\\knowgap\.sqlite3"[\s\S]*RMDir \/r "\$R2"/);
});
