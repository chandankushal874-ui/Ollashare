import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  auditScreenshare,
  displayName,
  getRoomByCode,
  rateLimit,
  requireAuth,
  requireHost,
  requireRoomParticipant,
} from "./lib";
import { enqueueLiveKitTeardown } from "./livekit_teardown";

const ANNOTATION_EVENT_TTL_MS = 15 * 60_000;
const MAX_EVENTS_PER_TARGET = 500;
const MAX_ACTIVE_TARGETS = 4;
const MAX_QUERY_EVENTS = MAX_EVENTS_PER_TARGET * MAX_ACTIVE_TARGETS;
const MAX_POINTS = 256;
const MAX_QUERY_POINTS_PER_TARGET = 16_384;
const MAX_QUERY_POINTS = MAX_QUERY_POINTS_PER_TARGET * MAX_ACTIVE_TARGETS;
const MAX_STROKE_ID_LENGTH = 128;
const MAX_TARGET_ID_LENGTH = 128;
const MAX_BATCH_SIZE = 16;
const MIN_HIGHLIGHTER_OPACITY = 0.1;
const MAX_HIGHLIGHTER_OPACITY = 0.6;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:;-]*$/;

export const annotationTargetKind = v.union(v.literal("screen"), v.literal("shared-browser"));
const annotationTarget = v.object({
  targetKind: annotationTargetKind,
  targetId: v.string(),
});
const annotationStrokeTool = v.union(v.literal("pen"), v.literal("highlighter"));
export const grantAnnotationArgs = {
  roomCode: v.string(),
  viewerId: v.id("users"),
  targetKind: annotationTargetKind,
  targetId: v.optional(v.string()),
};
export const revokeAnnotationArgs = grantAnnotationArgs;
export const getAnnotationPermissionArgs = {
  roomCode: v.string(),
  targetKind: annotationTargetKind,
  targetId: v.optional(v.string()),
  viewerId: v.optional(v.id("users")),
};
const annotationOperation = v.union(
  v.object({
    kind: v.literal("stroke"),
    strokeId: v.string(),
    color: v.string(),
    width: v.number(),
    tool: v.optional(annotationStrokeTool),
    opacity: v.optional(v.number()),
    points: v.array(v.object({ u: v.number(), v: v.number() })),
  }),
  v.object({ kind: v.literal("erase"), strokeId: v.string() }),
  v.object({ kind: v.literal("clear"), scope: v.union(v.literal("own"), v.literal("all")) }),
);
export const appendAnnotationEventsArgs = {
  roomCode: v.string(),
  targetKind: annotationTargetKind,
  targetId: v.string(),
  operations: v.array(annotationOperation),
};
export const listAnnotationEventsArgs = {
  roomCode: v.string(),
  targets: v.array(annotationTarget),
  afterSequence: v.optional(v.number()),
};

type TargetArgs = ObjectType<typeof grantAnnotationArgs>;
type AnnotationTargetArgs = Pick<TargetArgs, "roomCode" | "targetKind" | "targetId">;
type AppendArgs = ObjectType<typeof appendAnnotationEventsArgs>;

function assertBoundedTargetId(targetId: string) {
  if (!targetId || targetId.length > MAX_TARGET_ID_LENGTH || !TARGET_ID_PATTERN.test(targetId)) {
    throw new ConvexError("Invalid annotation target");
  }
}

async function validateTarget(ctx: MutationCtx | QueryCtx, args: AnnotationTargetArgs) {
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room) throw new ConvexError("Room not found");
  if (room.status !== "live") throw new ConvexError("Room is not live");
  if (args.targetKind === "screen") {
    if (args.targetId) assertBoundedTargetId(args.targetId);
  } else {
    if (!args.targetId) throw new ConvexError("Shared browser target is required");
    assertBoundedTargetId(args.targetId);
    const session = await ctx.db.get(args.targetId as Id<"sharedBrowserSessions">);
    if (!session || session.roomCode !== args.roomCode || session.status !== "active") {
      throw new ConvexError("Shared browser session is not active in this room");
    }
  }
  return room;
}

