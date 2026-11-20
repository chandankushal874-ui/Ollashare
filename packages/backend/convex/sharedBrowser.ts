import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { auditScreenshare, getRoomByCode, rateLimit, requireHost, requireRoomParticipant } from "./screenshare/lib";
import { authorizeServiceSecret } from "./serviceSecrets";

const LEASE_MS = 5 * 60_000;
const VIEWER_GRANT_MS = 5 * 60_000;
const WORKER_GRANT_MS = 60_000;
const REVOCATION_CLAIM_MS = 2 * 60_000;
const DELIVERED_REVOCATION_TTL_MS = 7 * 24 * 60 * 60_000;
const TERMINATED_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

async function getControllerAuthorization(ctx: Parameters<typeof getRoomByCode>[0], sessionId: Id<"sharedBrowserSessions">, userId: Id<"users">) {
  const authorization = await ctx.db.query("sharedBrowserControllers")
    .withIndex("by_session_user", (q) => q.eq("sessionId", sessionId).eq("userId", userId))
    .first();
  return authorization && authorization.expiresAt > Date.now() ? authorization : null;
}

async function deleteSessionControllers(ctx: MutationCtx, sessionId: Id<"sharedBrowserSessions">) {
  const controllers = await ctx.db.query("sharedBrowserControllers")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const controller of controllers) await ctx.db.delete(controller._id);
}

async function deleteParticipantController(ctx: MutationCtx, sessionId: Id<"sharedBrowserSessions">, userId: Id<"users">) {
  const controllers = await ctx.db.query("sharedBrowserControllers")
    .withIndex("by_session_user", (q) => q.eq("sessionId", sessionId).eq("userId", userId))
    .collect();
  for (const controller of controllers) await ctx.db.delete(controller._id);
}

async function grantParticipantController(ctx: MutationCtx, sessionId: Id<"sharedBrowserSessions">, roomCode: string, userId: Id<"users">, grantedBy: Id<"users">) {
  const now = Date.now();
  const existing = await ctx.db.query("sharedBrowserControllers")
    .withIndex("by_session_user", (q) => q.eq("sessionId", sessionId).eq("userId", userId))
    .first();
  if (existing) {
    const expiresAt = now + LEASE_MS;
    await ctx.db.patch(existing._id, { updatedAt: now, expiresAt, grantedBy });
    return { controllerUserId: userId, leaseId: existing.leaseId, expiresAt };
  }
  const leaseId = randomToken("sbl_");
  const expiresAt = now + LEASE_MS;
  await ctx.db.insert("sharedBrowserControllers", { sessionId, roomCode, userId, leaseId, grantedBy, createdAt: now, updatedAt: now, expiresAt });
  return { controllerUserId: userId, leaseId, expiresAt };
}

async function activeControllerIds(ctx: Parameters<typeof getRoomByCode>[0], sessionId: Id<"sharedBrowserSessions">, hostId: Id<"users">) {
  const controllers = await ctx.db.query("sharedBrowserControllers")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  return Array.from(new Set([hostId, ...controllers.filter((controller) => controller.expiresAt > Date.now()).map((controller) => controller.userId)]));
}

async function queueRevocation(ctx: MutationCtx, grant: { _id: Id<"sharedBrowserGrants">; sessionId: Id<"sharedBrowserSessions">; roomCode: string }, reason: string) {
  const existing = await ctx.db.query("sharedBrowserRevocations").withIndex("by_grant", (q) => q.eq("grantId", grant._id)).first();
  if (existing) return existing._id;
  return ctx.db.insert("sharedBrowserRevocations", { grantId: grant._id, sessionId: grant.sessionId, roomCode: grant.roomCode, reason, createdAt: Date.now() });
}

async function terminateActiveSession(
  ctx: MutationCtx,
  session: {
    _id: Id<"sharedBrowserSessions">;
    roomCode: string;
    controllerUserId?: Id<"users">;
  },
  terminatedBy?: Id<"users">,
  reason = "session-terminated",
) {
  const now = Date.now();
  await ctx.db.patch(session._id, {
    status: "terminated",
    terminatedAt: now,
    terminatedBy,
    controllerUserId: undefined,
    controllerLeaseId: undefined,
    controllerLeaseExpiresAt: undefined,
    controllerRequestId: undefined,
  });
  await deleteSessionControllers(ctx, session._id);
  const grants = await ctx.db.query("sharedBrowserGrants")
    .withIndex("by_session_status", (q) => q.eq("sessionId", session._id).eq("status", "issued"))
    .collect();
  for (const grant of grants) {
    await ctx.db.patch(grant._id, { status: "revoked", revokedAt: now });
    await queueRevocation(ctx, grant, reason);
  }
}

