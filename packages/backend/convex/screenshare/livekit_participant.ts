import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { isScreenshareSchedulingDisabled } from "./lib";

export type LiveKitParticipantOperationKind = "downgrade" | "evict";

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60 * 60_000;
const ATTEMPT_LEASE_MS = 2 * 60_000;

export function liveKitParticipantOperationKey(
  operationKind: LiveKitParticipantOperationKind,
  roomCode: string,
  identity: string,
): string {
  return `${operationKind}:${roomCode}:${identity}`;
}

export function liveKitParticipantRetryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

async function scheduleParticipantOperation(ctx: MutationCtx, operationKey: string, delayMs: number) {
  if (isScreenshareSchedulingDisabled()) return;
  try {
    await ctx.scheduler.runAfter(delayMs, internal.screenshare.liveKitParticipantOperationAction, {
      operationKey,
    });
  } catch (error) {
    console.error(
      `[livekit-participant] Failed to schedule operation ${operationKey}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function enqueueLiveKitParticipantOperation(
  ctx: MutationCtx,
  args: {
    operationKind: LiveKitParticipantOperationKind;
    roomCode: string;
    identity: string;
    reason: string;
  },
) {
  const now = Date.now();
  const operationKey = liveKitParticipantOperationKey(
    args.operationKind,
    args.roomCode,
    args.identity,
  );
  const existing = await ctx.db
    .query("screenshareLiveKitParticipantOperations")
    .withIndex("by_key", (q) => q.eq("operationKey", operationKey))
    .unique();

  if (!existing) {
    await ctx.db.insert("screenshareLiveKitParticipantOperations", {
      operationKey,
      operationKind: args.operationKind,
      roomCode: args.roomCode,
      identity: args.identity,
      reason: args.reason,
      status: "pending",
      attempts: 0,
      requestedAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
  } else if (existing.status === "succeeded") {
    await ctx.db.patch(existing._id, {
      reason: args.reason,
      status: "pending",
      attempts: 0,
      requestedAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      lastAttemptAt: undefined,
      completedAt: undefined,
      leaseUntil: undefined,
      failureKind: undefined,
      lastError: undefined,
    });
  } else {
    await ctx.db.patch(existing._id, {
      reason: args.reason,
      updatedAt: now,
      nextAttemptAt: Math.min(existing.nextAttemptAt, now),
      ...((existing.leaseUntil ?? 0) <= now ? { leaseUntil: undefined } : {}),
    });
  }

  await scheduleParticipantOperation(ctx, operationKey, 0);
  return operationKey;
}

export async function enqueueLiveKitParticipantEvictionsForUser(
  ctx: MutationCtx,
  args: { userId: Id<"users">; reason: string },
) {
  const viewers = await ctx.db
    .query("screenshareViewers")
    .withIndex("by_viewer", (q) => q.eq("viewerId", args.userId))
    .collect();
  const roomCodes = [...new Set(viewers.map((viewer) => viewer.roomCode))];
  for (const roomCode of roomCodes) {
    await enqueueLiveKitParticipantOperation(ctx, {
      operationKind: "evict",
      roomCode,
      identity: args.userId,
      reason: args.reason,
    });
  }
  return roomCodes.length;
}

export const enqueueLiveKitParticipantOperationMutation = internalMutation({
  args: {
    operationKind: v.union(v.literal("downgrade"), v.literal("evict")),
    roomCode: v.string(),
    identity: v.string(),
    reason: v.string(),
  },
  handler: enqueueLiveKitParticipantOperation,
});

export const claimLiveKitParticipantOperation = internalMutation({
  args: { operationKey: v.string() },
  handler: async (ctx, { operationKey }) => {
    const now = Date.now();
    const operation = await ctx.db
      .query("screenshareLiveKitParticipantOperations")
      .withIndex("by_key", (q) => q.eq("operationKey", operationKey))
      .unique();

    if (!operation || operation.status === "succeeded") return null;
    if (operation.nextAttemptAt > now || (operation.leaseUntil ?? 0) > now) return null;

    const attempts = operation.attempts + 1;
    await ctx.db.patch(operation._id, {
      attempts,
      lastAttemptAt: now,
      updatedAt: now,
      leaseUntil: now + ATTEMPT_LEASE_MS,
    });
    return {
      operationId: operation._id,
      operationKind: operation.operationKind,
      roomCode: operation.roomCode,
      identity: operation.identity,
      attempts,
    };
  },
});

export const recordLiveKitParticipantOperationSuccess = internalMutation({
  args: {
    operationId: v.id("screenshareLiveKitParticipantOperations"),
    attempts: v.number(),
  },
  handler: async (ctx, { operationId, attempts }) => {
    const operation = await ctx.db.get(operationId);
    if (!operation || operation.status === "succeeded" || operation.attempts !== attempts) return;
    const now = Date.now();
    await ctx.db.patch(operationId, {
      status: "succeeded",
      updatedAt: now,
      completedAt: now,
      leaseUntil: undefined,
      failureKind: undefined,
      lastError: undefined,
    });
  },
});

export const recordLiveKitParticipantOperationRetry = internalMutation({
  args: {
    operationId: v.id("screenshareLiveKitParticipantOperations"),
    attempts: v.number(),
    failureKind: v.union(v.literal("auth"), v.literal("transient")),
    error: v.string(),
  },
  handler: async (ctx, { operationId, attempts, failureKind, error }) => {
    const operation = await ctx.db.get(operationId);
    if (!operation || operation.status === "succeeded" || operation.attempts !== attempts) return;
    const delayMs = liveKitParticipantRetryDelay(attempts);
    const now = Date.now();
    await ctx.db.patch(operationId, {
      status: "pending",
      updatedAt: now,
      nextAttemptAt: now + delayMs,
      leaseUntil: undefined,
      failureKind,
      lastError: error.slice(0, 1_000),
    });
    await scheduleParticipantOperation(ctx, operation.operationKey, delayMs);
  },
});

export const dispatchDueLiveKitParticipantOperations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("screenshareLiveKitParticipantOperations")
      .withIndex("by_status_due", (q) => q.eq("status", "pending").lte("nextAttemptAt", now))
      .take(100);

    for (const operation of due) {
      if ((operation.leaseUntil ?? 0) > now) continue;
      await scheduleParticipantOperation(ctx, operation.operationKey, 0);
    }

    return { due: due.length };
  },
});
