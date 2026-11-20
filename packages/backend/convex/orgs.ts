import { ConvexError, v } from "convex/values";
import { internal } from './_generated/api';
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { getActiveUserId as getAuthUserId } from './activeSession';
import { recordRoomEnded } from "./analytics";
import { audit } from "./auditLog";
import { bump } from "./counters";
import { requireDevSeed } from "./devGuard";
import { normalizeEmail } from "./emailAddress";
import { notify } from "./notifications";
import { assertRateLimit } from "./rateLimits";
import { revokeParticipantAnnotationAccess, revokeRoomAnnotationAccess } from "./screenshare/annotations";
import { revokeGuestInvites } from "./screenshare/guestInvites";
import { isScreenshareSchedulingDisabled } from "./screenshare/lib";
import { enqueueLiveKitParticipantOperation } from "./screenshare/livekit_participant";
import { revokeParticipantSharedBrowserAccess, revokeRoomSharedBrowsers } from "./sharedBrowser";
import { normalizeWorkspaceName } from "./workspaceNames";

type Role = "owner" | "admin" | "member";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_INVITES = 100;

// There are no billing tiers yet. Ten owned active workspaces is enough for the
// current collaboration product while placing a firm bound on tenant creation.
export const MAX_OWNED_WORKSPACES = 10;
export const WORKSPACE_CREATE_BURST_LIMIT = 3;
export const WORKSPACE_CREATE_BURST_WINDOW_MS = 10 * 60_000;
export const WORKSPACE_CREATE_HOURLY_LIMIT = 10;
export const WORKSPACE_CREATE_HOURLY_WINDOW_MS = 60 * 60_000;
export const WORKSPACE_CREATE_DAILY_LIMIT = 20;
export const WORKSPACE_CREATE_DAILY_WINDOW_MS = 24 * 60 * 60_000;

function isPendingInvite(invite: {
  accepted: boolean;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
}, now = Date.now()): boolean {
  const expiresAt = invite.expiresAt ?? invite.createdAt + INVITE_TTL_MS;
  return !invite.accepted && !invite.revokedAt && expiresAt > now;
}

async function membership(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  return ctx.db
    .query("members")
    .withIndex("by_user_workspace", (q) =>
      q.eq("userId", userId).eq("workspaceId", workspaceId),
    )
    .unique();
}

export async function requireRole(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  roles: Role[],
) {
  const m = await membership(ctx, userId, workspaceId);
  if (!await ctx.db.get(userId)) throw new ConvexError('Forbidden');
  if (!m || !roles.includes(m.role as Role)) throw new ConvexError("Forbidden");
  return m;
}

export async function requireMember(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  return requireRole(ctx, userId, workspaceId, ["owner", "admin", "member"]);
}

async function insertWorkspace(
  ctx: MutationCtx,
  userId: Id<"users">,
  name: string,
) {
  const now = Date.now();
  const workspaceId = await ctx.db.insert("workspaces", {
    name,
    ownerId: userId,
    createdAt: now,
  });
  await ctx.db.insert("members", {
    workspaceId,
    userId,
    role: "owner",
    createdAt: now,
  });
  await audit(ctx, workspaceId, userId, "workspace.create", { name });
  await bump(ctx, workspaceId, "members", 1);
  return workspaceId;
}

async function createPublicWorkspace(
  ctx: MutationCtx,
  userId: Id<"users">,
  requestedName: string,
) {
  const user = await ctx.db.get(userId);
  if (!user || user.isAnonymous) {
    throw new ConvexError("A registered account is required");
  }

  const name = normalizeWorkspaceName(requestedName);
  const owned = await ctx.db
    .query("workspaces")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .take(MAX_OWNED_WORKSPACES + 1);
  if (owned.length >= MAX_OWNED_WORKSPACES) {
    throw new ConvexError(`Workspace limit reached (${MAX_OWNED_WORKSPACES})`);
  }

  // These fixed-window counters are persistent in the shared rateLimits table.
  // If any later check rejects, Convex rolls the whole mutation back, including
  // earlier counter updates, so rejected creations have no persistent effects.
  await assertRateLimit(
    ctx,
    `workspace_create_burst:${userId}`,
    WORKSPACE_CREATE_BURST_LIMIT,
    WORKSPACE_CREATE_BURST_WINDOW_MS,
  );
  await assertRateLimit(
    ctx,
    `workspace_create_hour:${userId}`,
    WORKSPACE_CREATE_HOURLY_LIMIT,
    WORKSPACE_CREATE_HOURLY_WINDOW_MS,
  );
  await assertRateLimit(
    ctx,
    `workspace_create_day:${userId}`,
    WORKSPACE_CREATE_DAILY_LIMIT,
    WORKSPACE_CREATE_DAILY_WINDOW_MS,
  );

  return insertWorkspace(ctx, userId, name);
}

