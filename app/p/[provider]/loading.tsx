import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function ProviderLoading() {
  return (
    <SkeletonPage width="max-w-6xl" label="Loading provider report">
      <HeadingBlock />
      <TileGrid n={4} />
      <Bar className="mt-6 h-64 w-full rounded-[2rem]" />
      <Cards n={4} lines={5} />
    </SkeletonPage>
  );
}
