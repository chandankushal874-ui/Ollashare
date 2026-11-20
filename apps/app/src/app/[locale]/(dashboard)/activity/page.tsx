"use client";

import { WorkspaceAnalyticsPanel } from "@/components/analytics/workspace-analytics-panel";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Filter,
  History,
  LineChart,
  Lock,
  LogOut,
  Maximize2,
  Monitor,
  Play,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Square,
  Unlock,
  UserCheck,
  UserMinus,
  Users,
  Video,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export default function ActivityAndSessionsPage() {
  const { current: workspaceId, workspaces } = useWorkspace();
  const currentUser = useQuery(api.users.getUser);
  const myUserId = currentUser?._id;

  const currentRole = workspaces.find((w) => w._id === workspaceId)?.role;
  const isWorkspaceAdmin = currentRole === "owner" || currentRole === "admin";

  const [activeTab, setActiveTab] = useState<"sessions" | "audit" | "analytics">("sessions");
  const [auditCategory, setAuditCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Room limits modal state
  const [editingRoom, setEditingRoom] = useState<{
    code: string;
    maxViewers: number;
    maxSharers: number;
  } | null>(null);

  // Force end confirmation modal state
  const [endingRoom, setEndingRoom] = useState<{
    code: string;
    title: string;
  } | null>(null);
  const [endReason, setEndReason] = useState<string>("Administrative cleanup");

  // Expanded audit log meta state
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  // Convex Queries
  const activeRooms = useQuery(
    api.screenshare.listAllActiveRoomsWithDetails,
    workspaceId ? { workspaceId: workspaceId as Id<"workspaces"> } : "skip",
  );

  const auditLogs = useQuery(
    api.audit.listAuditLogs,
    workspaceId
      ? {
        workspaceId: workspaceId as Id<"workspaces">,
        category: auditCategory,
        search: searchQuery || undefined,
        limit: 60,
      }
      : "skip",
  );

  // Convex Mutations
  const setRoomLockMutation = useMutation(api.screenshare.setRoomLock);
  const setRoomLimitsMutation = useMutation(api.screenshare.setRoomLimits);
  const forceEndRoomMutation = useMutation(api.screenshare.forceEndRoom);
  const kickParticipantMutation = useMutation(api.screenshare.kickParticipant);

  // Derived Stats
  const stats = useMemo(() => {
    const rooms = activeRooms ?? [];
    const totalViewers = rooms.reduce((acc, r) => acc + (r.viewerCount || 0), 0);
    const totalSharers = rooms.reduce((acc, r) => acc + (r.sharerCount || 0), 0);
    const lockedRooms = rooms.filter((r) => r.isLocked).length;
    return {
      roomCount: rooms.length,
      totalViewers,
      totalSharers,
      lockedRooms,
    };
  }, [activeRooms]);

  // Handlers
  const handleToggleLock = async (code: string, currentLocked: boolean) => {
    try {
      await setRoomLockMutation({ code, locked: !currentLocked });
      toast.success(
        !currentLocked
          ? `Room ${code} locked. No new guests can join.`
          : `Room ${code} unlocked.`,
      );
    } catch (err: any) {
      toast.error(err?.message || "Failed to update room lock status");
    }
  };

  const handleKick = async (
    roomCode: string,
    viewerId: string,
    name: string,
  ) => {
    try {
      await kickParticipantMutation({
        roomCode,
        viewerId: viewerId as Id<"users">,
      });
      toast.success(`${name} removed from room ${roomCode}.`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to remove participant");
    }
  };

  const handleSaveLimits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRoom) return;
    try {
      await setRoomLimitsMutation({
        code: editingRoom.code,
        maxViewers: editingRoom.maxViewers,
        maxSharers: editingRoom.maxSharers,
      });
      toast.success(`Limits updated for room ${editingRoom.code}`);
      setEditingRoom(null);
    } catch (err: any) {
      toast.error(err?.message || "Failed to save limits");
    }
  };

  const handleConfirmEndRoom = async () => {
    if (!endingRoom) return;
    try {
      await forceEndRoomMutation({
        code: endingRoom.code,
        reason: endReason,
      });
      toast.success(`Room ${endingRoom.code} closed successfully.`);
      setEndingRoom(null);
    } catch (err: any) {
      toast.error(err?.message || "Failed to close room");
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col bg-slate-950 text-slate-100">
      {/* Page Header */}
      <div className="border-b border-slate-800 bg-slate-900/60 px-6 py-6 backdrop-blur">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-sky-400">
              <ShieldCheck className="h-4 w-4" />
              Administrative Governance
            </div>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
              Live Sessions & Audit Trail
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Real-time room monitoring, participant access controls, and security audit log streams.
            </p>
          </div>

          {/* Tab Selector */}
          <div className="flex items-center rounded-xl border border-slate-800 bg-slate-950 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("sessions")}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${activeTab === "sessions"
                  ? "bg-sky-500 text-white shadow-lg shadow-sky-500/25"
                  : "text-slate-400 hover:text-slate-200"
                }`}
            >
              <Video className="h-4 w-4" />
              Live Sessions ({stats.roomCount})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("audit")}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${activeTab === "audit"
                  ? "bg-sky-500 text-white shadow-lg shadow-sky-500/25"
                  : "text-slate-400 hover:text-slate-200"
                }`}
            >
              <History className="h-4 w-4" />
              Audit Trail ({auditLogs?.length ?? 0})
            </button>
            {isWorkspaceAdmin && (
              <button
                type="button"
                onClick={() => setActiveTab("analytics")}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${activeTab === "analytics"
                    ? "bg-sky-500 text-white shadow-lg shadow-sky-500/25"
                    : "text-slate-400 hover:text-slate-200"
                  }`}
              >
                <LineChart className="h-4 w-4" />
                Analytics
              </button>
            )}
          </div>
        </div>

        {/* Quick Metrics Bar */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex items-center gap-3 rounded-xl border border-slate-800/80 bg-slate-900/80 p-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              <Monitor className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-400">Active Rooms</p>
              <p className="text-lg font-bold text-white">{stats.roomCount}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-slate-800/80 bg-slate-900/80 p-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-400">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-400">Live Viewers</p>
              <p className="text-lg font-bold text-white">{stats.totalViewers}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-slate-800/80 bg-slate-900/80 p-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-400">
              <Video className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-400">Screen Sharers</p>
              <p className="text-lg font-bold text-white">{stats.totalSharers}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-slate-800/80 bg-slate-900/80 p-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-400">Locked Rooms</p>
              <p className="text-lg font-bold text-white">{stats.lockedRooms}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 p-6">
        {activeTab === "sessions" ? (
          /* ========================================================================= */
          /* TAB 1: LIVE SESSIONS MANAGEMENT                                            */
          /* ========================================================================= */
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">
                  Active Screen Share Rooms
                </h2>
                <p className="text-xs text-slate-400">
                  Manage active rooms, kick participants, lock gates, and enforce viewer/sharer quotas.
                </p>
              </div>

              <Link
                href="/screenshare"
                className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/25 transition hover:bg-sky-400"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Open Screenshare Studio
              </Link>
            </div>

            {activeRooms === undefined ? (
              <div className="flex items-center justify-center py-20 text-slate-500">
                <span className="h-2 w-2 animate-ping rounded-full bg-sky-400 mr-2" />
                Loading active rooms…
              </div>
            ) : activeRooms.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 text-slate-400">
                  <Monitor className="h-7 w-7" />
                </div>
                <h3 className="text-base font-semibold text-white">No Active Rooms</h3>
                <p className="mt-1 max-w-sm text-xs text-slate-400">
                  There are currently no active screenshare sessions. Start one from the Screenshare Studio.
                </p>
                <Link
                  href="/screenshare"
                  className="mt-4 flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-sky-400"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  Create Room
                </Link>
              </div>
            ) : (
              <div className="grid gap-5 md:grid-cols-2">
                {activeRooms.map((room) => {
                  const isHost = room.hostId === myUserId;
                  const canManageRoom = isHost || isWorkspaceAdmin;
                  const maxV = room.maxViewers ?? 25;
                  const maxS = room.maxSharers ?? 4;
                  return (
                    <div
                      key={room._id}
                      className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl transition hover:border-slate-700"
                    >
                      {/* Room Header */}
                      <div className="flex items-start justify-between gap-3 border-b border-slate-800/80 pb-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-bold text-sky-400">
                              {room.code}
                            </span>
                            <span className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                              LIVE
                            </span>
                            {room.isLocked && (
                              <span className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                                <Lock className="h-3 w-3" /> LOCKED
                              </span>
                            )}
                          </div>
                          <h3 className="mt-1 text-sm font-semibold text-white">
                            {room.title}
                          </h3>
                          <p className="text-xs text-slate-400">
                            Host: <strong className="text-slate-200">{room.hostName}</strong>
                          </p>
                        </div>

                        {/* Room Actions */}
                        {canManageRoom && (
                          <div className="flex items-center gap-1.5">
                            {/* Lock / Unlock Toggle */}
                            <button
                              type="button"
                              onClick={() => handleToggleLock(room.code, Boolean(room.isLocked))}
                              className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${room.isLocked
                                  ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                                  : "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
                                }`}
                              title={room.isLocked ? "Unlock room" : "Lock room (prevent new guests)"}
                            >
                              {room.isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                              <span className="hidden sm:inline">
                                {room.isLocked ? "Locked" : "Lock"}
                              </span>
                            </button>

                            {/* Limits Config Modal */}
                            <button
                              type="button"
                              onClick={() =>
                                setEditingRoom({
                                  code: room.code,
                                  maxViewers: maxV,
                                  maxSharers: maxS,
                                })
                              }
                              className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700"
                              title="Configure room limits"
                            >
                              <Sliders className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">Limits</span>
                            </button>

                            {/* Force End Room */}
                            <button
                              type="button"
                              onClick={() =>
                                setEndingRoom({
                                  code: room.code,
                                  title: room.title,
                                })
                              }
                              className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/20"
                              title="End session immediately"
                            >
                              <Square className="h-3 w-3 fill-current" />
                              <span className="hidden sm:inline">End</span>
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Quotas & Badges */}
                      <div className="mt-3.5 flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-slate-300">
                          Viewers: <strong className="text-white">{room.viewerCount}</strong> / {maxV}
                        </span>
                        <span className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-slate-300">
                          Sharers: <strong className="text-white">{room.sharerCount}</strong> / {maxS}
                        </span>
                        <span className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 font-mono text-[11px] text-slate-400">
                          {room.resolution} • {room.fps} FPS • {room.codec}
                        </span>
                      </div>

                      {/* Participants Table */}
                      <div className="mt-4 flex-1">
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                          Connected Participants ({room.viewers?.length || 0})
                        </p>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                          {(!room.viewers || room.viewers.length === 0) ? (
                            <p className="text-xs text-slate-500">No viewers connected.</p>
                          ) : (
                            room.viewers.map((v) => (
                              <div
                                key={v.id}
                                className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-slate-950/70 px-3 py-2 text-xs"
                              >
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[10px] font-bold text-slate-200">
                                    {(v.name || "?").charAt(0).toUpperCase()}
                                  </span>
                                  <span className="truncate font-medium text-slate-200">
                                    {v.name}
                                  </span>
                                  {v.role === "host" && (
                                    <span className="rounded border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.2 font-mono text-[9px] text-sky-400">
                                      HOST
                                    </span>
                                  )}
                                  {v.isSharing ? (
                                    <span className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.2 font-mono text-[9px] text-emerald-400">
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                      SHARING
                                    </span>
                                  ) : (
                                    <span className="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.2 font-mono text-[9px] text-slate-400">
                                      VIEWING
                                    </span>
                                  )}
                                </div>

                                {/* Kick Button (host/admin only, cannot kick host) */}
                                {canManageRoom && v.role !== "host" && (
                                  <button
                                    type="button"
                                    onClick={() => handleKick(room.code, v.viewerId, v.name)}
                                    className="flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/20"
                                    title="Remove participant from room"
                                  >
                                    <UserMinus className="h-3 w-3" />
                                    Kick
                                  </button>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      {/* Join Studio Link */}
                      <div className="mt-4 border-t border-slate-800/80 pt-3 flex justify-end">
                        <Link
                          href={`/screenshare?room=${room.code}`}
                          className="flex items-center gap-1.5 text-xs font-semibold text-sky-400 hover:text-sky-300"
                        >
                          Join Studio Session <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : activeTab === "analytics" && isWorkspaceAdmin && workspaceId ? (
          <WorkspaceAnalyticsPanel workspaceId={workspaceId as Id<"workspaces">} />
        ) : (
          /* ========================================================================= */
          /* TAB 2: ACTIVITY LOGS & AUDIT TRAIL                                         */
          /* ========================================================================= */
          <div className="space-y-6">
            {/* Filter and Search Bar */}
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              {/* Category Pills */}
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: "all", label: "All Events" },
                  { id: "screenshare", label: "Screen Shares" },
                  { id: "rooms", label: "Room Events" },
                  { id: "security", label: "Security & Denials" },
                  { id: "auth", label: "Authentication" },
                  { id: "roles", label: "Roles & Admin" },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setAuditCategory(cat.id)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${auditCategory === cat.id
                        ? "bg-sky-500 text-white shadow-md shadow-sky-500/20"
                        : "border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                      }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {/* Search Field */}
              <div className="relative w-full md:w-72">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter logs by user, action, room…"
                  className="w-full rounded-lg border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-xs text-white placeholder-slate-500 outline-none transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              </div>
            </div>

            {/* Audit Logs Stream */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl overflow-hidden">
              <div className="border-b border-slate-800 px-5 py-3.5 flex items-center justify-between text-xs font-semibold text-slate-400">
                <span>Timestamp & Event</span>
                <span>Actor / Administrator</span>
              </div>

              {auditLogs === undefined ? (
                <div className="p-12 text-center text-xs text-slate-500">
                  Loading activity trail…
                </div>
              ) : auditLogs.length === 0 ? (
                <div className="p-12 text-center">
                  <Shield className="mx-auto mb-2 h-8 w-8 text-slate-600" />
                  <p className="text-sm font-semibold text-slate-300">No Audit Events Found</p>
                  <p className="mt-1 text-xs text-slate-500">
                    No logs match your filter criteria. Events are recorded continuously.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-800/80">
                  {auditLogs.map((log) => {
                    const isExpanded = expandedLogId === log._id;
                    const date = new Date(log.at);
                    const formattedTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const formattedDate = date.toLocaleDateString();

                    // Categorize badge styling
                    const isCritical =
                      log.action.includes("denied") ||
                      log.action.includes("failed") ||
                      log.action.includes("kick") ||
                      log.action.includes("force_end");
                    const isCreation = log.action.includes("create") || log.action.includes("start");
                    const isLock = log.action.includes("lock") || log.action.includes("set_limits");

                    return (
                      <div
                        key={log._id}
                        className="p-4 transition hover:bg-slate-800/30 text-xs"
                      >
                        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                          {/* Left: Action and Timestamp */}
                          <div className="flex items-start gap-3">
                            <span
                              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${isCritical
                                  ? "border border-red-500/30 bg-red-500/10 text-red-400"
                                  : isCreation
                                    ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                                    : isLock
                                      ? "border border-amber-500/30 bg-amber-500/10 text-amber-400"
                                      : "border border-sky-500/30 bg-sky-500/10 text-sky-400"
                                }`}
                            >
                              {isCritical ? (
                                <ShieldAlert className="h-3.5 w-3.5" />
                              ) : (
                                <Activity className="h-3.5 w-3.5" />
                              )}
                            </span>

                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-semibold text-white">
                                  {log.action}
                                </span>
                                {isCritical && (
                                  <span className="rounded bg-red-500/15 border border-red-500/30 px-1.5 text-[9px] font-semibold text-red-300">
                                    SECURITY ALERT
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 text-slate-400 text-[11px]">
                                {log.meta?.reason || log.meta?.roomCode
                                  ? `Room: ${log.meta?.roomCode || ""} ${log.meta?.reason ? "— " + log.meta.reason : ""}`
                                  : "Administrative event recorded."}
                              </p>
                              <span className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-slate-500">
                                <Clock className="h-3 w-3" />
                                {formattedDate} {formattedTime}
                              </span>
                            </div>
                          </div>

                          {/* Right: Actor and Inspector */}
                          <div className="flex items-center gap-3">
                            <div className="text-right">
                              <p className="font-semibold text-slate-200">
                                {log.actorName || "Authenticated Actor"}
                              </p>
                              {log.actorEmail && (
                                <p className="font-mono text-[10px] text-slate-500">
                                  {log.actorEmail}
                                </p>
                              )}
                            </div>

                            {log.meta && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedLogId(isExpanded ? null : log._id)
                                }
                                className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:text-white"
                              >
                                {isExpanded ? "Hide Details" : "View Meta"}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Expanded Metadata Json */}
                        {isExpanded && log.meta && (
                          <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                              Raw Audit Metadata
                            </p>
                            <pre className="overflow-x-auto font-mono text-[11px] text-sky-300">
                              {JSON.stringify(log.meta, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* MODAL: SET ROOM LIMITS                                                    */}
      {/* ========================================================================= */}
      {editingRoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">
                Set Quotas for {editingRoom.code}
              </h3>
              <button
                type="button"
                onClick={() => setEditingRoom(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveLimits} className="mt-4 space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-300 mb-1">
                  Max Viewers Per Room
                </label>
                <input
                  type="number"
                  min={2}
                  max={100}
                  value={editingRoom.maxViewers}
                  onChange={(e) =>
                    setEditingRoom({
                      ...editingRoom,
                      maxViewers: Number(e.target.value),
                    })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500"
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  Between 2 and 100 participants.
                </p>
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">
                  Max Simultaneous Screen Shares
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={editingRoom.maxSharers}
                  onChange={(e) =>
                    setEditingRoom({
                      ...editingRoom,
                      maxSharers: Number(e.target.value),
                    })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500"
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  Concurrent broadcasting devices allowed (1–10).
                </p>
              </div>

              <div className="mt-6 flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingRoom(null)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 font-semibold text-slate-300 hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-sky-500 px-4 py-2 font-semibold text-white shadow-lg shadow-sky-500/25 hover:bg-sky-400"
                >
                  Save Limits
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: FORCE END ROOM CONFIRMATION                                        */}
      {/* ========================================================================= */}
      {endingRoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-red-400">
              <AlertTriangle className="h-6 w-6" />
              <h3 className="text-base font-bold text-white">
                Force Close Session
              </h3>
            </div>
            <p className="mt-2 text-xs text-slate-300 leading-relaxed">
              Are you sure you want to end session <strong className="font-mono text-white">{endingRoom.code}</strong>? All active streams will terminate immediately.
            </p>

            <div className="mt-4">
              <label className="block text-[11px] font-medium text-slate-400 mb-1">
                Audit Reason for Termination
              </label>
              <input
                type="text"
                value={endReason}
                onChange={(e) => setEndReason(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white outline-none focus:border-red-500"
              />
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => setEndingRoom(null)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmEndRoom}
                className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-red-600/30 hover:bg-red-500"
              >
                End Session Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