export async function revokeRoomSharedBrowsers(
  ctx: MutationCtx,
  roomCode: string,
  terminatedBy?: Id<"users">,
) {
  const sessions = await ctx.db.query("sharedBrowserSessions")
    .withIndex("by_room_status", (q) => q.eq("roomCode", roomCode).eq("status", "active"))
    .collect();
  for (const session of sessions) {
    await terminateActiveSession(ctx, session, terminatedBy, "room-ended");
  }
}

export async function revokeParticipantSharedBrowserAccess(
  ctx: MutationCtx,
  roomCode: string,
  userId: Id<"users">,
) {
  const now = Date.now();
  const sessions = await ctx.db.query("sharedBrowserSessions")
    .withIndex("by_room_status", (q) => q.eq("roomCode", roomCode).eq("status", "active"))
    .collect();
  for (const session of sessions) {
    await deleteParticipantController(ctx, session._id, userId);
    if (session.controllerUserId === userId) {
      await ctx.db.patch(session._id, {
        controllerUserId: undefined,
        controllerLeaseId: undefined,
        controllerLeaseExpiresAt: undefined,
        controllerRequestId: undefined,
      });
    }
    const grants = await ctx.db.query("sharedBrowserGrants")
      .withIndex("by_session_user", (q) => q.eq("sessionId", session._id).eq("userId", userId))
      .collect();
    for (const grant of grants) {
      if (grant.status === "issued") { await ctx.db.patch(grant._id, { status: "revoked", revokedAt: now }); await queueRevocation(ctx, grant, "participant-removed"); }
    }
  }
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireActiveSession(ctx: Parameters<typeof getRoomByCode>[0], sessionId: Id<"sharedBrowserSessions">) {
  const session = await ctx.db.get(sessionId);
  if (!session || session.status !== "active") throw new ConvexError("Shared browser session is not active");
  const room = await getRoomByCode(ctx, session.roomCode);
  if (!room || room.status !== "live") throw new ConvexError("Room is not live");
  return { session, room };
}

async function requireEligibleParticipant(
  ctx: Parameters<typeof getRoomByCode>[0],
  roomCode: string,
  userId: Id<"users">,
) {
  const viewer = await ctx.db.query("screenshareViewers")
    .withIndex("by_room_viewer", (q) => q.eq("roomCode", roomCode).eq("viewerId", userId))
    .first();
  const ban = await ctx.db.query("screenshareBans")
    .withIndex("by_room_viewer", (q) => q.eq("roomCode", roomCode).eq("viewerId", userId))
    .first();
  if (!viewer || viewer.status === "kicked" || (ban && ban.expiresAt > Date.now())) {
    throw new ConvexError("Participant is not eligible for this room");
  }
  return viewer;
}

function leaseResult(session: { controllerUserId?: Id<"users">; controllerLeaseId?: string; controllerLeaseExpiresAt?: number }) {
  return {
    controllerUserId: session.controllerUserId,
    leaseId: session.controllerLeaseId,
    expiresAt: session.controllerLeaseExpiresAt,
  };
}

export const startSession = mutation({
  args: { roomCode: v.string() },
  handler: async (ctx, { roomCode }) => {
    const room = await getRoomByCode(ctx, roomCode);
    if (!room) throw new ConvexError("Room not found");
    const actorId = await requireHost(ctx, room);
    await rateLimit(ctx, `shared-browser:provision:${actorId}:${roomCode}`, 3, 10 * 60_000);
    if (room.status !== "live") throw new ConvexError("Room is not live");
    const active = await ctx.db.query("sharedBrowserSessions")
      .withIndex("by_room_status", (q) => q.eq("roomCode", roomCode).eq("status", "active"))
      .collect();
    if (active.length > 1) {
      const authoritative = active[0];
      if (!authoritative) throw new ConvexError("Shared browser active-session invariant failed");
      const duplicates = active.slice(1);
      for (const duplicate of duplicates) await terminateActiveSession(ctx, duplicate, actorId, "duplicate-active-session");
      return { sessionId: authoritative._id, created: false };
    }
    if (active[0]) return { sessionId: active[0]._id, created: false };
    const sessionId = await ctx.db.insert("sharedBrowserSessions", {
      roomCode,
      workspaceId: room.workspaceId,
      createdBy: actorId,
      status: "active",
      createdAt: Date.now(),
    });
    await auditScreenshare(ctx, room.workspaceId, actorId, "browser.start", { roomCode, sessionId });
    return { sessionId, created: true };
  },
});

export const getSession = query({
  args: { roomCode: v.string() },
  handler: async (ctx, { roomCode }) => {
    const room = await getRoomByCode(ctx, roomCode);
    if (!room) return null;
    const userId = await requireRoomParticipant(ctx, roomCode, room.workspaceId);
    const session = await ctx.db.query("sharedBrowserSessions")
      .withIndex("by_room_status", (q) => q.eq("roomCode", roomCode).eq("status", "active"))
      .order("desc")
      .first();
    if (!session) return null;
    const now = Date.now();
    const controllerUserIds = await activeControllerIds(ctx, session._id, room.hostId);
    const legacyController = session.controllerLeaseExpiresAt && session.controllerLeaseExpiresAt > now ? session.controllerUserId : undefined;
    const isController = userId === room.hostId || controllerUserIds.includes(userId) || legacyController === userId;
    return {
      sessionId: session._id,
      roomCode: session.roomCode,
      status: "active",
      controllerUserId: legacyController,
      controllerUserIds,
      controllerLeaseExpiresAt: session.controllerLeaseExpiresAt,
      isController,
    };
  },
});

export const getSessionForServiceWithSecret = query({
  args: { roomCode: v.string(), serviceSecret: v.string() },
  handler: async (ctx, { roomCode, serviceSecret }) => {
    authorizeServiceSecret(serviceSecret, process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET, "SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET");
    const sessions = await ctx.db.query("sharedBrowserSessions").withIndex("by_room_status", (q) => q.eq("roomCode", roomCode).eq("status", "active")).take(2);
    if (sessions.length !== 1) return null;
    const session = sessions[0];
    if (!session) return null;
    const room = await getRoomByCode(ctx, roomCode);
    return room?.status === "live" ? { status: session.status } : null;
  },
});

export const validateGatewayGrant = query({
  args: { serviceSecret: v.string(), grantId: v.id("sharedBrowserGrants") },
  handler: async (ctx, { serviceSecret, grantId }) => {
    authorizeServiceSecret(serviceSecret, process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET, "SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET");
    const grant = await ctx.db.get(grantId);
    if (!grant || grant.status !== "issued" || grant.expiresAt <= Date.now()) return { active: false };
    const session = await ctx.db.get(grant.sessionId);
    if (!session || session.status !== "active" || session.roomCode !== grant.roomCode) return { active: false };
    const room = await getRoomByCode(ctx, grant.roomCode);
    if (!room || room.status !== "live") return { active: false };
    try { await requireEligibleParticipant(ctx, grant.roomCode, grant.userId); } catch { return { active: false }; }
    if (grant.mode === "control") {
      const authorized = grant.userId === room.hostId
        ? true
        : Boolean((await getControllerAuthorization(ctx, session._id, grant.userId))?.leaseId === grant.controllerLeaseId) || (session.controllerUserId === grant.userId && session.controllerLeaseId === grant.controllerLeaseId && (session.controllerLeaseExpiresAt ?? 0) > Date.now());
      if (!authorized) return { active: false };
    }
    return { active: true, roomCode: grant.roomCode, sessionId: String(grant.sessionId), mode: grant.mode ?? "view", expiresAt: grant.expiresAt };
  },
});

export const acquireController = mutation({
  args: { sessionId: v.id("sharedBrowserSessions"), requestId: v.string() },
  handler: async (ctx, { sessionId, requestId }) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw new ConvexError("Invalid request id");
    const { session, room } = await requireActiveSession(ctx, sessionId);
    const userId = await requireHost(ctx, room);
    await rateLimit(ctx, `shared-browser:controller:${userId}:${sessionId}`, 20, 60_000);
    const now = Date.now();
    if (session.controllerUserId === userId && session.controllerRequestId === requestId && (session.controllerLeaseExpiresAt ?? 0) > now) return leaseResult(session);
    if (session.controllerUserId && session.controllerUserId !== userId && (session.controllerLeaseExpiresAt ?? 0) > now) {
      throw new ConvexError("Browser controller is leased to another participant");
    }
    const leaseId = randomToken("sbl_");
    const expiresAt = now + LEASE_MS;
    await ctx.db.patch(session._id, { controllerUserId: userId, controllerLeaseId: leaseId, controllerLeaseExpiresAt: expiresAt, controllerRequestId: requestId });
    return { controllerUserId: userId, leaseId, expiresAt };
  },
});

