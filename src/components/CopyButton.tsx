"use client";
import { useState } from "react";

export function CopyButton({ text, label = "Copy citation" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2500);
      }}
      aria-live="polite"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select text below" : label}
    </button>
  );
}
