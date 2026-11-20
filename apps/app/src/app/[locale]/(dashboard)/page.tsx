"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated) {
      router.replace("/screenshare");
    } else {
      router.replace("/landing");
    }
  }, [isAuthenticated, isLoading, router]);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-400">
      <div className="flex items-center gap-2.5 text-sm">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
        Redirecting…
      </div>
    </div>
  );
}
