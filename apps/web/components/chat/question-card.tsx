"use client";

import { MessageCircleQuestion } from "lucide-react";
import { type ChangeEvent, type FormEvent, useId } from "react";
import styles from "./question-card.module.css";

export function QuestionCard({
  question,
  value,
  busy,
  limit,
  onChange,
  onSubmit,
}: {
  question: string;
  value: string;
  busy: boolean;
  limit: number;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const id = useId();
  return (
    <form
      aria-label="Answer the CTO"
      className={styles.card}
      onSubmit={onSubmit}
    >
      <div className={styles.heading}>
        <MessageCircleQuestion aria-hidden="true" size={17} />
        <span>A question for you</span>
      </div>
      <label className={styles.question} htmlFor={id}>
        {question}
      </label>
      <textarea
        autoFocus
        disabled={busy}
        id={id}
        maxLength={limit}
        onChange={onChange}
        placeholder="Your answer…"
        rows={2}
        value={value}
      />
      <div className={styles.actions}>
        <span>The CTO will continue with your answer.</span>
        <button disabled={busy || value.trim().length === 0} type="submit">
          {busy ? "Sending…" : "Continue"}
        </button>
      </div>
    </form>
  );
}
