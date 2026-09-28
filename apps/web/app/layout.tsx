import type { Metadata } from "next";
import "@reasonateai/ui/globals.css";
import "katex/dist/katex.min.css";

export const metadata: Metadata = {
  description: "A visual study for the ReasonateAI AI CTO browser product.",
  icons: {
    icon: "/brand/reasonateai-icon.png",
  },
  title: "ReasonateAI — Interface study",
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
