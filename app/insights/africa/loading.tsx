import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function AfricaLoading() {
  return (
    <SkeletonPage width="max-w-6xl" label="Loading Africa view">
      <HeadingBlock />
      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_18rem]">
        <Bar className="h-[28rem] w-full rounded-[2rem]" />
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => <Bar key={i} className="h-10 w-full rounded-xl" />)}
        </div>
      </div>
    </SkeletonPage>
  );
}
