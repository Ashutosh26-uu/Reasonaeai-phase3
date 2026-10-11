"use client";

import {
  Check,
  Layers,
  Moon,
  MoveUpRight,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import Image from "next/image";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { applyThemePreference, readThemePreference } from "@/lib/theme";
import "./auth.css";

export function AuthShell({
  children,
  stage = 0,
}: {
  children: ReactNode;
  stage?: number;
}) {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    applyThemePreference(readThemePreference());
    setTheme(
      document.documentElement.dataset.theme === "light" ? "light" : "dark"
    );
  }, []);
  const toggleTheme = useCallback(() => {
    const nextTheme =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyThemePreference(nextTheme);
    setTheme(nextTheme);
  }, []);

  return (
    <main className="auth-page">
      <button
        aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
        className="auth-theme-toggle"
        onClick={toggleTheme}
        type="button"
      >
        {theme === "light" ? (
          <Moon aria-hidden="true" size={17} />
        ) : (
          <Sun aria-hidden="true" size={17} />
        )}
      </button>
      <section aria-label="About ReasonateAI" className="auth-story">
        <a className="auth-brand" href="/">
          <Image
            alt=""
            height={32}
            priority
            src="/brand/reasonateai-icon.png"
            width={32}
          />
          Reasonate<span>AI</span>
        </a>
        <div className="auth-story-content">
          <span className="auth-eyebrow">
            <span /> YOUR IDEA. A WORKING PRODUCT.
          </span>
          <h2>
            A little ambition.
            <br />A whole lot
            <br />
            <em>of possibility.</em>
          </h2>
          <p>
            Meet your AI CTO. Turn the idea you keep thinking about into
            something you can actually use.
          </p>
          <div aria-hidden="true" className="auth-blueprint">
            <div className="auth-blueprint-grid" />
            <div className="auth-orbit auth-orbit-one" />
            <div className="auth-orbit auth-orbit-two" />
            <div className="auth-core">
              <Sparkles size={36} strokeWidth={1.3} />
            </div>
            <div className="auth-blueprint-node auth-node-idea">
              <span>
                <Layers size={15} />
                Your idea
              </span>
              <strong>The starting point</strong>
            </div>
            <div className="auth-blueprint-node auth-node-build">
              <span>
                <Check size={15} />
                Plan · Build · Verify
              </span>
              <strong>Made with your CTO</strong>
            </div>
            <div className="auth-blueprint-node auth-node-product">
              <MoveUpRight size={24} />
              <strong>Your next big thing</strong>
            </div>
          </div>
        </div>
        <div className="auth-story-foot">
          <ShieldCheck size={16} />
          <span>A private workspace for everything you build.</span>
        </div>
      </section>
      <section className="auth-main">
        <div className="auth-mobile-brand">
          <Image
            alt=""
            height={28}
            src="/brand/reasonateai-icon.png"
            width={28}
          />
          ReasonateAI
        </div>
        <div className="auth-card">
          <ol aria-label="Account setup progress" className="auth-steps">
            {["Account", "Verify", "Workspace"].map((label, index) => (
              <li
                aria-current={stage === index ? "step" : undefined}
                className={stage >= index ? "is-active" : ""}
                key={label}
              >
                <span>{stage > index ? <Check size={12} /> : index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          {children}
        </div>
        <footer className="auth-footer">
          From the first idea to the next release.
        </footer>
      </section>
    </main>
  );
}
