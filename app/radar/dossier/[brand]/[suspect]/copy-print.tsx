"use client";

import { useState } from "react";

export function CopyPrint({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="flex flex-wrap gap-3 print:hidden">
      <button
        onClick={copy}
        className="rounded-full bg-cyan px-5 py-2.5 text-sm font-medium text-cyan-deep transition hover:brightness-110"
      >
        {copied ? "Copied ✓" : "Copy DMCA notice"}
      </button>
      <button
        onClick={() => window.print()}
        className="rounded-full border border-cream/20 px-5 py-2.5 text-sm text-cream/80 transition hover:border-cream/50"
      >
        Print / Save as PDF
      </button>
    </div>
  );
}
