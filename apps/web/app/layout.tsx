import type { Metadata } from "next";
import "@reasonateai/ui/globals.css";
import "katex/dist/katex.min.css";

export const metadata: Metadata = {
  description: "Build and manage projects with your ReasonateAI CTO.",
  icons: {
    icon: "/brand/reasonateai-icon.png",
  },
  title: "ReasonateAI — Workspace",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
