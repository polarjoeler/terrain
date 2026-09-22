import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function AdminLoading() {
  return (
    <SkeletonPage width="max-w-6xl" label="Loading admin">
      <HeadingBlock />
      <Rows n={10} />
    </SkeletonPage>
  );
}
