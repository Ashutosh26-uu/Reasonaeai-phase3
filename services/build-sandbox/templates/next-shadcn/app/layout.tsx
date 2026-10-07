import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  description: "A web app built with ReasonateAI.",
  title: "New app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
