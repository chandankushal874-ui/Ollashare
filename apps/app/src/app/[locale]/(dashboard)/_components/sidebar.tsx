"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@v1/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { LogOut, Menu, ScreenShare, Settings, ShieldCheck, X } from "lucide-react";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ThemeSwitcher } from "./theme-switcher";

const NAV = [
  { href: "/screenshare", label: "Screenshare Studio", icon: ScreenShare },
  { href: "/activity", label: "Live Sessions & Audit", icon: ShieldCheck },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isGuest = searchParams?.get("role") === "guest";
  const { signOut } = useAuthActions();
  const user = useQuery(api.users.getUser, isGuest ? "skip" : {});
  const [open, setOpen] = useState(false);

  const displayName = isGuest ? "Guest Participant" : user?.name || "Ollashare Host";
  const displayEmail = isGuest ? "guest-view@ollashare.app" : user?.email || "";

  const handleLogOut = async () => {
    try {
      await signOut();
    } catch {}
    window.location.href = "/login";
  };

  const Body = (
    <div className="flex h-full w-60 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
        <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xs shadow-sm">
          O
        </div>
        <div className="flex flex-col">
          <span className="font-semibold text-sm leading-tight text-primary">
            Ollashare Screenshare
          </span>
          <span className="text-[10px] text-sky-400 font-mono">
            WebRTC • P2P
          </span>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV.map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
                active
                  ? "bg-sky-500/10 font-medium text-sky-400"
                  : "text-primary/70 hover:bg-primary/5 hover:text-primary"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <div className="mb-2 flex items-center gap-2">
          {user?.avatarUrl ? (
            // biome-ignore lint/a11y/useAltText: decorative avatar
            <img
              src={user.avatarUrl}
              alt=""
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <span className="h-8 w-8 shrink-0 rounded-full bg-gradient-to-br from-sky-400 via-indigo-400 to-purple-500 flex items-center justify-center text-[10px] font-bold text-white">
              {displayName.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-sm font-medium text-primary/80">
                {displayName}
              </p>
              {isGuest && (
                <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1 text-[9px] text-amber-400 font-semibold">
                  Guest
                </span>
              )}
            </div>
            <p className="truncate text-xs text-primary/50">{displayEmail}</p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <ThemeSwitcher />
          <button
            type="button"
            onClick={handleLogOut}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-primary/60 hover:bg-primary/5 hover:text-primary"
          >
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="flex h-14 items-center gap-3 border-b border-border bg-card px-4 lg:hidden">
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="h-6 w-6 rounded bg-sky-500 flex items-center justify-center text-white text-xs font-bold">
          O
        </div>
        <span className="font-semibold text-sm">Ollashare Screenshare</span>
      </div>

      <aside className="sticky top-0 hidden h-screen shrink-0 lg:block">
        {Body}
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 cursor-default bg-black/50"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full shadow-xl">
            <button
              type="button"
              aria-label="Close menu"
              className="absolute -right-9 top-3 text-white"
              onClick={() => setOpen(false)}
            >
              <X className="h-6 w-6" />
            </button>
            {Body}
          </div>
        </div>
      )}
    </>
  );
}
