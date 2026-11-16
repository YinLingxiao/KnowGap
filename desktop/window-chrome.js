// Keep the native caption buttons (including Windows Snap Layouts), but let the
// page paint the title bar so it shares the content's theme instead of the OS's.
const TITLE_BAR_HEIGHT = 36;

function titleBarOverlay(dark) {
  return {
    color: dark ? "#1a1917" : "#fbfaf7",
    symbolColor: dark ? "#a3a097" : "#57544c",
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
  win.setBackgroundColor(dark ? "#1a1917" : "#fbfaf7");
  if (platform !== "darwin") win.setTitleBarOverlay(titleBarOverlay(dark));
}

module.exports = { TITLE_BAR_HEIGHT, windowChromeOptions, applyWindowTheme };
