import type { Metadata, Viewport } from "next";
import "@fontsource-variable/geist";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/source-serif-4";
import "katex/dist/katex.min.css";
import { LanguageProvider } from "@/components/LanguageProvider";
import { zh } from "@/lib/i18n/messages";
import "./globals.css";

export const metadata: Metadata = {
  title: zh["app.title"],
  icons: { icon: "/brand/knowgap-logo-v1.png", apple: "/brand/knowgap-logo-v1.png" },
  description: zh["app.description"],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111215" },
  ],
};

/** 首帧前应用用户手动选择的主题，避免闪烁，并同步桌面端原生窗口标题栏深浅色 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("knowgap.theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;if(window.knowgap&&window.knowgap.setTheme)window.knowgap.setTheme(t);}else if(window.knowgap&&window.knowgap.setTheme){window.knowgap.setTheme("system");}}catch(e){}})();`;

/** 跟随系统时，系统深浅色切换不经过 ThemeToggle：同样临时加 theme-switching 关掉过渡，
 *  否则带 background-color 过渡的卡片/按钮会比页面底色慢半拍，切换瞬间出现黑卡片 */
const SYSTEM_THEME_SCRIPT = `(function(){try{var root=document.documentElement,timer=0;window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){if(root.dataset.theme)return;root.classList.add("theme-switching");clearTimeout(timer);timer=setTimeout(function(){root.classList.remove("theme-switching");},260);});}catch(e){}})();`;

/** 首帧前恢复界面语言，避免英文用户看到中文闪烁，并让 Source Serif 4 立即生效。 */
const LANGUAGE_SCRIPT = `(function(){try{var l=localStorage.getItem("knowgap.language");if(l!=="en"&&l!=="zh")l="zh";document.documentElement.lang=l==="en"?"en":"zh-CN";document.documentElement.dataset.lang=l;}catch(e){}})();`;

/** 在首帧前预留桌面标题栏高度；浏览器与快问浮窗不启用。 */
const DESKTOP_CHROME_SCRIPT = `(function(){var c=window.knowgap&&window.knowgap.windowChrome;if(c&&["win32","darwin","linux"].includes(c.platform))document.documentElement.dataset.desktopPlatform=c.platform;})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-lang="zh" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: DESKTOP_CHROME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: LANGUAGE_SCRIPT }} />
      </head>
      <body>
        <div className="desktop-titlebar" aria-hidden="true"><span>KnowGap</span></div>
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
