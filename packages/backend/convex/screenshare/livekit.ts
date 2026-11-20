import { ConvexError, v } from "convex/values";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { auditScreenshare, getRoomByCode, rateLimit, requireAuth, requireHost, requireRoomParticipant } from './lib';

export const issueLiveKitTokenArgs = {
  roomCode: v.string(),
  requestPublish: v.optional(v.boolean()),
};

/**
 * Default participant ceiling for LiveKit SFU rooms.
 *
 * NOTE ON CAPACITY DIFFERENCE VS MESH:
 * - P2P Mesh (`presence.ts:DEFAULT_MAX_VIEWERS_PER_ROOM`) defaults to 8 viewers due to O(N^2) WebRTC peer connection overhead.
 * - LiveKit SFU defaults to 25 viewers (expandable to 50+) because the star topology offloads media forwarding to the server,
 *   preventing client CPU and upstream saturation.
 */
export const DEFAULT_LIVEKIT_MAX_VIEWERS = 25;
export const LIVEKIT_TOKEN_TTL = "5m";

export interface LiveKitParticipantValidation {
  roomCode: string;
  userId: Id<"users">;
  name: string;
  role: string;
  canPublish: boolean;
  canPublishData: boolean;
  canSubscribe: boolean;
  isHost: boolean;
  workspaceId: Id<"workspaces">;
}

export async function validateParticipantForLiveKit(
  ctx: QueryCtx | MutationCtx,
  args: { roomCode: string; requestPublish?: boolean },
): Promise<LiveKitParticipantValidation> {
  const userId = await requireAuth(ctx);
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) {
    throw new ConvexError("Room not found");
  }
  if (room.status !== "live") {
    throw new ConvexError("Room has ended");
  }
  // Active-session enforcement is shared by mesh and SFU credential issuance.

  // 1. Kick Denylist / Ban Check
  const ban = await ctx.db
    .query("screenshareBans")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", args.roomCode).eq("viewerId", userId),
    )
    .first();
  if (ban && ban.expiresAt > Date.now()) {
    throw new ConvexError("You have been removed from this room by the host");
  }

  // 2. Host Path
  if (room.hostId === userId) {
    await requireHost(ctx, room);
    return {
      roomCode: args.roomCode,
      userId,
      name: room.hostName || "Host",
      role: "host",
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
      isHost: true,
      workspaceId: room.workspaceId,
    };
  }

  // 3. Viewer / Guest / Member Lookup. A non-host MUST have joined the room
  //    (presence row) — this is what enforces the viewer cap. Workspace membership
  //    alone no longer grants a token: previously a member could connect to the
  //    SFU without ever calling joinRoom, bypassing the presence cap entirely.
  const existingViewer = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", args.roomCode).eq("viewerId", userId),
    )
    .first();

  if (!existingViewer) {
    throw new ConvexError("Forbidden: not a participant of this room");
  }
  await requireRoomParticipant(ctx, args.roomCode, room.workspaceId);

  // A kicked viewer (even without an active ban row, e.g. durationMs=0) must not
  // obtain a token.
  if (existingViewer.status === "kicked") {
    throw new ConvexError("You have been removed from this room by the host");
  }

  const name = existingViewer.name || "Participant";
  const role = existingViewer.role || "viewer";

  const now = Date.now();
  const activeViewers = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_room_ping", (q) =>
      q.eq("roomCode", args.roomCode).gte("lastPingAt", now - 45_000),
    )
    .collect();

  const isAlreadyActiveViewer = activeViewers.some(
    (v) => v.viewerId === userId,
  );

  // 4. Room Lock Guardrail
  if (room.isLocked && !isAlreadyActiveViewer) {
    throw new ConvexError("Room is locked by host");
  }

  // 5. maxViewers Server-Side Cap Enforcement
  const maxViewers = room.maxViewers ?? DEFAULT_LIVEKIT_MAX_VIEWERS;
  if (!isAlreadyActiveViewer && activeViewers.length >= maxViewers) {
    throw new ConvexError(
      `Room is full (max ${maxViewers} participants)`,
    );
  }

  // 6. maxSharers Server-Side Cap Enforcement
  const activeSharers = activeViewers.filter(
    (v) => Boolean(v.isSharing) && v.lastPingAt >= now - 45_000,
  );
  const maxSharers = room.maxSharers ?? 3;
  const isAlreadySharing = activeSharers.some((v) => v.viewerId === userId);

  let canPublish = false;
  const wantsPublish = Boolean(
    args.requestPublish || (existingViewer && (existingViewer.role === "sharer" || existingViewer.isSharing)),
  );

  if (wantsPublish) {
    // SECURITY GATE: Prevent unauthorized guest publishing.
    // Non-hosts can only publish if the host enabled allowGuestSharing OR explicitly approved the viewer.
    const isAllowed = Boolean(room.allowGuestSharing || existingViewer?.sharerApproved);
    if (!isAllowed) {
      if (args.requestPublish) {
        throw new ConvexError(
          "Guest sharing is disabled by host. Host approval or allowGuestSharing room setting is required to share screen."
        );
      }
      canPublish = false;
    } else if (!isAlreadySharing && activeSharers.length >= maxSharers) {
      if (args.requestPublish) {
        throw new ConvexError(
          `Maximum simultaneous screen shares reached (${maxSharers}). Please wait for another participant to stop sharing.`,
        );
      }
      canPublish = false;
    } else {
      canPublish = true;
    }
  }

  return {
    roomCode: args.roomCode,
    userId,
    name,
    role: canPublish ? "sharer" : role,
    canPublish,
    canPublishData: true,
    canSubscribe: true,
    isHost: false,
    workspaceId: room.workspaceId,
  };
}

