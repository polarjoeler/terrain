import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function ScanLoading() {
  return (
    <main className="min-h-screen px-4 py-6" aria-busy="true" aria-label="Loading scan">
      <div className="mx-auto mt-3 max-w-md">
        <Bar className="mx-auto h-40 w-40 rounded-full" />
        <Bar className="mx-auto mt-6 h-5 w-48" />
        <Bar className="mx-auto mt-3 h-3 w-64 max-w-full" />
        <Rows n={3} h="h-10" />
      </div>
    </main>
  );
}
