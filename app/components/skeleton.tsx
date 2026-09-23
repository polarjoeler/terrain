/** Shared skeleton primitives.
 *
 *  The app had exactly one loading.tsx (insights), so every other navigation
 *  showed nothing at all until the server finished — which is most of why the
 *  UI felt dead. These pieces exist so each route's skeleton mirrors its real
 *  layout: a skeleton that matches the page's shape makes the wait feel shorter
 *  than a spinner, because the eye can start parsing structure immediately.
 *
 *  Keep them in the page's own proportions — a skeleton that doesn't match what
 *  lands is worse than none, because the layout visibly jumps on arrival.
 */

/** One shimmering placeholder. `w`/`h` are Tailwind classes, e.g. "h-8 w-64". */
export function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-cream/10 ${className}`} />;
}

/** Page title + standfirst, the shape almost every route opens with. */
export function HeadingBlock({ wide = false }: { wide?: boolean }) {
  return (
    <>
      <Bar className={wide ? "h-11 w-80 max-w-full" : "h-8 w-64 max-w-full"} />
      <Bar className="mt-3 h-4 w-96 max-w-full" />
    </>
  );
}

/** The 4-up KPI row used on the dashboard, insights and JP overview. */
export function TileGrid({ n = 4, cols = "md:grid-cols-4" }: { n?: number; cols?: string }) {
  return (
    <div className={`mt-6 grid grid-cols-2 gap-3 ${cols}`}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="rounded-3xl border border-cream/10 p-5">
          <Bar className="h-9 w-24" />
          <Bar className="mt-3 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Stack of list/table rows. */
export function Rows({ n = 8, h = "h-12" }: { n?: number; h?: string }) {
  return (
    <div className="mt-2 space-y-2">
      {Array.from({ length: n }).map((_, i) => (
        <Bar key={i} className={`${h} w-full rounded-lg`} />
      ))}
    </div>
  );
}

/** Bordered card holding a title and a few lines — the report-card shape. */
export function Cards({ n = 4, lines = 5, cols = "md:grid-cols-2" }: { n?: number; lines?: number; cols?: string }) {
  return (
    <div className={`mt-6 grid grid-cols-1 gap-4 ${cols}`}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="rounded-3xl border border-cream/10 p-5">
          <Bar className="h-4 w-40" />
          {Array.from({ length: lines }).map((_, j) => (
            <Bar key={j} className="mt-3 h-3 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Standard page frame. `width` is the max-w class the real page uses, so the
 *  skeleton occupies the same column and nothing shifts when content lands. */
export function SkeletonPage({
  width = "max-w-6xl",
  label,
  children,
}: {
  width?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen px-4 py-6 md:px-8" aria-busy="true" aria-label={label}>
      <div className={`mx-auto ${width}`}>{children}</div>
    </main>
  );
}
