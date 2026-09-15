// Shown instantly while insights recomputes on a soft navigation (filter/platform/market change),
// so a click always produces immediate feedback. Skeleton screens beat spinners: they give the
// eye the page's shape right away and make the wait feel shorter. Mirrors the real layout.
export default function InsightsLoading() {
  const bar = "animate-pulse rounded bg-cream/10";
  return (
    <main className="min-h-screen px-4 py-6 md:px-8" aria-busy="true" aria-label="Loading insights">
      <div className="mx-auto max-w-6xl">
        <div className={`${bar} h-8 w-64`} />
        <div className={`${bar} mt-3 h-4 w-96 max-w-full`} />

        {/* filter row */}
        <div className="mt-6 flex flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className={`${bar} h-9 w-28`} />)}
        </div>

        {/* KPI tiles */}
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-3xl border border-cream/10 p-5">
              <div className={`${bar} h-9 w-24`} />
              <div className={`${bar} mt-3 h-3 w-20`} />
            </div>
          ))}
        </div>

        {/* growth chart */}
        <div className={`${bar} mt-6 h-64 w-full rounded-[2rem]`} />

        {/* report cards */}
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-3xl border border-cream/10 p-5">
              <div className={`${bar} h-4 w-40`} />
              {Array.from({ length: 5 }).map((_, j) => <div key={j} className={`${bar} mt-3 h-3 w-full`} />)}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