async function findPermission(ctx: QueryCtx | MutationCtx, roomCode: string, userId: Id<"users">, targetKind: string, targetId?: string) {
  const exact = await ctx.db.query("screenshareAnnotationPermissions")
    .withIndex("by_room_target", (q) => q.eq("roomCode", roomCode).eq("targetKind", targetKind).eq("targetId", targetId))
    .filter((q) => q.eq(q.field("userId"), userId))
    .first();
  if (exact) return exact;
  if (targetId !== undefined) {
    return await ctx.db.query("screenshareAnnotationPermissions")
      .withIndex("by_room_target", (q) => q.eq("roomCode", roomCode).eq("targetKind", targetKind).eq("targetId", undefined))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();
  }
  return null;
}

async function requireAnnotationWriter(ctx: MutationCtx, args: AnnotationTargetArgs) {
  const actorId = await requireAuth(ctx);
  const room = await validateTarget(ctx, args);
  await requireRoomParticipant(ctx, args.roomCode, room.workspaceId);
  if (actorId !== room.hostId) {
    const permission = await findPermission(ctx, args.roomCode, actorId, args.targetKind, args.targetId);
    if (!permission) throw new ConvexError("Annotation permission is required");
  }
  return { actorId, room };
}

function validateOperation(operation: AppendArgs["operations"][number]) {
  if (operation.kind === "stroke") {
    if (!operation.strokeId || operation.strokeId.length > MAX_STROKE_ID_LENGTH) throw new ConvexError("Invalid stroke id");
    if (!/^#[0-9a-f]{6}$/i.test(operation.color)) throw new ConvexError("Invalid annotation color");
    if (!Number.isFinite(operation.width) || operation.width < 1 || operation.width > 32) throw new ConvexError("Invalid annotation width");
    const tool = operation.tool ?? "pen";
    if (tool === "highlighter") {
      if (operation.opacity === undefined || !Number.isFinite(operation.opacity) || operation.opacity < MIN_HIGHLIGHTER_OPACITY || operation.opacity > MAX_HIGHLIGHTER_OPACITY) {
        throw new ConvexError("Invalid highlighter opacity");
      }
    } else if (operation.opacity !== undefined && operation.opacity !== 1) {
      throw new ConvexError("Invalid pen opacity");
    }
    if (operation.points.length < 2 || operation.points.length > MAX_POINTS) throw new ConvexError("Invalid annotation points");
    if (operation.points.some((point) => !Number.isFinite(point.u) || !Number.isFinite(point.v) || point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1)) {
      throw new ConvexError("Invalid annotation point");
    }
  } else if (operation.kind === "erase") {
    if (!operation.strokeId || operation.strokeId.length > MAX_STROKE_ID_LENGTH) throw new ConvexError("Invalid stroke id");
  }
}

async function allocateSequences(ctx: MutationCtx, roomCode: string, count: number) {
  const stream = await ctx.db.query("screenshareAnnotationStreams").withIndex("by_room", (q) => q.eq("roomCode", roomCode)).unique();
  const first = (stream?.nextSequence ?? 1);
  const nextSequence = first + count;
  if (stream) await ctx.db.patch(stream._id, { nextSequence, updatedAt: Date.now() });
  else await ctx.db.insert("screenshareAnnotationStreams", { roomCode, nextSequence, updatedAt: Date.now() });
  return first;
}

async function findLatestStrokeEvent(ctx: MutationCtx, args: { roomCode: string; targetKind: "screen" | "shared-browser"; targetId: string; strokeId: string }) {
  const rows = await ctx.db.query("screenshareAnnotationEvents")
    .withIndex("by_room_target_sequence", (q) => q.eq("roomCode", args.roomCode).eq("targetKind", args.targetKind).eq("targetId", args.targetId))
    .order("desc")
    .take(MAX_EVENTS_PER_TARGET);
  let clearedAllAt = -1;
  const clearedAuthorsAt = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "clear") {
      if (row.clearScope === "all") clearedAllAt = Math.max(clearedAllAt, row.sequence);
      else clearedAuthorsAt.set(row.actorId, Math.max(clearedAuthorsAt.get(row.actorId) ?? -1, row.sequence));
      continue;
    }
    if (row.strokeId !== args.strokeId) continue;
    if (row.kind === "erase") return null;
    if (row.kind === "stroke") {
      if (row.sequence <= clearedAllAt || row.sequence <= (clearedAuthorsAt.get(row.actorId) ?? -1)) return null;
      return row;
    }
  }
  return null;
}

