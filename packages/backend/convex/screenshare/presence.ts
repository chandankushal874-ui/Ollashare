import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  recordParticipantJoin,
  recordScreenShareTransition,
  recordSecurityEvent,
} from "../analytics";
import { enqueueLiveKitParticipantOperation } from "./livekit_participant";
import {
  assertAnonymousInviteBinding,
  auditScreenshare,
  displayName,
  getRoomByCode,
  rateLimit,
  requireAuth,
  requireHost,
  requireRoomParticipant,
  sanitizeName,
} from "./lib";
import { revokeParticipantSharedBrowserAccess } from "../sharedBrowser";
import { revokeParticipantAnnotationAccess } from "./annotations";

// Presence: who is in a room, join/leave, and heartbeats. The only module that
// writes to `screenshareViewers`. Identity is derived from the authenticated
// user; viewerId is never client-supplied.

// Mesh guardrails (Issue 4):
// In full P2P mesh, connections scale as O(M * N).
// Default to mesh-safe caps (8 viewers / 3 simultaneous sharers).
// Rooms with custom limits configured via setRoomLimits continue to be respected up to 100/10.
// NOTE: LiveKit SFU defaults to 25 viewers (DEFAULT_LIVEKIT_MAX_VIEWERS in livekit.ts) due to server fanout.
export const DEFAULT_MAX_VIEWERS_PER_ROOM = 8;
export const DEFAULT_MAX_SHARERS_PER_ROOM = 3;
export const DEFAULT_BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export const joinRoomArgs = {
  roomCode: v.string(),
  name: v.string(),
};

export async function joinRoom(
  ctx: MutationCtx,
  args: ObjectType<typeof joinRoomArgs>,
) {
  // Authentication required at the data layer before inspecting room state
  const viewerId = await requireAuth(ctx);
  const viewerUser = await ctx.db.get(viewerId);
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) throw new ConvexError("Room not found");
  const revoked = await ctx.db.query('workspaceRevocations').withIndex('by_workspace_user', (q) => q.eq('workspaceId', room.workspaceId).eq('userId', viewerId)).unique();
  if (revoked) {
    const member = await ctx.db.query('members').withIndex('by_user_workspace', (q) => q.eq('userId', viewerId).eq('workspaceId', room.workspaceId)).unique();
    if (!member) throw new ConvexError('Forbidden');
  }
  if (room.status !== "live") throw new ConvexError("Room is not live");
  if (viewerUser?.isAnonymous) await assertAnonymousInviteBinding(ctx, viewerUser, room.code);

  // Throttle room-code guessing: at most 10 join attempts per user per minute.
  await rateLimit(ctx, `join:${viewerId}`, 10, 60_000);

  const now = Date.now();

  // Issue 6: Check persistent bans surviving presence row pruning
  const ban = await ctx.db
    .query("screenshareBans")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", args.roomCode).eq("viewerId", viewerId),
    )
    .first();

  if (ban && ban.expiresAt > now) {
    throw new ConvexError("You have been removed from this room by the host");
  }

  const isHostViewer = room.hostId === viewerId;
  const rawName = sanitizeName(args.name);
  const name = isHostViewer
    ? (rawName ? (rawName.endsWith("(Host)") ? rawName : `${rawName} (Host)`) : "Host (Host)")
    : (rawName || "Guest");

  const existing = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", args.roomCode).eq("viewerId", viewerId),
    )
    .first();

  if (room.isLocked && !existing) {
    await recordSecurityEvent(ctx, {
      workspaceId: room.workspaceId,
      event: "access_denied",
      reason: "room_locked",
      outcome: "denied",
      actorKind: viewerUser?.isAnonymous ? "guest" : "member",
      at: now,
    });
    await auditScreenshare(ctx, room.workspaceId, viewerId, "access.denied", {
      roomCode: args.roomCode,
      reason: "Room is locked by host",
    });
    throw new ConvexError("Room is locked by the host");
  }

  if (existing) {
    if (existing.status === "kicked") {
      if (ban && ban.expiresAt > now) {
        throw new ConvexError("You have been removed from this room by the host");
      }
      // If no ban or ban has expired, reinstate participant to active. Reset role
      // to "viewer" so a kicked sharer does NOT silently regain publish rights on
      // the next LiveKit token issue (issueLiveKitToken grants canPublish for
      // role === "sharer").
      await ctx.db.patch(existing._id, {
        name,
        status: "active",
        lastPingAt: now,
        isSharing: false,
        role: "viewer",
      });
      await recordParticipantJoin(ctx, {
        workspaceId: room.workspaceId,
        actorId: viewerId,
        viewerId: existing._id,
        at: now,
      });
      return existing._id;
    }
    await ctx.db.patch(existing._id, {
      name,
      lastPingAt: now,
      ...(isHostViewer ? { role: "host" } : {}),
    });
    return existing._id;
  }

  // Cap concurrent viewers per room based on room limit.
  const activeCount = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_room_ping", (q) =>
      q.eq("roomCode", args.roomCode).gte("lastPingAt", now - 45_000),
    )
    .collect();
  const maxViewers = room.maxViewers ?? DEFAULT_MAX_VIEWERS_PER_ROOM;
  if (activeCount.filter((v) => v.status !== "kicked").length >= maxViewers) {
    throw new ConvexError(`Room is full (max ${maxViewers} participants)`);
  }

  await auditScreenshare(ctx, room.workspaceId, viewerId, "participant.join", {
    roomCode: args.roomCode,
    name,
  });

  const viewerRowId = await ctx.db.insert("screenshareViewers", {
    roomCode: args.roomCode,
    viewerId,
    name,
    role: isHostViewer ? "host" : "viewer",
    lastPingAt: now,
  });
  await recordParticipantJoin(ctx, {
    workspaceId: room.workspaceId,
    actorId: viewerId,
    viewerId: viewerRowId,
    at: now,
  });
  return viewerRowId;
}

