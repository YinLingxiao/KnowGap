// Keep the native caption buttons (including Windows Snap Layouts), but let the
// page paint the title bar so it shares the content's theme instead of the OS's.
const TITLE_BAR_HEIGHT = 36;

function titleBarOverlay(dark) {
  return {
    color: dark ? "#08080a" : "#ffffff",
    symbolColor: dark ? "#989ea8" : "#525866",
    height: TITLE_BAR_HEIGHT,
  };
}

function windowChromeOptions(platform, dark) {
  return {
    titleBarStyle: "hidden",
    ...(platform === "darwin" ? {} : { titleBarOverlay: titleBarOverlay(dark) }),
  };
}

function applyWindowTheme(win, platform, dark) {
  win.setBackgroundColor(dark ? "#08080a" : "#ffffff");
  if (platform !== "darwin") win.setTitleBarOverlay(titleBarOverlay(dark));
}

module.exports = { TITLE_BAR_HEIGHT, windowChromeOptions, applyWindowTheme };