export const grantController = mutation({
  args: { sessionId: v.id("sharedBrowserSessions"), viewerId: v.id("users") },
  handler: async (ctx, { sessionId, viewerId }) => {
    const { session, room } = await requireActiveSession(ctx, sessionId);
    const actorId = await requireHost(ctx, room);
    await rateLimit(ctx, `shared-browser:controller:${actorId}:${sessionId}`, 20, 60_000);
    await requireEligibleParticipant(ctx, session.roomCode, viewerId);
    const authorization = await grantParticipantController(ctx, sessionId, session.roomCode, viewerId, actorId);
    await auditScreenshare(ctx, room.workspaceId, actorId, "browser.controller_grant", { sessionId, viewerId, expiresAt: authorization.expiresAt });
    return authorization;
  },
});

export const revokeController = mutation({
  args: { sessionId: v.id("sharedBrowserSessions"), viewerId: v.optional(v.id("users")) },
  handler: async (ctx, { sessionId, viewerId }) => {
    const { session, room } = await requireActiveSession(ctx, sessionId);
    const actorId = await requireHost(ctx, room);
    if (viewerId) {
      await deleteParticipantController(ctx, sessionId, viewerId);
      const grants = await ctx.db.query("sharedBrowserGrants").withIndex("by_session_user", (q) => q.eq("sessionId", sessionId).eq("userId", viewerId)).collect();
      for (const grant of grants) if (grant.status === "issued" && grant.mode === "control") { await ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() }); await queueRevocation(ctx, grant, "controller-revoked"); }
    } else {
      await deleteSessionControllers(ctx, sessionId);
    }
    await auditScreenshare(ctx, room.workspaceId, actorId, "browser.controller_revoke", { sessionId, viewerId });
    return true;
  },
});

