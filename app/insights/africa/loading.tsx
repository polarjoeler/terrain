import { SkeletonPage, HeadingBlock, Bar } from "@/app/components/skeleton";

export default function AfricaLoading() {
  return (
    <SkeletonPage width="max-w-6xl" label="Loading Africa view">
      <HeadingBlock />
      <Bar className="mt-6 h-20 w-full rounded-3xl" />
      <div className="mt-5 grid gap-6 md:grid-cols-[1fr_18rem]">
        <Bar className="h-[28rem] w-full rounded-[2rem]" />
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => <Bar key={i} className="h-10 w-full rounded-xl" />)}
        </div>
      </div>
      <Bar className="mt-6 h-40 w-full rounded-[2rem]" />
    </SkeletonPage>
  );
}
