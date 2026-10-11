"use client";

import { type ReactNode, useEffect } from "react";
import { initializeThemePreference } from "@/lib/theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => initializeThemePreference(), []);
  return children;
}
