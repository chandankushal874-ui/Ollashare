import { Suspense } from "react";
import { WorkspaceProvider } from "@/lib/workspace-provider";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@v1/backend/convex/_generated/api";
import { fetchQuery } from "convex/nextjs";
import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { CommandPalette } from "./_components/command-palette";
import { Sidebar } from "./_components/sidebar";
import { Topbar } from "./_components/topbar";

export default async function Layout({
  children,
}: { children: React.ReactNode }) {
  let user: any = null;
  try {
    user = await fetchQuery(
      api.users.getUser,
      {},
      { token: await convexAuthNextjsToken() },
    );
  } catch {
    redirect("/login");
  }
  if (!user?.username) redirect("/login");
  return (
    <WorkspaceProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-secondary dark:bg-black lg:flex-row">
        <Suspense fallback={<aside className="hidden w-60 shrink-0 border-r border-border bg-card lg:block" />}>
          <Sidebar />
        </Suspense>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Topbar />
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </main>
      </div>
      <Toaster richColors position="top-right" />
      <CommandPalette />
    </WorkspaceProvider>
  );
}
