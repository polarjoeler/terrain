import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function CoverageLoading() {
  return (
    <SkeletonPage width="max-w-4xl" label="Loading coverage">
      <HeadingBlock />
      <Rows n={10} />
    </SkeletonPage>
  );
}
