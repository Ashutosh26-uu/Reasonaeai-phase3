import { code, type HighlightResult } from "@streamdown/code";

type Language = ReturnType<typeof code.getSupportedLanguages>[number];

const aliases: Readonly<Record<string, string>> = {
  cjs: "javascript",
  dockerfile: "docker",
  h: "c",
  htm: "html",
  js: "javascript",
  jsonc: "jsonc",
  jsx: "jsx",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shellscript",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
};

/** Resolve against the installed grammars; unknown files remain plain text. */
export function fileLanguage(path: string): Language | null {
  const name =
    path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  let candidate = name.includes(".") ? (name.split(".").at(-1) ?? "") : name;
  if (name === ".env" || name.startsWith(".env.")) {
    candidate = "dotenv";
  } else if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    candidate = "docker";
  } else if (name === "makefile") {
    candidate = "makefile";
  }
  const resolved = aliases[candidate] ?? candidate;
  return (
    code.getSupportedLanguages().find((language) => language === resolved) ??
    null
  );
}

export function sourceLines(text: string) {
  let offset = 0;
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((content, index) => {
      const line = { content, number: index + 1, offset };
      offset += content.length + 1;
      return line;
    });
}

/** Never substitute another file's cached tokens for the actual source. */
export function highlightMatchesSource(result: HighlightResult, text: string) {
  return (
    result.tokens
      .map((line) => line.map((token) => token.content).join(""))
      .join("\n") === text.replaceAll("\r\n", "\n")
  );
}

export function highlightFile(
  text: string,
  language: Language
): Promise<HighlightResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Syntax highlighting timed out.")),
      15_000
    );
    const accept = (result: HighlightResult) => {
      clearTimeout(timeout);
      if (!highlightMatchesSource(result, text)) {
        reject(new Error("Syntax highlighting did not match this file."));
        return;
      }
      resolve(result);
    };
    try {
      const result = code.highlight(
        { code: text, language, themes: code.getThemes() },
        accept
      );
      if (result !== null) {
        accept(result);
      }
    } catch (cause) {
      clearTimeout(timeout);
      reject(cause);
    }
  });
}
