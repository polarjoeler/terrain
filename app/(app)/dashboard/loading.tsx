import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

/** Dashboard shell. Six sequential DB round-trips run before the page can
 *  render (user, subscriber, profile, org, markets, stats), so without this the
 *  browser sat on a blank document for the whole wait. */
export default function DashboardLoading() {
  return (
    <div className="min-h-screen px-4 py-6 md:px-8" aria-busy="true" aria-label="Loading dashboard">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-3">
          <Bar className="h-7 w-28" />
          <div className="flex items-center gap-2">
            <Bar className="h-8 w-24 rounded-full" />
            <Bar className="h-8 w-24 rounded-full" />
            <Bar className="h-9 w-9 rounded-full" />
          </div>
        </div>

        <div className="mt-10">
          <Bar className="h-12 w-72 max-w-full" />
          <Bar className="mt-3 h-4 w-[28rem] max-w-full" />
          <Bar className="mt-3 h-3 w-40" />
        </div>

        <TileGrid n={4} />
      </div>

      <div className="mx-auto mt-10 max-w-[1600px]">
        <Bar className="h-7 w-44" />
        <div className="mt-3 flex gap-4">
          <Bar className="hidden h-96 w-48 shrink-0 rounded-2xl md:block" />
          <div className="flex-1">
            <Bar className="h-10 w-full rounded-xl" />
            <Rows n={9} />
          </div>
        </div>
      </div>
    </div>
  );
}