export async function generateLiveKitJwt(
  participant: LiveKitParticipantValidation,
  env?: { apiKey?: string; apiSecret?: string; ttl?: string },
): Promise<string> {
  // Fail fast in production: a missing LiveKit credential must throw loudly, not
  // silently mint tokens with the devkey/secret fallback that the real SFU will
  // reject (masking misconfiguration as a client-side auth error). Local dev and
  // tests intentionally fall back to devkey/secret (the infra module runs LiveKit
  // with those exact creds).
  const apiKey = env?.apiKey || process.env.LIVEKIT_API_KEY;
  const apiSecret = env?.apiSecret || process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret || apiKey === "devkey" || apiSecret === "secret") {
    throw new Error(
      "Insecure or missing LiveKit credentials. LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be configured with secure production keys (devkey/secret are strictly prohibited)."
    );
  }
  const ttl = env?.ttl || LIVEKIT_TOKEN_TTL;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: participant.userId,
    name: participant.name,
    ttl,
  });

  at.addGrant({
    room: participant.roomCode,
    roomJoin: true,
    canPublish: participant.canPublish,
    canPublishSources: participant.canPublish
      ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
      : [],
    canSubscribe: participant.canSubscribe,
    canPublishData: participant.canPublishData,
    roomAdmin: participant.isHost,
  });

  return await at.toJwt();
}

export async function issueLiveKitToken(
  ctx: MutationCtx,
  args: { roomCode: string; requestPublish?: boolean },
) {
  const userId = await requireAuth(ctx);
  await rateLimit(ctx, `lktoken:${userId}`, 10, 60_000);

  const participant = await validateParticipantForLiveKit(ctx, args);
  const now = Date.now();

  let isGrantChange = true;
  // Map presence into screenshareViewers so caller is registered in Convex
  if (!participant.isHost) {
    const existing = await ctx.db
      .query("screenshareViewers")
      .withIndex("by_room_viewer", (q) =>
        q.eq("roomCode", args.roomCode).eq("viewerId", participant.userId),
      )
      .first();

    if (existing) {
      if (
        existing.role === (participant.canPublish ? "sharer" : existing.role) &&
        Boolean(existing.isSharing) === participant.canPublish
      ) {
        isGrantChange = false;
      }
      await ctx.db.patch(existing._id, {
        name: participant.name,
        role: participant.canPublish ? "sharer" : existing.role,
        isSharing: participant.canPublish ? true : existing.isSharing,
        status: "active",
        lastPingAt: now,
      });
    } else {
      await ctx.db.insert("screenshareViewers", {
        roomCode: args.roomCode,
        viewerId: participant.userId,
        name: participant.name,
        role: participant.canPublish ? "sharer" : "viewer",
        isSharing: participant.canPublish,
        status: "active",
        lastPingAt: now,
      });
    }
  }

  const token = await generateLiveKitJwt(participant);
  // Fail fast on a missing LiveKit URL in production — clients must never silently
  // receive ws://127.0.0.1:7880 and try to connect to their own machine.
  if (process.env.NODE_ENV === "production" && !process.env.LIVEKIT_URL && !process.env.NEXT_PUBLIC_LIVEKIT_URL) {
    throw new Error("LIVEKIT_URL is required in production");
  }
  const livekitUrl =
    process.env.LIVEKIT_URL ||
    process.env.NEXT_PUBLIC_LIVEKIT_URL ||
    "ws://127.0.0.1:7880";

  // Only audit log on first issue or grant change to avoid log flooding on routine token refresh
  if (isGrantChange) {
    await auditScreenshare(
      ctx,
      participant.workspaceId,
      participant.userId,
      "livekit.token_issued",
      {
        roomCode: participant.roomCode,
        role: participant.role,
        canPublish: participant.canPublish,
      },
    );
  }

  return {
    token,
    url: livekitUrl,
    identity: participant.userId,
    name: participant.name,
    role: participant.role,
    canPublish: participant.canPublish,
    canSubscribe: participant.canSubscribe,
    isHost: participant.isHost,
  };
}
