"use client";

import { useState } from "react";

/** Turns a fraud cluster into a warm outreach lead: a pre-filled email to the
 *  victim brand ("someone's copying you"). We never auto-send — mailto opens the
 *  admin's client, or copy the body. */
export function Outreach({
  victim,
  victimName,
  victimEmail,
  clones,
}: {
  victim: string;
  victimName: string | null;
  victimEmail: string | null;
  clones: string[];
}) {
  const [copied, setCopied] = useState(false);
  const name = victimName || victim;
  const n = clones.length;
  const list = clones.slice(0, 8).map((c) => `  • ${c}`).join("\n");
  const more = clones.length > 8 ? `\n  …and ${clones.length - 8} more` : "";

  const subject = `${n} store${n === 1 ? "" : "s"} are copying ${name}'s catalogue`;
  const body =
    `Hi ${name} team,\n\n` +
    `We're Radar (part of Tembo Commerce). While monitoring the Shopify market we ` +
    `detected ${n} store${n === 1 ? "" : "s"} reproducing your product catalogue:\n\n` +
    `${list}${more}\n\n` +
    `Each shares dozens to hundreds of your exact product images. We can send you the ` +
    `full evidence pack (per-store image/SKU matches) and help you file takedowns.\n\n` +
    `Would you like the full report?\n\n` +
    `— Radar, Tembo Commerce\nhttps://radar.tembocommerce.app`;

  const mailto = `mailto:${victimEmail ?? ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(`To: ${victimEmail ?? "(no email on file)"}\nSubject: ${subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-cream/10 pt-4">
      {victimEmail ? (
        <a
          href={mailto}
          className="rounded-full bg-cyan px-4 py-1.5 text-xs font-medium text-cyan-deep transition hover:brightness-110"
        >
          ✉ Email {victimEmail}
        </a>
      ) : (
        <span className="text-xs text-cream/40">No email on file</span>
      )}
      <button
        onClick={copy}
        className="rounded-full border border-cream/20 px-4 py-1.5 text-xs text-cream/70 transition hover:border-cream/50"
      >
        {copied ? "Copied ✓" : "Copy outreach"}
      </button>
    </div>
  );
}