export const revokeViewerGrant = mutation({
  args: { sessionId: v.id("sharedBrowserSessions"), grantId: v.id("sharedBrowserGrants") },
  handler: async (ctx, { sessionId, grantId }) => {
    const { session, room } = await requireActiveSession(ctx, sessionId);
    const actorId = await requireHost(ctx, room);
    const grant = await ctx.db.get(grantId);
    if (!grant || grant.sessionId !== sessionId || grant.roomCode !== session.roomCode) throw new ConvexError("Viewer grant not found");
    if (grant.status === "issued") { await ctx.db.patch(grantId, { status: "revoked", revokedAt: Date.now() }); await queueRevocation(ctx, grant, "host-revoked"); }
    await auditScreenshare(ctx, room.workspaceId, actorId, "browser.viewer_grant_revoke", { sessionId, grantId, viewerId: grant.userId });
    return { revoked: true, roomCode: session.roomCode };
  },
});

export const terminateSession = mutation({
  args: { sessionId: v.id("sharedBrowserSessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new ConvexError("Shared browser session not found");
    if (session.status === "terminated") return { terminated: false, sessionId, roomCode: session.roomCode };
    const room = await getRoomByCode(ctx, session.roomCode);
    if (!room) throw new ConvexError("Room not found");
    const actorId = await requireHost(ctx, room);
    await terminateActiveSession(ctx, session, actorId);
    await auditScreenshare(ctx, room.workspaceId, actorId, "browser.terminate", { sessionId });
    return { terminated: true, sessionId, roomCode: session.roomCode };
  },
});

// This public contract intentionally returns only grant metadata. The browser
// client may pass grantId as correlation data but never receives a worker bearer.
export const issueViewerGrant = mutation({
  args: { sessionId: v.id("sharedBrowserSessions"), requestControl: v.optional(v.boolean()) },
  handler: async (ctx, { sessionId, requestControl }) => {
    const { session, room } = await requireActiveSession(ctx, sessionId);
    const userId = await requireRoomParticipant(ctx, session.roomCode, room.workspaceId);
    await rateLimit(ctx, `shared-browser:viewer-grant:${userId}:${sessionId}`, 20, 60_000);
    const now = Date.now();
    let controllerLeaseId = session.controllerLeaseId;
    let controllerLeaseExpiresAt = session.controllerLeaseExpiresAt;
    const participantAuthorization = userId === room.hostId ? null : await getControllerAuthorization(ctx, sessionId, userId);
    if (requestControl) {
      if (userId !== room.hostId) throw new ConvexError("Only the room host may take Shared Browser control directly");
      controllerLeaseId = randomToken("sbl_");
      controllerLeaseExpiresAt = now + LEASE_MS;
    }
    const legacyController = session.controllerUserId === userId && (session.controllerLeaseExpiresAt ?? 0) > now;
    const isController = userId === room.hostId || Boolean(participantAuthorization) || legacyController || Boolean(requestControl);
    if (participantAuthorization) {
      controllerLeaseId = participantAuthorization.leaseId;
      controllerLeaseExpiresAt = participantAuthorization.expiresAt;
    }
    const expiresAt = isController ? Math.min(controllerLeaseExpiresAt ?? now + LEASE_MS, now + LEASE_MS) : now + VIEWER_GRANT_MS;
    const mode = isController ? "control" as const : "view" as const;
    const grantId = await ctx.db.insert("sharedBrowserGrants", { sessionId, roomCode: session.roomCode, userId, kind: "viewer", mode, controllerLeaseId: isController ? controllerLeaseId : undefined, status: "issued", createdAt: Date.now(), expiresAt });
    return {
      grantId,
      sessionId,
      roomCode: session.roomCode,
      userId,
      mode,
      controllerLeaseId: isController ? controllerLeaseId : undefined,
      expiresAt,
    };
  },
});

// Trusted orchestration only: worker bearer credentials are never callable from
// the frontend-facing `api.sharedBrowser` namespace.
export const issueWorkerGrant = internalMutation({
  args: { sessionId: v.id("sharedBrowserSessions"), viewerId: v.id("users") },
  handler: async (ctx, { sessionId, viewerId }) => {
    const { session, room } = await requireActiveSession(ctx, sessionId);
    await requireEligibleParticipant(ctx, session.roomCode, viewerId);
    const authorization = viewerId === room.hostId ? null : await getControllerAuthorization(ctx, sessionId, viewerId);
    if (viewerId !== room.hostId && !authorization && !(session.controllerUserId === viewerId && (session.controllerLeaseExpiresAt ?? 0) > Date.now())) {
      throw new ConvexError("Viewer does not hold browser controller access");
    }
    const controllerLeaseId = authorization?.leaseId ?? session.controllerLeaseId;
    const workerToken = randomToken("sbw_");
    const expiresAt = Date.now() + WORKER_GRANT_MS;
    const grantId = await ctx.db.insert("sharedBrowserGrants", { sessionId, roomCode: session.roomCode, userId: viewerId, kind: "worker", tokenHash: await hashToken(workerToken), controllerLeaseId, status: "issued", createdAt: Date.now(), expiresAt });
    return { grantId, workerToken, expiresAt };
  },
});

export const redeemWorkerGrant = internalMutation({
  args: { workerToken: v.string() },
  handler: async (ctx, { workerToken }) => {
    const tokenHash = await hashToken(workerToken);
    const grant = await ctx.db.query("sharedBrowserGrants").withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).first();
    if (!grant || grant.kind !== "worker" || grant.status !== "issued" || grant.expiresAt <= Date.now()) throw new ConvexError("Invalid worker grant");
    const { session, room } = await requireActiveSession(ctx, grant.sessionId);
    await requireEligibleParticipant(ctx, session.roomCode, grant.userId);
    const authorization = grant.userId === room.hostId ? null : await getControllerAuthorization(ctx, session._id, grant.userId);
    const authorized = grant.userId === room.hostId || authorization?.leaseId === grant.controllerLeaseId || (session.controllerUserId === grant.userId && session.controllerLeaseId === grant.controllerLeaseId && (session.controllerLeaseExpiresAt ?? 0) > Date.now());
    if (!authorized) {
      throw new ConvexError("Browser controller lease is no longer valid");
    }
    await ctx.db.patch(grant._id, { status: "redeemed", redeemedAt: Date.now() });
    return { sessionId: session._id, roomCode: session.roomCode, viewerId: grant.userId, workspaceId: room.workspaceId };
  },
});

