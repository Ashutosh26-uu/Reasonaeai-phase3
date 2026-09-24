import type { Metadata } from "next";
import "@reasonateai/ui/globals.css";

export const metadata: Metadata = {
  description:
    "The visual foundation for the ReasonateAI AI CTO browser product.",
  icons: {
    icon: "/brand/reasonateai-icon.png",
  },
  title: "ReasonateAI — Interface foundation",
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
