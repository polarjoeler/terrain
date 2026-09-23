import { SkeletonPage, HeadingBlock, TileGrid, Rows, Cards, Bar } from "@/app/components/skeleton";

export default function SuspectLoading() {
  return (
    <SkeletonPage width="max-w-4xl" label="Loading dossier">
      <HeadingBlock />
      <TileGrid n={4} />
      <Bar className="mt-6 h-64 w-full rounded-[2rem]" />
      <Cards n={4} lines={5} />
    </SkeletonPage>
  );
}
