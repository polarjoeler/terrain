/** Terrain mark: stacked topographic contour lines — deliberately wide and flat,
 *  so the lockup never reads as a tall/vertical block. */
export function TerrainMark({ className = "h-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M1 15c8-6 14-6 22 0s14 6 20 0" />
      <path d="M5 10c7-5 12-5 18 0s12 5 17 0" opacity="0.65" />
      <path d="M11 5.5c5-3.5 9-3.5 13 0s9 3.5 12 0" opacity="0.4" />
      <circle cx="53" cy="9" r="3" fill="var(--color-orange)" stroke="none" />
    </svg>
  );
}

export function Wordmark({
  size = "text-xl",
  tone = "ink",
}: {
  size?: string;
  tone?: "ink" | "cream";
}) {
  return (
    <span className="flex items-center gap-2.5">
      <TerrainMark className="h-[1.1em] w-auto" />
      <span className={`font-display tracking-tight ${size}`}>Terrain</span>
      <span
        className={`hidden text-[10px] uppercase tracking-[0.18em] sm:inline ${
          tone === "cream" ? "text-cream/40" : "text-ink/40"
        }`}
      >
        by Tembo
      </span>
    </span>
  );
}
