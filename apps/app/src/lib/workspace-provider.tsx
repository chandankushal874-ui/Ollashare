"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { createContext, useContext, useEffect, useRef, useState } from "react";

type WS = { _id: Id<"workspaces">; name: string; role: string };
type Ctx = {
  workspaces: WS[];
  current: Id<"workspaces"> | null;
  select: (id: Id<"workspaces">) => void;
};

const WorkspaceCtx = createContext<Ctx>({ workspaces: [], current: null, select: () => {} });
export const useWorkspace = () => useContext(WorkspaceCtx);

/**
 * Holds the current workspace in React context (persisted to localStorage) so the sidebar
 * switcher and every page share it reactively — switching updates all consumers at once.
 */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.getUser, !isLoading && isAuthenticated ? {} : 'skip');
  const canManage = !!user && !user.isAnonymous;
  const workspaces = useQuery(api.orgs.myWorkspaces, canManage ? {} : 'skip') as WS[] | undefined;
  const ensure = useMutation(api.orgs.ensureWorkspace);
  const [current, setCurrent] = useState<Id<"workspaces"> | null>(null);
  const ensuringRef = useRef(false);

  useEffect(() => {
    // No fake fallback: until a real workspace is ensured/loaded, `current`
    // stays null so callers (e.g. createRoom) can't act on a non-existent ID.
    if (isLoading || !isAuthenticated || !canManage || workspaces === undefined) return;
    if (workspaces.length === 0) {
      if (!ensuringRef.current) {
        ensuringRef.current = true;
        ensure({})
          .then((wsId) => {
            if (wsId) {
              setCurrent(wsId);
              if (typeof window !== "undefined") window.localStorage.setItem("ws", wsId);
            }
          })
          .catch(() => {})
          .finally(() => {
            ensuringRef.current = false;
          });
      }
      return;
    }
    setCurrent((prev) => {
      if (prev && workspaces.some((w) => w._id === prev)) return prev;
      const saved = typeof window !== "undefined" ? window.localStorage.getItem("ws") : null;
      const match = workspaces.find((w) => w._id === saved);
      return match?._id ?? workspaces[0]?._id ?? null;
    });
  }, [workspaces, ensure, isLoading, isAuthenticated, canManage]);

  const select = (id: Id<"workspaces">) => {
    if (typeof window !== "undefined") window.localStorage.setItem("ws", id);
    setCurrent(id);
  };

  return (
    <WorkspaceCtx.Provider value={{ workspaces: workspaces ?? [], current, select }}>
      {children}
    </WorkspaceCtx.Provider>
  );
}
