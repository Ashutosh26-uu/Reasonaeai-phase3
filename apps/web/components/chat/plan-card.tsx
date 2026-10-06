"use client";

import type { PlanProposal } from "@reasonateai/contracts/execution-protocol";
import { Check, FileText, ListChecks, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import styles from "./plan-card.module.css";

export interface PlanCardProps {
  busy?: boolean | undefined;
  onApprove?: (() => void) | undefined;
  onReject?: ((feedback: string) => void) | undefined;
  plan: PlanProposal;
  resolved?:
    | {
        approved: boolean;
        cancelled?: boolean;
        feedback?: string | undefined;
      }
    | undefined;
}

export function PlanCard({
  busy = false,
  onApprove,
  onReject,
  plan,
  resolved,
}: PlanCardProps) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");

  const handleFeedbackChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setFeedback(event.currentTarget.value);
    },
    []
  );

  const handleRejectSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = feedback.trim();
      if (!trimmed || busy) {
        return;
      }
      onReject?.(trimmed);
    },
    [busy, feedback, onReject]
  );

  const startRejecting = useCallback(() => {
    setRejecting(true);
  }, []);

  const cancelRejecting = useCallback(() => {
    setRejecting(false);
    setFeedback("");
  }, []);

  const riskClass = resolveRiskClass(plan.risk);

  return (
    <article aria-label="Execution Plan" className={styles.card}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <ListChecks aria-hidden="true" size={18} />
          <span>{plan.title}</span>
        </div>
        <span className={`${styles.riskBadge} ${riskClass}`}>
          {plan.risk} risk
        </span>
      </header>

      {plan.summary && <p className={styles.summary}>{plan.summary}</p>}

      {plan.rationale && (
        <blockquote className={styles.rationale}>{plan.rationale}</blockquote>
      )}

      {plan.steps && plan.steps.length > 0 && (
        <section className={styles.section}>
          <span className={styles.sectionLabel}>Execution Steps</span>
          <ol className={styles.steps}>
            {plan.steps.map((step, index) => (
              <li key={`${index}:${step}`}>{step}</li>
            ))}
          </ol>
        </section>
      )}

      {plan.files && plan.files.length > 0 && (
        <section className={styles.section}>
          <span className={styles.sectionLabel}>Affected Files</span>
          <ul className={styles.files}>
            {plan.files.map((file) => {
              const actionClass = resolveFileActionClass(file.action);
              return (
                <li className={styles.fileItem} key={file.path}>
                  <FileText aria-hidden="true" size={14} />
                  <span className={`${styles.fileBadge} ${actionClass}`}>
                    {file.action}
                  </span>
                  <span className={styles.filePath}>{file.path}</span>
                  {file.description && (
                    <span className={styles.fileDesc}>{file.description}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <PlanFooter
        busy={busy}
        cancelRejecting={cancelRejecting}
        feedback={feedback}
        handleFeedbackChange={handleFeedbackChange}
        handleRejectSubmit={handleRejectSubmit}
        onApprove={onApprove}
        onReject={onReject}
        rejecting={rejecting}
        resolved={resolved}
        startRejecting={startRejecting}
      />
    </article>
  );
}

function resolveFileActionClass(action: string): string {
  if (action === "create") {
    return styles.actionCreate ?? "";
  }
  if (action === "delete") {
    return styles.actionDelete ?? "";
  }
  return styles.actionModify ?? "";
}

function resolveRiskClass(risk: string): string {
  const lower = risk.toLowerCase();
  if (lower.includes("low")) {
    return styles.riskLow ?? "";
  }
  if (lower.includes("high")) {
    return styles.riskHigh ?? "";
  }
  return styles.riskMedium ?? "";
}

interface PlanFooterProps {
  busy: boolean;
  cancelRejecting: () => void;
  feedback: string;
  handleFeedbackChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleRejectSubmit: (event: FormEvent) => void;
  onApprove?: (() => void) | undefined;
  onReject?: ((feedback: string) => void) | undefined;
  rejecting: boolean;
  resolved?:
    | {
        approved: boolean;
        cancelled?: boolean;
        feedback?: string | undefined;
      }
    | undefined;
  startRejecting: () => void;
}

function PlanFooter({
  busy,
  cancelRejecting,
  feedback,
  handleFeedbackChange,
  handleRejectSubmit,
  onApprove,
  onReject,
  rejecting,
  resolved,
  startRejecting,
}: PlanFooterProps) {
  if (resolved) {
    return (
      <div
        className={`${styles.resolved} ${
          resolved.approved ? styles.resolvedApproved : styles.resolvedRejected
        }`}
      >
        <div className={styles.resolvedStatus}>
          {resolved.approved ? (
            <>
              <Check aria-hidden="true" size={16} />
              <span>Plan Approved</span>
            </>
          ) : (
            <>
              <X aria-hidden="true" size={16} />
              <span>
                {resolved.cancelled ? "Plan Cancelled" : "Plan Rejected"}
              </span>
            </>
          )}
        </div>
        {resolved.feedback && (
          <p className={styles.feedbackQuote}>Feedback: {resolved.feedback}</p>
        )}
      </div>
    );
  }

  if (!(onApprove && onReject)) {
    return null;
  }

  if (rejecting) {
    return (
      <form className={styles.rejectForm} onSubmit={handleRejectSubmit}>
        <textarea
          autoFocus
          className={styles.rejectTextarea}
          disabled={busy}
          onChange={handleFeedbackChange}
          placeholder="Explain why this plan is rejected or suggest changes…"
          rows={3}
          value={feedback}
        />
        <div className={styles.rejectActions}>
          <button
            className={styles.rejectButton}
            disabled={busy}
            onClick={cancelRejecting}
            type="button"
          >
            Cancel
          </button>
          <button
            className={styles.approveButton}
            disabled={busy || feedback.trim().length === 0}
            type="submit"
          >
            {busy ? "Submitting…" : "Submit Feedback"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className={styles.actions}>
      <button
        className={styles.rejectButton}
        disabled={busy}
        onClick={startRejecting}
        type="button"
      >
        Reject with Feedback
      </button>
      <button
        className={styles.approveButton}
        disabled={busy}
        onClick={onApprove}
        type="button"
      >
        {busy ? "Approving…" : "Approve Plan"}
      </button>
    </div>
  );
}