async function pruneTargetEvents(ctx: MutationCtx, roomCode: string, targetKind: string, targetId: string) {
  const overflow = await ctx.db.query("screenshareAnnotationEvents")
    .withIndex("by_room_target_sequence", (q) => q.eq("roomCode", roomCode).eq("targetKind", targetKind).eq("targetId", targetId))
    .order("desc")
    .take(MAX_EVENTS_PER_TARGET + 50);
  for (const row of overflow.slice(MAX_EVENTS_PER_TARGET)) await ctx.db.delete(row._id);
}

export async function grantAnnotation(ctx: MutationCtx, args: TargetArgs) {
  const actorId = await requireAuth(ctx);
  const room = await validateTarget(ctx, args);
  await requireHost(ctx, room);
  await rateLimit(ctx, `annotation:grant:${actorId}:${args.roomCode}`, 60, 60_000);
  await requireRoomParticipant(ctx, args.roomCode, room.workspaceId);
  const target = await ctx.db.query("screenshareViewers").withIndex("by_room_viewer", (q) => q.eq("roomCode", args.roomCode).eq("viewerId", args.viewerId)).first();
  if (!target || target.status === "kicked") throw new ConvexError("Participant is not active in this room");
  const existing = await findPermission(ctx, args.roomCode, args.viewerId, args.targetKind, args.targetId);
  const now = Date.now();
  if (existing) await ctx.db.patch(existing._id, { updatedAt: now, grantedBy: actorId });
  else await ctx.db.insert("screenshareAnnotationPermissions", { roomCode: args.roomCode, userId: args.viewerId, targetKind: args.targetKind, targetId: args.targetId, grantedBy: actorId, createdAt: now, updatedAt: now });
  await auditScreenshare(ctx, room.workspaceId, actorId, "annotation.grant", { roomCode: args.roomCode, viewerId: args.viewerId, targetKind: args.targetKind, targetId: args.targetId });
  return { granted: true, viewerId: args.viewerId, targetKind: args.targetKind, targetId: args.targetId };
}

export async function revokeAnnotation(ctx: MutationCtx, args: TargetArgs) {
  const actorId = await requireAuth(ctx);
  const room = await validateTarget(ctx, args);
  await requireHost(ctx, room);
  await rateLimit(ctx, `annotation:revoke:${actorId}:${args.roomCode}`, 60, 60_000);
  const permission = await findPermission(ctx, args.roomCode, args.viewerId, args.targetKind, args.targetId);
  if (permission) await ctx.db.delete(permission._id);
  await auditScreenshare(ctx, room.workspaceId, actorId, "annotation.revoke", { roomCode: args.roomCode, viewerId: args.viewerId, targetKind: args.targetKind, targetId: args.targetId });
  return { revoked: Boolean(permission), viewerId: args.viewerId, targetKind: args.targetKind, targetId: args.targetId };
}

