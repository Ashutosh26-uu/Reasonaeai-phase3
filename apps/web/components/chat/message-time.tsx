"use client";

import { useEffect, useState } from "react";

/** Browser locale/timezone formatting must not differ during hydration. */
export function MessageTime({
  className,
  createdAt,
}: {
  className?: string;
  createdAt: string;
}) {
  const [formatted, setFormatted] = useState({ time: "", title: "" });
  useEffect(() => {
    const date = new Date(createdAt);
    setFormatted({
      time: new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(date),
      title: date.toLocaleString(),
    });
  }, [createdAt]);
  return (
    <time className={className} dateTime={createdAt} title={formatted.title}>
      {formatted.time}
    </time>
  );
}