export const createWorkspace = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return createPublicWorkspace(ctx, userId, name);
  },
});

export const createWorkspaceForUser = internalMutation({
  args: { userId: v.id("users"), name: v.string() },
  handler: async (ctx, { userId, name }) => {
    requireDevSeed();
    const user = await ctx.db.get(userId);
    if (!user || user.isAnonymous) {
      throw new ConvexError("A registered account is required");
    }
    return insertWorkspace(ctx, userId, normalizeWorkspaceName(name));
  },
});

export const ensureWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const user = await ctx.db.get(userId);
    if (!user || user.isAnonymous) {
      throw new ConvexError("A registered account is required");
    }
    const existing = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) return existing.workspaceId;

    // The automatic path is one-time/idempotent because it only creates when the
    // user has no membership, and it obeys the same public quotas and validator.
    return createPublicWorkspace(ctx, userId, "Personal");
  },
});

export const myWorkspaces = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const mems = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out = [];
    for (const m of mems) {
      const ws = await ctx.db.get(m.workspaceId);
      if (ws) out.push({ ...ws, role: m.role });
    }
    return out;
  },
});

export const members = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    await requireMember(ctx, userId, workspaceId);
    const mems = await ctx.db
      .query("members")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const out = [];
    for (const m of mems) {
      const u = await ctx.db.get(m.userId);
      out.push({
        _id: m._id,
        role: m.role,
        email: u?.email,
        name: u?.name ?? u?.username,
      });
    }
    return out;
  },
});

// --- Invites ---

export const invite = mutation({
  args: { workspaceId: v.id("workspaces"), email: v.string(), role: v.string() },
  handler: async (ctx, { workspaceId, email, role }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await requireRole(ctx, userId, workspaceId, ["owner", "admin"]);
    if (!["admin", "member"].includes(role)) throw new ConvexError("Invalid role");
    email = normalizeEmail(email);
    if (!email || email.length > 320) throw new ConvexError("Invalid email");
    await assertRateLimit(ctx, `workspace_invite:${workspaceId}:${userId}`, 30, 3600_000);
    const existing = await ctx.db
      .query("invites")
      .withIndex("by_workspace_email", (q) =>
        q.eq("workspaceId", workspaceId).eq("email", email),
      )
      .collect();
    if (existing.some((candidate) => isPendingInvite(candidate))) {
      throw new ConvexError("Invite already pending");
    }
    const now = Date.now();
    const id = await ctx.db.insert("invites", {
      workspaceId,
      email,
      role,
      invitedBy: userId,
      accepted: false,
      expiresAt: now + INVITE_TTL_MS,
      createdAt: now,
    });
    await audit(ctx, workspaceId, userId, "member.invite", {
      email,
      role,
    });
    const invitee = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (invitee) {
      await notify(
        ctx,
        invitee._id,
        "invite",
        "Workspace invitation",
        `You were invited as ${role}`,
      );
    }
    return id;
  },
});

export const inviteForUser = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    invitedBy: v.id("users"),
    email: v.string(),
    role: v.string(),
  },
  handler: async (ctx, a) => {
    requireDevSeed();
    if (!["admin", "member"].includes(a.role)) throw new ConvexError("Invalid role");
    const email = normalizeEmail(a.email);
    if (!email || email.length > 320) throw new ConvexError("Invalid email");
    const now = Date.now();
    return ctx.db.insert("invites", {
      workspaceId: a.workspaceId,
      email,
      role: a.role,
      invitedBy: a.invitedBy,
      accepted: false,
      expiresAt: now + INVITE_TTL_MS,
      createdAt: now,
    });
  },
});

