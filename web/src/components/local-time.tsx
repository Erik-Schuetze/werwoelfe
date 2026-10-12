"use client";

import { useEffect, useState } from "react";

/**
 * Formatting a timestamp with the viewer's locale and timezone cannot match the
 * server's render (the container is UTC and en_US; the browser is neither), so
 * the server always renders a deterministic UTC stamp and the local form is
 * applied once mounted. Without this the page throws a hydration error.
 */
export function LocalTime({ value, dateStyle = "medium" }: { value: string; dateStyle?: "medium" | "short" }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <time dateTime={value} suppressHydrationWarning>
      {mounted
        ? new Intl.DateTimeFormat(undefined, { dateStyle, timeStyle: "short" }).format(new Date(value))
        : `${new Date(value).toISOString().slice(0, 16).replace("T", " ")}Z`}
    </time>
  );
}
