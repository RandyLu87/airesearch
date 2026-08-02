import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AI Research｜上市公司长期价值研究",
  description: "以商业模式、核心驱动、最新变化和安全边际为主线的上市公司研究。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="research-shell">{children}</body>
    </html>
  );
}
