"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import { useEffect, useState, type ReactNode } from 'react';
import { removeLegacyAuthStorage } from '@/lib/frontend-security.mjs';
import { AutoLoginGate } from "./auto-login-gate";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const [convex] = useState(() => new ConvexReactClient(
    typeof window === "undefined" ? "http://127.0.0.1:3210" : window.location.origin,
    { verbose: false },
  ));
  useEffect(() => { try { removeLegacyAuthStorage(window.localStorage, window.location.origin); } catch {} }, []);
  return (
    <ConvexAuthNextjsProvider client={convex}>
      <AutoLoginGate>{children}</AutoLoginGate>
    </ConvexAuthNextjsProvider>
  );
}