export async function getAnnotationPermission(ctx: QueryCtx, args: ObjectType<typeof getAnnotationPermissionArgs>) {
  const callerId = await requireAuth(ctx);
  const existingRoom = await getRoomByCode(ctx, args.roomCode);
  if (!existingRoom || existingRoom.status !== "live") return { allowed: false, isHost: false, participantIds: [] };
  const room = args.targetId ? await validateTarget(ctx, args) : existingRoom;
  await requireRoomParticipant(ctx, args.roomCode, room.workspaceId);
  const subjectId = args.viewerId ?? callerId;
  if (subjectId !== callerId && callerId !== room.hostId) throw new ConvexError("Forbidden");
  const isHost = subjectId === room.hostId;
  const permission = isHost ? null : await findPermission(ctx, args.roomCode, subjectId, args.targetKind, args.targetId);
  const exactPermissions = await ctx.db.query("screenshareAnnotationPermissions")
    .withIndex("by_room_target", (q) => q.eq("roomCode", args.roomCode).eq("targetKind", args.targetKind).eq("targetId", args.targetId))
    .collect();
  const roomWidePermissions = args.targetId === undefined
    ? []
    : await ctx.db.query("screenshareAnnotationPermissions")
      .withIndex("by_room_target", (q) => q.eq("roomCode", args.roomCode).eq("targetKind", args.targetKind).eq("targetId", undefined))
      .collect();
  const participantIds = Array.from(new Set([...exactPermissions, ...roomWidePermissions].map((row) => row.userId)));
  return { allowed: isHost || Boolean(permission), isHost, participantIds };
}

export async function appendAnnotationEvents(ctx: MutationCtx, args: AppendArgs) {
  if (args.operations.length < 1 || args.operations.length > MAX_BATCH_SIZE) throw new ConvexError("Invalid annotation batch");
  const { actorId } = await requireAnnotationWriter(ctx, args);
  await rateLimit(ctx, `annotation:event:${actorId}:${args.roomCode}`, 120, 10_000);
  for (const operation of args.operations) validateOperation(operation);
  for (const operation of args.operations) {
    if (operation.kind === "clear" && operation.scope === "all") {
      const room = await getRoomByCode(ctx, args.roomCode);
      if (!room || actorId !== room.hostId) throw new ConvexError("Only the host may clear all annotations");
    }
    if (operation.kind === "erase") {
      const stroke = await findLatestStrokeEvent(ctx, { roomCode: args.roomCode, targetKind: args.targetKind, targetId: args.targetId, strokeId: operation.strokeId });
      if (!stroke) throw new ConvexError("Annotation stroke not found");
      const room = await getRoomByCode(ctx, args.roomCode);
      if (!room || (actorId !== room.hostId && stroke.actorId !== actorId)) throw new ConvexError("Cannot erase another participant's annotation");
    }
  }
  const actor = await ctx.db.get(actorId);
  const actorName = displayName(actor).slice(0, 80);
  const firstSequence = await allocateSequences(ctx, args.roomCode, args.operations.length);
  const now = Date.now();
  const events = [];
  for (const [index, operation] of args.operations.entries()) {
    const sequence = firstSequence + index;
    const event = {
      roomCode: args.roomCode,
      targetKind: args.targetKind,
      targetId: args.targetId,
      sequence,
      actorId: String(actorId),
      actorName,
      createdAt: now,
      expiresAt: now + ANNOTATION_EVENT_TTL_MS,
      ...(operation.kind === "stroke" ? {
        kind: operation.kind,
        strokeId: operation.strokeId,
        color: operation.color,
        width: operation.width,
        tool: operation.tool ?? "pen",
        opacity: operation.tool === "highlighter" ? operation.opacity : 1,
        points: operation.points,
      } : operation.kind === "erase" ? { kind: operation.kind, strokeId: operation.strokeId } : { kind: operation.kind, clearScope: operation.scope }),
    };
    await ctx.db.insert("screenshareAnnotationEvents", event);
    events.push(event);
  }
  await pruneTargetEvents(ctx, args.roomCode, args.targetKind, args.targetId);
  return { firstSequence, lastSequence: firstSequence + args.operations.length - 1, events };
}

