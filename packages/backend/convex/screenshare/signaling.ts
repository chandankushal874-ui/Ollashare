import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { displayName, getRoomByCode, rateLimit, requireAuth, requireRoomParticipant } from "./lib";

const SIGNAL_TYPES = new Set(["offer", "answer", "candidate"]);
const MAX_PAYLOAD_CHARS = 32 * 1024;
const MAX_DEVICE_ID_CHARS = 160;
const MAX_SDP_CHARS = 24 * 1024;
const MAX_CANDIDATE_CHARS = 4096;
const MAX_LABEL_CHARS = 120;

type SignalType = "offer" | "answer" | "candidate";
type JsonRecord = Record<string, unknown>;

function invalidPayload(): never {
  throw new ConvexError("Invalid signal payload");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBoundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalidPayload();
  return value;
}

function parseDescription(value: unknown, expectedType: "offer" | "answer") {
  if (!isRecord(value) || value.type !== expectedType) invalidPayload();
  return {
    type: expectedType,
    sdp: requireBoundedString(value.sdp, MAX_SDP_CHARS),
  };
}

function parseCandidate(value: unknown) {
  if (!isRecord(value)) invalidPayload();
  const candidate = requireBoundedString(value.candidate, MAX_CANDIDATE_CHARS);
  const sdpMid = value.sdpMid;
  const sdpMLineIndex = value.sdpMLineIndex;
  const usernameFragment = value.usernameFragment;
  if (sdpMid !== undefined && sdpMid !== null && (typeof sdpMid !== "string" || sdpMid.length > MAX_LABEL_CHARS)) invalidPayload();
  if (sdpMLineIndex !== undefined && sdpMLineIndex !== null && (!Number.isInteger(sdpMLineIndex) || (sdpMLineIndex as number) < 0 || (sdpMLineIndex as number) > 65535)) invalidPayload();
  if (usernameFragment !== undefined && usernameFragment !== null && (typeof usernameFragment !== "string" || usernameFragment.length > MAX_LABEL_CHARS)) invalidPayload();
  return {
    candidate,
    ...(sdpMid !== undefined ? { sdpMid } : {}),
    ...(sdpMLineIndex !== undefined ? { sdpMLineIndex } : {}),
    ...(usernameFragment !== undefined ? { usernameFragment } : {}),
  };
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) invalidPayload();
  return value;
}

function optionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalidPayload();
  return value;
}

export function validateSignalPayload(
  type: SignalType,
  raw: string,
  senderId: string,
  isHost: boolean,
  user: { name?: string; username?: string; email?: string } | null = null,
): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidPayload();
  }
  if (!isRecord(value)) invalidPayload();
  const deviceId = requireBoundedString(value.deviceId, MAX_DEVICE_ID_CHARS);

  if (type === "offer") {
    const offer = parseDescription(value.offer, "offer");
    if (deviceId === "mira-chat-p2p") return JSON.stringify({ offer, deviceId });
    if (!isRecord(value.device) || value.device.id !== deviceId) invalidPayload();
    const deviceName = optionalString(value.device.deviceName, MAX_LABEL_CHARS);
    return JSON.stringify({
      offer,
      deviceId,
      device: {
        id: deviceId,
        ...(deviceName !== undefined ? { deviceName } : {}),
        ownerId: senderId,
        ownerName: displayName(user),
        isHost,
        ...(optionalString(value.device.resolution, 32) !== undefined ? { resolution: value.device.resolution } : {}),
        ...(optionalNumber(value.device.fps, 1, 240) !== undefined ? { fps: value.device.fps } : {}),
        ...(optionalNumber(value.device.startedAt, 0, Date.now() + 60_000) !== undefined ? { startedAt: value.device.startedAt } : {}),
      },
    });
  }
  if (type === "answer") {
    return JSON.stringify({ answer: parseDescription(value.answer, "answer"), deviceId });
  }
  if (value.direction !== undefined && value.direction !== "in" && value.direction !== "out") invalidPayload();
  return JSON.stringify({
    candidate: parseCandidate(value.candidate),
    deviceId,
    ...(value.direction !== undefined ? { direction: value.direction } : {}),
  });
}

