import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function OnboardingLoading() {
  return (
    <main className="min-h-screen px-4 py-10" aria-busy="true" aria-label="Loading onboarding">
      <div className="mx-auto max-w-xl">
        <Bar className="h-9 w-56" />
        <Bar className="mt-3 h-4 w-full" />
        <div className="mt-8 space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Bar className="h-3 w-28" />
              <Bar className="mt-2 h-11 w-full rounded-xl" />
            </div>
          ))}
        </div>
        <Bar className="mt-8 h-11 w-40 rounded-full" />
      </div>
    </main>
  );
}
