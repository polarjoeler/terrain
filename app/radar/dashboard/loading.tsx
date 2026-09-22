import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function DashboardLoading() {
  return (
    <SkeletonPage width="max-w-4xl" label="Loading Radar">
      <HeadingBlock />
      <Cards n={4} lines={4} cols={'md:grid-cols-1'} />
    </SkeletonPage>
  );
}
