"use client";

import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import styles from "./message-minimap.module.css";
import type { MessageNavigationItem } from "./message-navigation";

// Visual reference: https://chanhdai.com/components/toc-minimap.
// Chat-specific implementation uses the transcript's scroll container and message identities.
export function MessageMinimap({ items }: { items: MessageNavigationItem[] }) {
  const { contentRef, scrollRef, stopScroll } = useStickToBottomContext();
  const [activeId, setActiveId] = useState<string>();
  const [open, setOpen] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = "chat-message-minimap-list";

  useEffect(() => {
    const root = scrollRef.current;
    const content = contentRef.current;
    if (!(root && content)) {
      return;
    }
    const targets = items.flatMap((item) => {
      const element = document.getElementById(item.id);
      return element && content.contains(element) ? [element] : [];
    });
    let frame = 0;
    const update = () => {
      frame = 0;
      const threshold = root.getBoundingClientRect().top + 80;
      let current = targets[0]?.id;
      for (const target of targets) {
        if (target.getBoundingClientRect().top > threshold) {
          break;
        }
        current = target.id;
      }
      setActiveId(current);
    };
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(update);
      }
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    root.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener("scroll", schedule);
    };
  }, [items, contentRef, scrollRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !navigation.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const dismissKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        navigation.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissKey);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissKey);
    };
  }, [open]);

  const show = useCallback(() => setOpen(true), []);
  const hasItems = items.length > 0;
  useEffect(() => {
    const root = navigation.current;
    if (!(hasItems && root)) {
      return;
    }
    const leave = () => {
      if (!root.contains(document.activeElement)) {
        setOpen(false);
      }
    };
    const blur = (event: FocusEvent) => {
      if (
        !(
          event.relatedTarget instanceof Node &&
          root.contains(event.relatedTarget)
        )
      ) {
        setOpen(false);
      }
    };
    root.addEventListener("mouseenter", show);
    root.addEventListener("mouseleave", leave);
    root.addEventListener("focusout", blur);
    return () => {
      root.removeEventListener("mouseenter", show);
      root.removeEventListener("mouseleave", leave);
      root.removeEventListener("focusout", blur);
    };
  }, [hasItems, show]);
  const jump = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.dataset.messageId;
      if (!id) {
        return;
      }
      const target = document.getElementById(id);
      const root = scrollRef.current;
      if (!(target && root && contentRef.current?.contains(target))) {
        return;
      }
      stopScroll();
      root.scrollTo({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        top:
          root.scrollTop +
          target.getBoundingClientRect().top -
          root.getBoundingClientRect().top -
          24,
      });
      target.focus({ preventScroll: true });
      setActiveId(id);
      setOpen(false);
    },
    [contentRef, scrollRef, stopScroll]
  );

  if (!items.length) {
    return null;
  }
  return (
    <nav aria-label="Your messages" className={styles.minimap} ref={navigation}>
      <button
        aria-controls={listId}
        aria-expanded={open}
        aria-label={`Jump to a message (${items.length} messages)`}
        className={styles.rail}
        data-open={open}
        onClick={show}
        ref={trigger}
        type="button"
      >
        {items.map((item) => (
          <span
            className={styles.mark}
            data-active={item.id === activeId}
            key={item.id}
          />
        ))}
      </button>
      <div className={styles.panel} hidden={!open} id={listId}>
        <div className={styles.heading}>
          Your messages <span>{items.length}</span>
        </div>
        <ol className={styles.list}>
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                aria-current={item.id === activeId ? "location" : undefined}
                aria-label={`Jump to message ${index + 1}: ${item.title}`}
                className={styles.item}
                data-message-id={item.id}
                onClick={jump}
                type="button"
              >
                <span aria-hidden="true" className={styles.number}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className={styles.preview}>{item.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}
