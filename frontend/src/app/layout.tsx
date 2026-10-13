import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KnowGap",
  description: "AI 驱动的知识盲区诊断与学习引导系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