export const sendSignalArgs = {
  roomCode: v.string(),
  type: v.union(v.literal("offer"), v.literal("answer"), v.literal("candidate")),
  to: v.optional(v.id("users")),
  payload: v.string(),
};

export async function sendSignal(
  ctx: MutationCtx,
  args: ObjectType<typeof sendSignalArgs>,
) {
  await requireAuth(ctx);
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) throw new ConvexError("Room not found");
  if (room.status !== "live") throw new ConvexError("Room is not live");
  const senderId = await requireRoomParticipant(
    ctx,
    args.roomCode,
    room.workspaceId,
  );

  if (!SIGNAL_TYPES.has(args.type)) {
    throw new ConvexError("Invalid signal type");
  }
  if (args.payload.length > MAX_PAYLOAD_CHARS) {
    throw new ConvexError("Payload too large");
  }
  // A targeted signal must address a real participant of this room.
  if (args.to !== undefined) {
    const to = args.to;
    const target = await ctx.db
      .query("screenshareViewers")
      .withIndex("by_room_viewer", (q) =>
        q.eq("roomCode", args.roomCode).eq("viewerId", to),
      )
      .first();
    const ban = target && await ctx.db.query("screenshareBans")
      .withIndex("by_room_viewer", (q) =>
        q.eq("roomCode", args.roomCode).eq("viewerId", target.viewerId),
      ).first();
    if (!target || target.status === "kicked" || (ban && ban.expiresAt > Date.now())) {
      throw new ConvexError("Unknown signal target");
    }
  }

  const user = await ctx.db.get(senderId);
  const payload = validateSignalPayload(
    args.type,
    args.payload,
    senderId,
    senderId === room.hostId,
    user,
  );

  // Signaling is handshake-frequency, but throttle floods anyway.
  await rateLimit(ctx, `signal:${args.roomCode}:${senderId}`, 60, 10_000);

  return await ctx.db.insert("screenshareSignals", {
    roomCode: args.roomCode,
    senderId,
    type: args.type,
    to: args.to,
    payload,
    timestamp: Date.now(),
  });
}

export const getSignalsArgs = {
  roomCode: v.string(),
  since: v.optional(v.number()),
};

export async function getSignals(
  ctx: QueryCtx,
  args: ObjectType<typeof getSignalsArgs>,
) {
  await requireAuth(ctx);
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) return [];
  const userId = await requireRoomParticipant(ctx, args.roomCode, room.workspaceId);

  // Reactive full-fetch for WebRTC signaling. The client subscribes with only
  // { roomCode } and dedupes by _id, so we MUST return the NEWEST signals first:
  // a `.order("asc").take(200)` would return the 200 OLDEST rows forever, and once
  // a room exceeds 200 signals the newest offers/candidates would be silently
  // pushed past the cap and never delivered (broken handshakes).
  //
  // No `_id` cursor here: the client doesn't paginate (it re-runs reactively), and
  // the old `_id > cursor` filter was applied AFTER the index scan (a `.filter`
  // that then `.take(200)`-ed the wrong rows) — removed rather than kept broken.
  // `since` is index-ranged on by_room_time ([roomCode, timestamp]) and safe.
  const query = ctx.db
    .query("screenshareSignals")
    .withIndex("by_room_time", (q) => {
      const b = q.eq("roomCode", args.roomCode);
      return args.since !== undefined ? b.gte("timestamp", args.since) : b;
    });

  // Filter BEFORE the cap: unrelated private traffic must neither leak nor
  // displace the caller's visible offers/candidates from the reactive window.
  return await query.order("desc").filter((q) => q.or(
    q.eq(q.field("to"), undefined),
    q.eq(q.field("to"), userId),
    q.eq(q.field("senderId"), userId),
  )).take(200);
}
