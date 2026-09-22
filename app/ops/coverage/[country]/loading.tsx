import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function CountryLoading() {
  return (
    <SkeletonPage width="max-w-4xl" label="Loading country coverage">
      <HeadingBlock />
      <Rows n={10} />
    </SkeletonPage>
  );
}