export const getViewersArgs = { roomCode: v.string() };

export async function getViewers(
  ctx: QueryCtx,
  args: ObjectType<typeof getViewersArgs>,
) {
  await requireAuth(ctx);
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) return [];
  await requireRoomParticipant(ctx, args.roomCode, room.workspaceId);

  const now = Date.now();
  // DB-side filter: only fetch viewers who pinged in the last 45 seconds.
  const list = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_room_ping", (q) =>
      q.eq("roomCode", args.roomCode).gte("lastPingAt", now - 45_000),
    )
    .collect();
  return list.filter((v) => v.status !== "kicked");
}

export const pingViewerArgs = {
  roomCode: v.string(),
};

export async function pingViewer(
  ctx: MutationCtx,
  args: ObjectType<typeof pingViewerArgs>,
) {
  await requireAuth(ctx);
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) return;
  const viewerId = await requireRoomParticipant(
    ctx,
    args.roomCode,
    room.workspaceId,
  );

  const existing = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", args.roomCode).eq("viewerId", viewerId),
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      lastPingAt: Date.now(),
    });
  }
}

export const kickParticipantArgs = {
  roomCode: v.string(),
  viewerId: v.id("users"),
  durationMs: v.optional(v.number()),
};

export async function kickParticipant(
  ctx: MutationCtx,
  args: ObjectType<typeof kickParticipantArgs>,
) {
  await requireAuth(ctx);
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) throw new ConvexError("Room not found");
  const actorId = await requireHost(ctx, room);

  if (args.viewerId === room.hostId) {
    throw new ConvexError("Cannot remove the room host");
  }

  const now = Date.now();
  // Validate ban duration bounds: reject negative and absurdly large values so a
  // caller cannot mint a near-permanent ban or bypass the ban with a negative
  // duration (which would produce an already-expired expiresAt). 0 = kick only
  // (no ban); otherwise clamp to a sane ceiling (7 days).
  if (
    args.durationMs !== undefined &&
    (args.durationMs < 0 || !Number.isFinite(args.durationMs))
  ) {
    throw new ConvexError("Invalid ban duration");
  }
  const banDuration = args.durationMs !== undefined ? args.durationMs : DEFAULT_BAN_DURATION_MS;
  const clampedDuration = Math.min(banDuration, 7 * 24 * 60 * 60 * 1000);
  const expiresAt = clampedDuration > 0 ? now + clampedDuration : 0;

  // Issue 6: Record persistent ban surviving retention pruning of viewer rows.
  const existingBan = await ctx.db
    .query("screenshareBans")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", args.roomCode).eq("viewerId", args.viewerId),
    )
    .first();

  if (expiresAt > now) {
    if (existingBan) {
      await ctx.db.patch(existingBan._id, {
        bannedAt: now,
        expiresAt,
      });
    } else {
      await ctx.db.insert("screenshareBans", {
        roomCode: args.roomCode,
        viewerId: args.viewerId,
        bannedAt: now,
        expiresAt,
      });
    }
  } else if (existingBan) {
    await ctx.db.delete(existingBan._id);
  }

  const targetViewer = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", args.roomCode).eq("viewerId", args.viewerId),
    )
    .first();

  if (targetViewer) {
    await recordSecurityEvent(ctx, {
      workspaceId: room.workspaceId,
      event: "participant_removed",
      reason: "policy_enforced",
      outcome: "enforced",
      actorKind: "member",
      at: now,
    });
    await ctx.db.patch(targetViewer._id, {
      status: "kicked",
      isSharing: false,
    });

    await auditScreenshare(ctx, room.workspaceId, actorId, "participant.kick", {
      roomCode: args.roomCode,
      kickedViewerId: args.viewerId,
      kickedName: targetViewer.name,
      banExpiresAt: expiresAt,
    });
  }
  await revokeParticipantSharedBrowserAccess(ctx, args.roomCode, args.viewerId);
  await revokeParticipantAnnotationAccess(ctx, args.roomCode, args.viewerId);
  await enqueueLiveKitParticipantOperation(ctx, {
    operationKind: "evict",
    roomCode: args.roomCode,
    identity: String(args.viewerId),
    reason: "participant-kicked",
  });

  return true;
}

