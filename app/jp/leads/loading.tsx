import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function LeadsLoading() {
  return (
    <SkeletonPage width="max-w-5xl" label="Loading JP leads">
      <HeadingBlock />
      <Rows n={10} />
    </SkeletonPage>
  );
}
