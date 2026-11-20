"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { Crown, HelpCircle, LogOut, Shield } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { NotificationsBell } from "./notifications-bell";

const APP_VERSION = "1.0.0-PROD";
const TITLES: Record<string, string> = {
  "/": "Screenshare Studio",
  "/screenshare": "Screenshare Studio",
  "/activity": "Live Sessions & Activity Audit",
  "/settings": "Settings",
};

export function Topbar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { signOut } = useAuthActions();
  const isGuest = searchParams?.get("role") === "guest";
  const title = TITLES[pathname] ?? "Dashboard";
  const handleLogOut = async () => {
    try {
      await signOut();
    } finally {
      window.location.href = "/login";
    }
  };
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-6">
      <nav className="flex items-center gap-1.5 text-sm">
        <span className="text-primary/40 font-mono">ollashare</span>
        <span className="text-primary/30">/</span>
        <span className="font-medium text-primary/80">{title}</span>
        {isGuest ? (
          <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-xs text-amber-400 font-medium">
            <Shield className="h-3 w-3" /> Guest Mode
          </span>
        ) : (
          <span className="ml-2 inline-flex items-center gap-1 rounded bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 text-xs text-sky-400 font-medium">
            <Crown className="h-3 w-3" /> Host Controller
          </span>
        )}
      </nav>
      <div className="flex items-center gap-3 text-xs text-primary/40">
        <NotificationsBell />
        <span className="hidden sm:inline">v{APP_VERSION}</span>
        <a
          href="https://github.com/get-convex/v1/tree/main/docs"
          target="_blank"
          rel="noreferrer"
          className="hidden items-center gap-1.5 hover:text-primary sm:flex"
        >
          <HelpCircle className="h-4 w-4" /> Help
        </a>
        {!isGuest && (
          <button
            type="button"
            onClick={handleLogOut}
            className="flex items-center gap-1.5 rounded-lg bg-primary/5 px-2.5 py-2 font-semibold text-primary/70 transition hover:bg-red-500/10 hover:text-red-500"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Log out</span>
          </button>
        )}
      </div>
    </header>
  );
}