export async function listAnnotationEvents(ctx: QueryCtx, args: ObjectType<typeof listAnnotationEventsArgs>) {
  const room = await getRoomByCode(ctx, args.roomCode);
  if (!room || room.status !== "live") return [];
  await requireRoomParticipant(ctx, args.roomCode, room.workspaceId);
  if (args.targets.length < 1 || args.targets.length > MAX_ACTIVE_TARGETS) {
    throw new ConvexError("Invalid annotation target list");
  }
  const seenTargets = new Set<string>();
  for (const target of args.targets) {
    assertBoundedTargetId(target.targetId);
    const key = `${target.targetKind}\u0000${target.targetId}`;
    if (seenTargets.has(key)) throw new ConvexError("Duplicate annotation target");
    seenTargets.add(key);
    await validateTarget(ctx, { roomCode: args.roomCode, ...target });
  }
  const afterSequence = Math.max(0, Math.floor(args.afterSequence ?? 0));
  const retained = [];
  let totalPoints = 0;
  for (const target of args.targets) {
    const rows = await ctx.db.query("screenshareAnnotationEvents")
      .withIndex("by_room_target_sequence", (q) => q
        .eq("roomCode", args.roomCode)
        .eq("targetKind", target.targetKind)
        .eq("targetId", target.targetId)
        .gt("sequence", afterSequence))
      .order("desc")
      .take(MAX_EVENTS_PER_TARGET);
    let targetPoints = 0;
    for (const row of rows) {
      const pointCount = row.points?.length ?? 0;
      if (targetPoints + pointCount > MAX_QUERY_POINTS_PER_TARGET || totalPoints + pointCount > MAX_QUERY_POINTS) break;
      retained.push(row);
      targetPoints += pointCount;
      totalPoints += pointCount;
      if (retained.length >= MAX_QUERY_EVENTS) break;
    }
  }
  retained.sort((left, right) => left.sequence - right.sequence);
  return retained.map((row) => ({
    sequence: row.sequence,
    targetKind: row.targetKind,
    targetId: row.targetId,
    kind: row.kind,
    actorId: row.actorId,
    actorName: row.actorName,
    strokeId: row.strokeId,
    color: row.color,
    width: row.width,
    tool: row.tool,
    opacity: row.opacity,
    points: row.points,
    clearScope: row.clearScope,
    createdAt: row.createdAt,
  }));
}

export async function cleanupAnnotationEvents(ctx: MutationCtx) {
  const now = Date.now();
  const expired = await ctx.db.query("screenshareAnnotationEvents").withIndex("by_expiry", (q) => q.lt("expiresAt", now)).take(1000);
  for (const event of expired) await ctx.db.delete(event._id);
  return { deleted: expired.length };
}

export async function revokeParticipantAnnotationAccess(ctx: MutationCtx, roomCode: string, viewerId: Id<"users">) {
  const rows = await ctx.db.query("screenshareAnnotationPermissions").withIndex("by_room_user", (q) => q.eq("roomCode", roomCode).eq("userId", viewerId)).collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

export async function revokeRoomAnnotationAccess(ctx: MutationCtx, roomCode: string) {
  const rows = await ctx.db.query("screenshareAnnotationPermissions").withIndex("by_room_user", (q) => q.eq("roomCode", roomCode)).collect();
  for (const row of rows) await ctx.db.delete(row._id);
  const events = await ctx.db.query("screenshareAnnotationEvents").withIndex("by_room_sequence", (q) => q.eq("roomCode", roomCode)).collect();
  for (const event of events) await ctx.db.delete(event._id);
  const stream = await ctx.db.query("screenshareAnnotationStreams").withIndex("by_room", (q) => q.eq("roomCode", roomCode)).unique();
  if (stream) await ctx.db.delete(stream._id);
  const room = await getRoomByCode(ctx, roomCode);
  if (room?.status === "ended") await enqueueLiveKitTeardown(ctx, roomCode);
}
