export type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "reasonate-theme";

function resolvedTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") {
    return preference;
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function readThemePreference(): ThemePreference {
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function applyThemePreference(preference: ThemePreference): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  document.documentElement.dataset.theme = resolvedTheme(preference);
}

export function initializeThemePreference(): () => void {
  const preference = readThemePreference();
  document.documentElement.dataset.theme = resolvedTheme(preference);
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const update = () => {
    if (readThemePreference() === "system") {
      document.documentElement.dataset.theme = resolvedTheme("system");
    }
  };
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
