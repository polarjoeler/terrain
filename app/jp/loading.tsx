import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function JpLoading() {
  return (
    <main className="mx-auto max-w-5xl px-5 py-8" aria-busy="true" aria-label="読み込み中">
      <Bar className="h-8 w-96 max-w-full" />
      <TileGrid n={4} />
      <Cards n={4} lines={6} />
    </main>
  );
}
