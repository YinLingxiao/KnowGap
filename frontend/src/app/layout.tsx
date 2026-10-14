import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: "知隙 KnowGap",
  icons: { icon: "/brand/knowgap-logo-v1.png", apple: "/brand/knowgap-logo-v1.png" },
  description: "以对话为核心的学习 Agent：解释、追问、举例与练习，并从有依据的对话中积累学习记忆。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1b1d" },
  ],
};

/** 首帧前应用用户手动选择的主题，避免闪烁 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("knowgap.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