export const listPendingRevocations = internalMutation({
  args: { limit: v.optional(v.number()), claimId: v.optional(v.string()) },
  handler: async (ctx, { limit, claimId }) => {
    const id = claimId ?? randomToken("sbr_");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new ConvexError("Invalid claim id");
    const now = Date.now();
    const pending = await ctx.db.query("sharedBrowserRevocations")
      .withIndex("by_delivery", (q) => q.eq("deliveredAt", undefined))
      .take(100);
    const claimed = [];
    for (const revocation of pending) {
      if (claimed.length >= Math.max(1, Math.min(limit ?? 100, 100))) break;
      if (revocation.deliveryClaimId && revocation.deliveryClaimId !== id && (revocation.deliveryClaimedAt ?? 0) > now - REVOCATION_CLAIM_MS) continue;
      await ctx.db.patch(revocation._id, { deliveryClaimId: id, deliveryClaimedAt: now, deliveryAttempts: (revocation.deliveryAttempts ?? 0) + 1 });
      claimed.push({ ...revocation, deliveryClaimId: id, deliveryClaimedAt: now, deliveryAttempts: (revocation.deliveryAttempts ?? 0) + 1 });
    }
    return claimed;
  },
});

export const markRevocationDelivered = internalMutation({
  args: { revocationId: v.id("sharedBrowserRevocations"), claimId: v.optional(v.string()) },
  handler: async (ctx, { revocationId, claimId }) => {
    const revocation = await ctx.db.get(revocationId);
    if (!revocation || revocation.deliveredAt) return false;
    if (revocation.deliveryClaimId && claimId !== revocation.deliveryClaimId) throw new ConvexError("Revocation claim mismatch");
    await ctx.db.patch(revocationId, { deliveredAt: Date.now(), deliveryClaimId: undefined, deliveryClaimedAt: undefined });
    return true;
  },
});

