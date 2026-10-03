"use client";

import { CheckpointDiffSchema } from "@reasonateai/contracts/execution-protocol";
import { ChevronRight, FileDiff, GitCommitHorizontal } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { describeError, request, scopeQuery } from "@/lib/product-api";
import styles from "./checkpoint-card.module.css";
import type { CheckpointScope, TurnCheckpoint } from "./checkpoint-state";

function FileDiffDetail({
  turn,
  scope,
  path,
}: {
  turn: TurnCheckpoint;
  scope: CheckpointScope;
  path: string;
}) {
  const [state, setState] = useState<
    | { loading: true }
    | { loading: false; error: string }
    | { loading: false; diff: ReturnType<typeof CheckpointDiffSchema.parse> }
  >({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    const abort = new AbortController();
    setState({ loading: true });
    const query = `${scopeQuery(scope.organizationId, scope.projectId)}&runId=${encodeURIComponent(turn.runId)}&sequence=${turn.sequence}&path=${encodeURIComponent(path)}`;
    request(
      `/v1/build-sessions/${scope.buildSessionId}/workspace/checkpoint-diff?${query}`,
      CheckpointDiffSchema.parse,
      { signal: abort.signal }
    ).then(
      (diff) => {
        if (!abort.signal.aborted) {
          setState({ diff, loading: false });
        }
      },
      (cause: unknown) => {
        if (!abort.signal.aborted) {
          setState({
            error: describeError(cause, "The saved diff could not be loaded."),
            loading: false,
          });
        }
      }
    );
    return () => abort.abort();
  }, [
    attempt,
    path,
    scope.buildSessionId,
    scope.organizationId,
    scope.projectId,
    turn.runId,
    turn.sequence,
  ]);
  if (state.loading) {
    return <p role="status">Loading saved diff…</p>;
  }
  if ("error" in state) {
    return (
      <div role="alert">
        <p>{state.error}</p>
        <button onClick={retry} type="button">
          Retry
        </button>
      </div>
    );
  }
  if (state.diff.binary) {
    return <p>Binary file changed. A text diff is unavailable.</p>;
  }
  if (state.diff.unavailable) {
    return <p>This file's diff exceeds the display limit.</p>;
  }
  if (!state.diff.patch) {
    return <p>No text lines changed in this file.</p>;
  }
  return (
    <section aria-label={`Saved diff for ${path}`}>
      <pre className={styles.patch}>
        <code>
          {state.diff.patch.split("\n").map((line, index) => (
            <span className={diffLineClass(line)} key={`${index}:${line}`}>
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
}

function diffLineClass(line: string) {
  if (line.startsWith("+")) {
    return styles.addedLine;
  }
  if (line.startsWith("-")) {
    return styles.removedLine;
  }
}

export function CheckpointCard({
  turn,
  scope,
}: {
  turn: TurnCheckpoint;
  scope?: CheckpointScope;
}) {
  const [selected, setSelected] = useState<string | undefined>();
  const selectFile = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const { path } = event.currentTarget.dataset;
    setSelected((value) => (value === path ? undefined : path));
  }, []);
  const saved = turn.checkpoint;
  if (saved?.status !== "available") {
    return (
      <div className={styles.unavailable}>
        <GitCommitHorizontal aria-hidden="true" size={16} />
        <span>
          {saved || turn.checkpointId
            ? "Checkpoint saved · change details unavailable"
            : "No saved checkpoint available"}
          {turn.outcome === "succeeded" ? "" : ` · turn ${turn.outcome}`}
        </span>
      </div>
    );
  }
  return (
    <details className={styles.card}>
      <summary className={styles.summary}>
        <GitCommitHorizontal aria-hidden="true" size={17} />
        <span className={styles.title}>
          Checkpoint saved <small>{saved.commit.slice(0, 7)}</small>
        </span>
        <span className={styles.counts}>
          <span className={styles.added}>+{saved.added}</span>
          <span className={styles.removed}>−{saved.removed}</span>
        </span>
        <ChevronRight aria-hidden="true" className={styles.chevron} size={16} />
      </summary>
      <div className={styles.content}>
        <p className={styles.caption}>
          {saved.fileCount === 0
            ? "No files changed."
            : `${saved.fileCount} ${saved.fileCount === 1 ? "file" : "files"} changed`}
          {turn.outcome === "succeeded" ? "" : ` · turn ${turn.outcome}`}
        </p>
        {saved.truncated && (
          <p className={styles.caption}>
            Showing the first {saved.files.length} files. Totals cover all
            changed files.
          </p>
        )}
        <ul className={styles.files}>
          {saved.files.map((file) => (
            <li key={file.path}>
              <button
                aria-expanded={selected === file.path}
                className={styles.file}
                data-path={file.path}
                onClick={selectFile}
                type="button"
              >
                <FileDiff aria-hidden="true" size={15} />
                <span className={styles.path}>
                  {file.previousPath
                    ? `${file.previousPath} → ${file.path}`
                    : file.path}
                </span>
                <span className={styles.status}>{file.status}</span>
                <span className={styles.counts}>
                  {file.added === null ? (
                    "Binary"
                  ) : (
                    <>
                      <span className={styles.added}>+{file.added}</span>
                      <span className={styles.removed}>−{file.removed}</span>
                    </>
                  )}
                </span>
              </button>
              {selected === file.path && (
                <div className={styles.detail}>
                  {scope ? (
                    <FileDiffDetail
                      key={file.path}
                      path={file.path}
                      scope={scope}
                      turn={turn}
                    />
                  ) : (
                    <p>The saved diff is unavailable in this view.</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
