"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-fetch the server component on an interval so the ops page stays live without a manual
 *  reload — router.refresh() re-runs the RSC (fresh DB read) without losing scroll/state. */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