function verifiedEmailFromAccount(account: {
  provider: string;
  providerAccountId: string;
  emailVerified?: string;
}): string | null {
  const verifiedEmail = normalizeEmail(account.emailVerified);
  if (!verifiedEmail) return null;

  // Address-based credentials must prove the same address they authenticate as.
  if (account.provider === "password" || account.provider === "resend-otp") {
    return normalizeEmail(account.providerAccountId) === verifiedEmail ? verifiedEmail : null;
  }

  // Google binds its opaque provider account ID to the verified email claim stored
  // by the auth library. Unknown providers fail closed until their binding semantics
  // are explicitly reviewed here.
  return account.provider === "google" ? verifiedEmail : null;
}

async function verifiedInviteEmails(ctx: QueryCtx, userId: Id<"users">): Promise<string[]> {
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  const emails = new Set<string>();
  for (const account of accounts) {
    const email = verifiedEmailFromAccount(account);
    if (email) emails.add(email);
  }
  return [...emails];
}

/** Pending invites for a workspace (admin view). */
export const pendingInvites = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    await requireRole(ctx, userId, workspaceId, ["owner", "admin"]);
    const now = Date.now();
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(MAX_PENDING_INVITES);
    return invites.filter((invite) => isPendingInvite(invite, now));
  },
});

export const revokeInvite = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    const invite = await ctx.db.get(inviteId);
    if (!invite) throw new ConvexError("Invite not found");
    await requireRole(ctx, userId, invite.workspaceId, ["owner", "admin"]);
    if (!invite.accepted && !invite.revokedAt) {
      await ctx.db.patch(inviteId, { revokedAt: Date.now() });
      await audit(ctx, invite.workspaceId, userId, "member.invite.revoke", {
        email: invite.email,
      });
    }
  },
});

/** Pending invites addressed to an authoritative verified auth-account email. */
export const myInvites = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const emails = await verifiedInviteEmails(ctx, userId);
    if (emails.length === 0) return [];
    const now = Date.now();
    const inviteGroups = await Promise.all(emails.map((email) => ctx.db
      .query("invites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .order("desc")
      .take(MAX_PENDING_INVITES)));
    const invs = inviteGroups
      .flat()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_PENDING_INVITES);
    const out = [];
    for (const inv of invs) {
      if (!isPendingInvite(inv, now)) continue;
      const ws = await ctx.db.get(inv.workspaceId);
      out.push({
        _id: inv._id,
        role: inv.role,
        workspaceId: inv.workspaceId,
        workspaceName: ws?.name,
      });
    }
    return out;
  },
});

async function acceptInviteImpl(
  ctx: MutationCtx,
  userId: Id<"users">,
  inviteId: Id<"invites">,
) {
  const inv = await ctx.db.get(inviteId);
  if (!inv || !isPendingInvite(inv)) throw new ConvexError("Invite not found");
  // Validate stored invitations too: legacy rows must not mint a second owner.
  if (!["admin", "member"].includes(inv.role)) throw new ConvexError("Invalid role");
  const existing = await membership(ctx, userId, inv.workspaceId);
  if (!existing) {
    await ctx.db.insert("members", {
      workspaceId: inv.workspaceId,
      userId,
      role: inv.role,
      createdAt: Date.now(),
    });
    const revocation = await ctx.db
      .query("workspaceRevocations")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", inv.workspaceId).eq("userId", userId),
      )
      .unique();
    if (revocation) await ctx.db.delete(revocation._id);
    await bump(ctx, inv.workspaceId, "members", 1);
  }
  await ctx.db.patch(inviteId, { accepted: true });
  await audit(ctx, inv.workspaceId, userId, "member.join", { role: inv.role });
  return inv.workspaceId;
}

