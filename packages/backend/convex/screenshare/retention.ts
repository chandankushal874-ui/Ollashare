import { internalMutation } from "../_generated/server";

// Retention: bounds the growth of the signaling table. `screenshareSignals`
// rows are only needed for the WebRTC handshake, so a short TTL is enough.
// This cleanup is invoked by a cron (see crons.ts).

const SIGNALS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BATCH = 1000;

export const cleanupScreenshareData = internalMutation({
  args: {},
  handler: async (ctx) => {
    const staleMessages = await ctx.db.query('screenshareMessages').withIndex('by_time', (q) => q.lt('timestamp', Date.now() - 7 * 24 * 60 * 60_000)).take(500);
    for (const row of staleMessages) await ctx.db.delete(row._id);
    const cutoff = Date.now() - SIGNALS_TTL_MS;

    // Loop until the backlog is clear: a single 1000-row batch can't keep up
    // with a busy mesh otherwise.
    let deleted = 0;
    for (let i = 0; i < 10; i++) {
      const stale = await ctx.db
        .query("screenshareSignals")
        .withIndex("by_time", (q) => q.lt("timestamp", cutoff))
        .take(BATCH);
      for (const doc of stale) {
        await ctx.db.delete(doc._id);
      }
      deleted += stale.length;
      if (stale.length < BATCH) break;
    }

    // Prune stale GUEST viewers (host rows are exempt: autoEndStaleRoomsHandler
    // relies on the host's viewer row to detect a live-but-orphaned room, and
    // pruning it here would spuriously end a healthy room).
    const staleViewers = await ctx.db
      .query("screenshareViewers")
      .withIndex('by_last_ping', (q) => q.lt('lastPingAt', cutoff))
      .filter((q) =>
        q.neq(q.field("role"), "host"),
      )
      .take(BATCH);
    for (const doc of staleViewers) {
      await ctx.db.delete(doc._id);
    }

    // Prune expired bans. Permanent bans (expiresAt === 0) must NEVER be deleted:
    // 0 <= now is always true, so without the >0 guard they'd be dropped on the
    // first run.
    const now = Date.now();
    const expiredBans = await ctx.db
      .query("screenshareBans")
      .withIndex("by_expires", (q) => q.lte("expiresAt", now))
      .filter((q) => q.gt(q.field("expiresAt"), 0))
      .take(BATCH);
    for (const doc of expiredBans) {
      await ctx.db.delete(doc._id);
    }

    // Issue 8: Prune expired rateLimits whose window has lapsed.
    const expiredRateLimits = await ctx.db
      .query("rateLimits")
      .withIndex("by_reset", (q) => q.lt("resetAt", now))
      .take(BATCH);
    for (const doc of expiredRateLimits) {
      await ctx.db.delete(doc._id);
    }

    return {
      signalsDeleted: deleted,
      viewersDeleted: staleViewers.length,
      bansDeleted: expiredBans.length,
      rateLimitsDeleted: expiredRateLimits.length,
    };
  },
});


export const cleanupAuditResidue = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Clean test rooms identified in audit (MIRA-623-MMB-EB7, MIRA-2JB-AZT-HUG, MIRA-QQM-RTH-FWT)
    const testRoomCodes = ["MIRA-623-MMB-EB7", "MIRA-2JB-AZT-HUG", "MIRA-QQM-RTH-FWT"];
    let roomsDeleted = 0;
    let viewersDeleted = 0;
    let signalsDeleted = 0;

    for (const code of testRoomCodes) {
      const room = await ctx.db
        .query("screenshareRooms")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (room) {
        await ctx.db.delete(room._id);
        roomsDeleted++;
      }
      const viewers = await ctx.db.query("screenshareViewers").withIndex('by_room_ping', (q) => q.eq('roomCode', code)).take(BATCH);
      for (const v of viewers) {
        await ctx.db.delete(v._id);
        viewersDeleted++;
      }
      const signals = await ctx.db.query("screenshareSignals").withIndex('by_room', (q) => q.eq('roomCode', code)).take(BATCH);
      for (const s of signals) {
        await ctx.db.delete(s._id);
        signalsDeleted++;
      }
    }

    // Also prune stale anonymous users that have no active rooms or sessions older than 2 hours
    const staleCutoff = Date.now() - 2 * 3600_000;
    const anonUsers = await ctx.db
      .query("users")
      .filter((q) => q.and(q.eq(q.field("isAnonymous"), true), q.lt(q.field("_creationTime"), staleCutoff)))
      .take(100);

    let usersDeleted = 0;
    for (const u of anonUsers) {
      // Check if user has active live rooms
      const activeLive = await ctx.db
        .query("screenshareRooms")
        .withIndex("by_status", (q) => q.eq("status", "live"))
        .filter((q) => q.eq(q.field("hostId"), u._id))
        .first();
      if (!activeLive) {
        // delete member / workspaces
        const mems = await ctx.db
          .query("members")
          .withIndex("by_user", (q) => q.eq("userId", u._id))
          .take(100);
        for (const m of mems) {
          const ws = await ctx.db.get(m.workspaceId);
          if (ws && ws.name === "Personal") {
            await ctx.db.delete(ws._id);
          }
          await ctx.db.delete(m._id);
        }
        await ctx.db.delete(u._id);
        usersDeleted++;
      }
    }

    return { roomsDeleted, viewersDeleted, signalsDeleted, usersDeleted };
  },
});
