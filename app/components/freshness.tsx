/** "Data updated X ago" — the visible freshness signal. Reads the newest
 *  discovery date from the feed, so if the pipeline stalls this stamp ages and
 *  staleness stops being silent. */

function timeAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function FreshnessStamp({
  updatedAt,
  live,
  className = "",
}: {
  updatedAt: string | null;
  live: boolean;
  className?: string;
}) {
  const stale =
    !!updatedAt && (Date.now() - new Date(updatedAt).getTime()) / 864e5 > 4;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs text-cream/40 ${className}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          !live || stale ? "bg-orange" : "bg-mint"
        }`}
      />
      {updatedAt ? `Data updated ${timeAgo(updatedAt)}` : "Live feed"}
    </span>
  );
}