export const acceptInvite = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Invite unavailable");
    const verifiedEmails = await verifiedInviteEmails(ctx, userId);
    if (verifiedEmails.length === 0) throw new ConvexError("Verified email required");
    const inv = await ctx.db.get(inviteId);
    const inviteEmail = normalizeEmail(inv?.email);
    if (!inv || !inviteEmail || !verifiedEmails.includes(inviteEmail)) {
      throw new ConvexError("Invite unavailable");
    }
    return acceptInviteImpl(ctx, userId, inviteId);
  },
});

export const acceptInviteForUser = internalMutation({
  args: { inviteId: v.id("invites"), userId: v.id("users") },
  handler: async (ctx, { inviteId, userId }) => {
    requireDevSeed();
    return acceptInviteImpl(ctx, userId, inviteId);
  },
});

export const removeMember = mutation({
  args: { workspaceId: v.id("workspaces"), memberId: v.id("members") },
  handler: async (ctx, { workspaceId, memberId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    await requireRole(ctx, userId, workspaceId, ["owner", "admin"]);
    const m = await ctx.db.get(memberId);
    if (!m || m.workspaceId !== workspaceId) throw new ConvexError("Not found");
    if (m.role === "owner") throw new ConvexError("Cannot remove the owner");
    const now = Date.now();
    await ctx.db.delete(memberId);
    const revocation = await ctx.db.query('workspaceRevocations').withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', m.userId)).unique();
    if (revocation) await ctx.db.patch(revocation._id, { revokedAt: now });
    else await ctx.db.insert('workspaceRevocations', { workspaceId, userId: m.userId, revokedAt: now });
    const hostedRooms = await ctx.db.query("screenshareRooms")
      .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "live"))
      .collect();
    for (const room of hostedRooms) {
      if (room.hostId !== m.userId) continue;
      await recordRoomEnded(ctx, room, now);
      await ctx.db.patch(room._id, { status: "ended", endedAt: now });
      await revokeRoomSharedBrowsers(ctx, room.code, userId);
      await revokeRoomAnnotationAccess(ctx, room.code);
      await revokeGuestInvites(ctx, room.code);
      if (!isScreenshareSchedulingDisabled()) {
        await ctx.scheduler.runAfter(0, internal.screenshare.teardownLiveKitRoomAction, { roomCode: room.code });
      }
    }
    const viewers = await ctx.db.query('screenshareViewers').withIndex('by_viewer', (q) => q.eq('viewerId', m.userId)).collect();
    for (const viewer of viewers) {
      const room = await ctx.db.query('screenshareRooms').withIndex('by_code', (q) => q.eq('code', viewer.roomCode)).first();
      if (room?.workspaceId === workspaceId) {
        await ctx.db.patch(viewer._id, { status: 'kicked', isSharing: false });
        await revokeParticipantSharedBrowserAccess(ctx, viewer.roomCode, m.userId);
        await revokeParticipantAnnotationAccess(ctx, viewer.roomCode, m.userId);
        await enqueueLiveKitParticipantOperation(ctx, {
          operationKind: "evict",
          roomCode: viewer.roomCode,
          identity: String(m.userId),
          reason: "workspace-membership-removed",
        });
      }
    }
    // Rejoining later must not revive credentials issued before removal.
    const keys = await ctx.db.query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", m.userId)).collect();
    for (const key of keys) {
      if (key.workspaceId === workspaceId && !key.revoked) {
        await ctx.db.patch(key._id, { revoked: true });
      }
    }
    await bump(ctx, workspaceId, "members", -1);
    await audit(ctx, workspaceId, userId, "member.remove", { member: m.userId });
  },
});

export const changeRole = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    memberId: v.id("members"),
    role: v.string(),
  },
  handler: async (ctx, { workspaceId, memberId, role }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not authenticated");
    await requireRole(ctx, userId, workspaceId, ["owner", "admin"]);
    if (!["admin", "member"].includes(role)) throw new ConvexError("Invalid role");
    const m = await ctx.db.get(memberId);
    if (!m || m.workspaceId !== workspaceId) throw new ConvexError("Not found");
    if (m.role === "owner") throw new ConvexError("Cannot change the owner's role");
    await ctx.db.patch(memberId, { role });
    await audit(ctx, workspaceId, userId, "member.role", { member: m.userId, role });
  },
});
