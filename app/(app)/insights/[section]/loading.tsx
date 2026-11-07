import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function SectionLoading() {
  return (
    <SkeletonPage width="max-w-3xl" label="Loading report">
      <HeadingBlock />
      <Rows n={12} />
    </SkeletonPage>
  );
}
