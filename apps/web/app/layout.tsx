import type { Metadata } from "next";
import "@reasonateai/ui/globals.css";
import "katex/dist/katex.min.css";
import { NetworkBanner } from "@/components/network/network-banner";

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
      <head>
        <link href="https://fonts.googleapis.com" rel="preconnect" />
        <link
          crossOrigin="anonymous"
          href="https://fonts.gstatic.com"
          rel="preconnect"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="relative min-h-screen bg-[#050507] text-[#EDEDE9] antialiased selection:bg-[#D6FF57]/30 selection:text-[#EDEDE9]">
        {/* Dossier Pro Max Orbs (always 3, behind content, blurred) */}
        <div aria-hidden="true" className="dossier-orbs">
          <div className="dossier-orb dossier-orb-1" />
          <div className="dossier-orb dossier-orb-2" />
          <div className="dossier-orb dossier-orb-3" />
        </div>

        {/* Dossier Pro Max Grain Filter */}
        <div aria-hidden="true" className="dossier-grain">
          <svg aria-hidden="true" className="h-full w-full opacity-40">
            <title>Dossier grain texture</title>
            <filter id="dossier-grain-noise">
              <feTurbulence
                baseFrequency="0.9"
                numOctaves={3}
                stitchTiles="stitch"
                type="fractalNoise"
              />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect
              fill="transparent"
              filter="url(#dossier-grain-noise)"
              height="100%"
              width="100%"
            />
          </svg>
        </div>

        <NetworkBanner />
        <div className="relative z-10 flex min-h-screen flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
