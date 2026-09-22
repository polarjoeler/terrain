import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function SwitchesLoading() {
  return (
    <SkeletonPage width="max-w-3xl" label="Loading switches">
      <HeadingBlock />
      <Rows n={10} />
    </SkeletonPage>
  );
}