export const cleanupSharedBrowserData = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const grantsDeleted = [] as Id<"sharedBrowserGrants">[];
    for (const grant of await ctx.db.query("sharedBrowserGrants").withIndex("by_expiry", (q) => q.lt("expiresAt", now)).take(500)) {
      if (grant.status === "issued") {
        await ctx.db.patch(grant._id, { status: "revoked", revokedAt: now });
        await queueRevocation(ctx, grant, "expired");
      } else {
        const revocation = await ctx.db.query("sharedBrowserRevocations").withIndex("by_grant", (q) => q.eq("grantId", grant._id)).first();
        if (revocation && !revocation.deliveredAt) continue;
        if (revocation && (revocation.deliveredAt ?? 0) > now - DELIVERED_REVOCATION_TTL_MS) continue;
        if (revocation) await ctx.db.delete(revocation._id);
        await ctx.db.delete(grant._id);
        grantsDeleted.push(grant._id);
      }
    }
    const controllers = await ctx.db.query("sharedBrowserControllers").withIndex("by_expiry", (q) => q.lt("expiresAt", now)).take(500);
    for (const controller of controllers) await ctx.db.delete(controller._id);
    const delivered = await ctx.db.query("sharedBrowserRevocations").withIndex("by_delivery", (q) => q.lt("deliveredAt", now - DELIVERED_REVOCATION_TTL_MS)).take(500);
    let revocationsDeleted = 0;
    for (const revocation of delivered) {
      const grant = await ctx.db.get(revocation.grantId);
      if (grant) continue;
      await ctx.db.delete(revocation._id);
      revocationsDeleted += 1;
    }
    let sessionsDeleted = 0;
    const terminated = await ctx.db.query("sharedBrowserSessions").withIndex("by_status", (q) => q.eq("status", "terminated")).take(200);
    for (const session of terminated) {
      if ((session.terminatedAt ?? session.createdAt) >= now - TERMINATED_SESSION_TTL_MS) continue;
      const grants = await ctx.db.query("sharedBrowserGrants").filter((q) => q.eq(q.field("sessionId"), session._id)).take(1);
      const revocations = await ctx.db.query("sharedBrowserRevocations").withIndex("by_session", (q) => q.eq("sessionId", session._id)).take(1);
      if (grants.length || revocations.length) continue;
      await deleteSessionControllers(ctx, session._id);
      await ctx.db.delete(session._id);
      sessionsDeleted += 1;
    }
    return { grantsDeleted: grantsDeleted.length, controllersDeleted: controllers.length, revocationsDeleted, sessionsDeleted };
  },
});
