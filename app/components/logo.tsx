/** Terrain mark: two clean geometric peaks (a "range"), flat and modern —
 *  a solid, confident shape rather than thin contour lines. */
export function TerrainMark({ className = "h-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 34 26" fill="none" className={className} aria-hidden>
      {/* back peak (muted) */}
      <path d="M11 2.5 L22 23 H0 Z" fill="var(--color-orange-soft)" />
      {/* front peak (accent) */}
      <path d="M23 7 L34 23 H12 Z" fill="var(--color-orange)" />
    </svg>
  );
}

/** Wordmark: mark + clean sans "Terrain". `tone` is accepted for call-site
 *  compatibility; text colour is inherited from the parent. */
export function Wordmark({
  size = "text-xl",
}: {
  size?: string;
  tone?: "ink" | "cream";
}) {
  return (
    <span className="flex items-center gap-2.5">
      <TerrainMark className="h-[1.05em] w-auto" />
      <span className={`font-semibold tracking-tight ${size}`}>Terrain</span>
    </span>
  );
}
