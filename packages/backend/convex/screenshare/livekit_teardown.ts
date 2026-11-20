import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { isScreenshareSchedulingDisabled } from "./lib";

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60 * 60_000;
const ATTEMPT_LEASE_MS = 2 * 60_000;

export function liveKitTeardownRetryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

async function scheduleTeardown(ctx: MutationCtx, roomCode: string, delayMs: number) {
  if (isScreenshareSchedulingDisabled()) return;
  try {
    await ctx.scheduler.runAfter(delayMs, internal.screenshare.teardownLiveKitRoomAction, { roomCode });
  } catch (error) {
    console.error(
      `[livekit-teardown] Failed to schedule room ${roomCode}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function enqueueLiveKitTeardown(ctx: MutationCtx, roomCode: string) {
  const now = Date.now();
  const existing = await ctx.db
    .query("screenshareLiveKitTeardowns")
    .withIndex("by_room", (q) => q.eq("roomCode", roomCode))
    .unique();

  if (!existing) {
    await ctx.db.insert("screenshareLiveKitTeardowns", {
      roomCode,
      status: "pending",
      attempts: 0,
      requestedAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
  } else if (existing.status !== "succeeded") {
    await ctx.db.patch(existing._id, {
      status: "pending",
      updatedAt: now,
      nextAttemptAt: Math.min(existing.nextAttemptAt, now),
      leaseUntil: undefined,
    });
  }

  if (!existing || existing.status !== "succeeded") {
    await scheduleTeardown(ctx, roomCode, 0);
  }
}

export const claimLiveKitTeardown = internalMutation({
  args: { roomCode: v.string() },
  handler: async (ctx, { roomCode }) => {
    const now = Date.now();
    let teardown = await ctx.db
      .query("screenshareLiveKitTeardowns")
      .withIndex("by_room", (q) => q.eq("roomCode", roomCode))
      .unique();

    if (!teardown) {
      const id = await ctx.db.insert("screenshareLiveKitTeardowns", {
        roomCode,
        status: "pending",
        attempts: 0,
        requestedAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      });
      teardown = await ctx.db.get(id);
    }

    if (!teardown || teardown.status === "succeeded") return null;
    if (teardown.nextAttemptAt > now || (teardown.leaseUntil ?? 0) > now) return null;

    const attempts = teardown.attempts + 1;
    await ctx.db.patch(teardown._id, {
      status: "pending",
      attempts,
      lastAttemptAt: now,
      updatedAt: now,
      leaseUntil: now + ATTEMPT_LEASE_MS,
    });
    return { teardownId: teardown._id, attempts };
  },
});

export const recordLiveKitTeardownSuccess = internalMutation({
  args: {
    teardownId: v.id("screenshareLiveKitTeardowns"),
  },
  handler: async (ctx, { teardownId }) => {
    const teardown = await ctx.db.get(teardownId);
    if (!teardown || teardown.status === "succeeded") return;
    const now = Date.now();
    await ctx.db.patch(teardownId, {
      status: "succeeded",
      updatedAt: now,
      completedAt: now,
      leaseUntil: undefined,
      lastError: undefined,
      failureKind: undefined,
    });
  },
});

export const recordLiveKitTeardownRetry = internalMutation({
  args: {
    teardownId: v.id("screenshareLiveKitTeardowns"),
    attempts: v.number(),
    failureKind: v.union(v.literal("auth"), v.literal("transient")),
    error: v.string(),
  },
  handler: async (ctx, { teardownId, attempts, failureKind, error }) => {
    const teardown = await ctx.db.get(teardownId);
    if (!teardown || teardown.status === "succeeded" || teardown.attempts !== attempts) return;
    const delayMs = liveKitTeardownRetryDelay(attempts);
    const now = Date.now();
    await ctx.db.patch(teardownId, {
      status: "pending",
      updatedAt: now,
      nextAttemptAt: now + delayMs,
      leaseUntil: undefined,
      failureKind,
      lastError: error.slice(0, 1_000),
    });
    await scheduleTeardown(ctx, teardown.roomCode, delayMs);
  },
});

export const dispatchDueLiveKitTeardowns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("screenshareLiveKitTeardowns")
      .withIndex("by_status_due", (q) => q.eq("status", "pending").lte("nextAttemptAt", now))
      .take(100);

    for (const teardown of due) {
      if ((teardown.leaseUntil ?? 0) > now) continue;
      await scheduleTeardown(ctx, teardown.roomCode, 0);
    }

    return { due: due.length };
  },
});
