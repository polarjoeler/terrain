import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function BillingLoading() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16" aria-busy="true" aria-label="Loading billing">
      <div className="w-full max-w-2xl">
        <Bar className="mx-auto h-11 w-72 max-w-full" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-[2rem] border border-cream/10 p-8">
              <Bar className="h-5 w-24" />
              <Bar className="mt-4 h-10 w-32" />
              <Bar className="mt-6 h-3 w-full" />
              <Bar className="mt-2 h-3 w-5/6" />
              <Bar className="mt-6 h-10 w-full rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
