"use client";

import type { HighlightResult } from "@streamdown/code";
import { Check, Copy, WrapText } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import styles from "./file-content.module.css";
import { fileLanguage, highlightFile, sourceLines } from "./file-highlight";

function tokenStyle(
  style: Record<string, string> | string | undefined
): CSSProperties {
  if (typeof style !== "object") {
    return {};
  }
  const { color, ...colors } = style;
  colors["--source-light"] = color || "inherit";
  return colors;
}

export function FileSource({
  text,
  result,
  wrap = false,
}: {
  text: string;
  result: HighlightResult | null;
  wrap?: boolean;
}) {
  const lines = useMemo(() => sourceLines(text), [text]);
  return (
    <pre className={styles.source} data-wrap={wrap || undefined}>
      <code>
        {lines.map((line) => (
          <span
            className={styles.line}
            data-line={line.number}
            key={line.offset}
          >
            {result?.tokens[line.number - 1]?.map((token) => (
              <span
                className={styles.token}
                key={token.offset}
                style={tokenStyle(token.htmlStyle)}
              >
                {token.content}
              </span>
            )) ?? line.content}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** Source is always escaped React text, including HTML and embedded scripts. */
export function FileContentPreview({
  path,
  text,
}: {
  path: string;
  text: string;
}) {
  const language = fileLanguage(path);
  const [highlighted, setHighlighted] = useState<{
    text: string;
    result: HighlightResult;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = sourceLines(text).length;

  useEffect(() => {
    let current = true;
    setHighlighted(null);
    setNotice("");
    if (language === null || text.length === 0) {
      return;
    }
    highlightFile(text, language)
      .then((result) => {
        if (current) {
          setHighlighted({ result, text });
        }
      })
      .catch(() => {
        if (current) {
          setNotice(
            "Syntax highlighting is unavailable. Showing the complete source as plain text."
          );
        }
      });
    return () => {
      current = false;
    };
  }, [language, text]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setNotice("");
    } catch {
      setNotice(
        "Could not copy the file. Select the source to copy it manually."
      );
    }
  }, [text]);
  const toggleWrap = useCallback(() => setWrap((previous) => !previous), []);

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <span>
          {language ?? "Plain text"} · {lines} line{lines === 1 ? "" : "s"}
        </span>
        <div className={styles.actions}>
          <button
            aria-label="Wrap source lines"
            aria-pressed={wrap}
            className={styles.action}
            onClick={toggleWrap}
            type="button"
          >
            <WrapText aria-hidden="true" size={14} />
          </button>
          <button
            aria-label={copied ? "File copied" : "Copy file source"}
            className={styles.action}
            onClick={copy}
            type="button"
          >
            {copied ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
          </button>
        </div>
      </div>
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}
      <FileSource
        result={highlighted?.text === text ? highlighted.result : null}
        text={text}
        wrap={wrap}
      />
    </div>
  );
}
