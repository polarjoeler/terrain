import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function OpsLoading() {
  return (
    <SkeletonPage width="max-w-lg" label="Loading ops">
      <HeadingBlock />
      <Rows n={6} />
    </SkeletonPage>
  );
}