export const setSharingStatusArgs = {
  roomCode: v.string(),
  isSharing: v.boolean(),
};

export async function setSharingStatus(
  ctx: MutationCtx,
  args: ObjectType<typeof setSharingStatusArgs>,
) {
  await requireAuth(ctx);
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) throw new ConvexError("Room not found");
  if (room.status !== 'live') throw new ConvexError('Room is not live');
  const viewerId = await requireRoomParticipant(
    ctx,
    args.roomCode,
    room.workspaceId,
  );

  const viewer = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", args.roomCode).eq("viewerId", viewerId),
    )
    .first();

  if (!viewer) throw new ConvexError("Participant not found");

  // A kicked viewer (whose presence row still exists) must not be able to patch
  // sharing state. requireRoomParticipant only checks row existence, not status.
  if (viewer.status === "kicked") {
    throw new ConvexError("You have been removed from this room by the host");
  }

  if (args.isSharing) {
    if (room.hostId !== viewerId && !room.allowGuestSharing && !viewer.sharerApproved) {
      throw new ConvexError(
        "Guest sharing is disabled by host. Host approval or allowGuestSharing room setting is required."
      );
    }
    const now = Date.now();
    const activeViewers = await ctx.db
      .query("screenshareViewers")
      .withIndex("by_room_ping", (q) =>
        q.eq("roomCode", args.roomCode).gte("lastPingAt", now - 45_000),
      )
      .collect();

    const activeSharers = activeViewers.filter(
      (v) => v.isSharing && v.viewerId !== viewerId && v.status !== "kicked",
    );
    const maxSharers = room.maxSharers ?? DEFAULT_MAX_SHARERS_PER_ROOM;
    if (activeSharers.length >= maxSharers) {
      throw new ConvexError(
        `Simultaneous screen share limit reached (${maxSharers} max)`,
      );
    }
  }

  await recordScreenShareTransition(ctx, {
    workspaceId: room.workspaceId,
    actorId: viewerId,
    wasSharing: Boolean(viewer.isSharing),
    isSharing: args.isSharing,
  });
  await ctx.db.patch(viewer._id, {
    isSharing: args.isSharing,
    // On stop-share, reset role to "viewer" so a stopped sharer does not retain
    // publish rights (issueLiveKitToken grants canPublish for role === "sharer").
    ...(args.isSharing ? {} : { role: "viewer" }),
  });

  if (!args.isSharing && room.hostId !== viewerId) {
    await enqueueLiveKitParticipantOperation(ctx, {
      operationKind: "downgrade",
      roomCode: args.roomCode,
      identity: String(viewerId),
      reason: "participant-stopped-sharing",
    });
  }

  await auditScreenshare(
    ctx,
    room.workspaceId,
    viewerId,
    args.isSharing ? "screenshare.start" : "screenshare.stop",
    { roomCode: args.roomCode, participantName: viewer.name },
  );

  return true;
}
