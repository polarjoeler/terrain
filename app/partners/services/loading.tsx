import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function ServicesLoading() {
  return (
    <SkeletonPage width="max-w-4xl" label="Loading service partners">
      <HeadingBlock />
      <Cards n={6} lines={3} />
    </SkeletonPage>
  );
}
