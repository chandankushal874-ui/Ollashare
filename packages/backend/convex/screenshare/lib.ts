import { getActiveUserId as getAuthUserId } from '../activeSession';
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { audit } from "../auditLog";
import { assertRateLimit as assertPersistentRateLimit } from "../rateLimits";
import { requireMember, requireRole } from "../orgs";

// Shared helpers for the screenshare domain. Every module reaches for data and
// identity through these functions, so authorization and room lookup live in
// exactly one place. Identity is always derived from the authenticated user —
// clients can never supply their own hostId/viewerId/senderId.

// Test-only scheduling suppression. LiveKit side-effects (evict/teardown) run via
// ctx.scheduler.runAfter(0, internalAction) because RoomServiceClient uses
// setTimeout (forbidden in deterministic mutations). convex-test's scheduler
// cannot run internal actions — its async job path writes `_scheduled_functions`
// outside a transaction — so tests opt in via an EXPLICIT call, never an env-var
// name (a leaked `VITEST`/CI var must not disable scheduling in production).
let screenshareSchedulingDisabled = false;
export function disableScreenshareSchedulingForTests(): void {
  screenshareSchedulingDisabled = true;
}
export function isScreenshareSchedulingDisabled(): boolean {
  return screenshareSchedulingDisabled;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous, URL-safe (no I/O/0/1)

// Generates a high-entropy, unguessable room code via crypto randomness.
export function generateRoomCode(): string {
  const cryptoObj = (
    globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => void } }
  ).crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") {
    throw new Error("Secure randomness unavailable");
  }
  const bytes = new Uint8Array(15);
  cryptoObj.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? "A";
  }
  // 15 base32 characters provide approximately 75 bits of entropy while retaining readability.
  return `MIRA-${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10, 15)}`;
}

export async function getRoomByCode(ctx: QueryCtx, code: string) {
  return ctx.db
    .query("screenshareRooms")
    .withIndex("by_code", (q) => q.eq("code", code))
    .first();
}

/** Throws if there is no authenticated user; returns their userId. */
export async function requireAuth(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not authenticated");
  return userId;
}

/** Requires an authenticated member of the given workspace. */
export async function requireScreenshareMember(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Id<"users">> {
  const userId = await requireAuth(ctx);
  await requireMember(ctx, userId, workspaceId);
  const user = await ctx.db.get(userId);
  if (!user || user.isAnonymous) throw new ConvexError('A registered account is required to host');
  return userId;
}

export async function assertAnonymousInviteBinding(
  ctx: QueryCtx,
  user: {
    _id: Id<"users">;
    anonymousInviteRoomCode?: string;
    anonymousInviteTokenHash?: string;
    anonymousInviteExpiresAt?: number;
    anonymousInviteId?: Id<"screenshareGuestInvites">;
    anonymousAdmissionRequestId?: Id<"screenshareGuestAdmissionRequests">;
    anonymousInviteVersion?: number;
  },
  roomCode: string,
) {
  const now = Date.now();
  if (user.anonymousInviteRoomCode !== roomCode || !user.anonymousInviteExpiresAt || user.anonymousInviteExpiresAt <= now) {
    throw new ConvexError("Guest invitation is no longer valid");
  }
  const legacyTokenHash = user.anonymousInviteTokenHash;
  const invite = user.anonymousInviteId
    ? await ctx.db.get(user.anonymousInviteId)
    : legacyTokenHash
      ? await ctx.db.query("screenshareGuestInvites")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", legacyTokenHash))
        .unique()
      : null;
  if (!invite || invite.roomCode !== roomCode || invite.revokedAt !== undefined || invite.expiresAt <= now) {
    throw new ConvexError("Guest invitation is no longer valid");
  }
  if ((user.anonymousInviteVersion ?? 1) >= 2) {
    if (!user.anonymousAdmissionRequestId) throw new ConvexError("Guest invitation is no longer valid");
    const request = await ctx.db.get(user.anonymousAdmissionRequestId);
    if (
      !request ||
      request.status !== "consumed" ||
      request.boundUserId !== user._id ||
      request.inviteId !== invite._id ||
      request.roomCode !== roomCode
    ) throw new ConvexError("Guest invitation is no longer valid");
  }
}

/**
 * Requires an authenticated user who may participate in the given room: either
 * a workspace member, OR a guest who already joined through a bound invitation.
 */
export async function requireRoomParticipant(
  ctx: QueryCtx,
  roomCode: string,
  workspaceId: Id<"workspaces">,
): Promise<Id<"users">> {
  const userId = await requireAuth(ctx);
  const user = await ctx.db.get(userId);
  if (user?.isAnonymous) await assertAnonymousInviteBinding(ctx, user, roomCode);

  // Moderation applies BEFORE either membership or guest authorization. A ban
  // survives presence pruning; a kick-only row denies until an explicit rejoin.
  const revoked = await ctx.db.query('workspaceRevocations').withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', userId)).unique();
  if (revoked) await requireMember(ctx, userId, workspaceId);
  const ban = await ctx.db.query("screenshareBans")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", roomCode).eq("viewerId", userId),
    ).first();
  const viewer = await ctx.db.query("screenshareViewers")
    .withIndex("by_room_viewer", (q) =>
      q.eq("roomCode", roomCode).eq("viewerId", userId),
    ).first();
  if ((ban && ban.expiresAt > Date.now()) || viewer?.status === "kicked") {
    throw new ConvexError("You have been removed from this room by the host");
  }
  if (viewer) return userId;

  // Preserve workspace-member room discovery; guests must explicitly join.
  await requireMember(ctx, userId, workspaceId);
  return userId;
}

/** Requires the caller to be the room host. */
export async function requireHost(
  ctx: QueryCtx | MutationCtx,
  room: {
    hostId: Id<"users">;
    workspaceId: Id<"workspaces">;
  },
): Promise<Id<"users">> {
  const userId = await requireAuth(ctx);
  if (userId !== room.hostId) throw new ConvexError("Forbidden");
  await requireMember(ctx, userId, room.workspaceId);
  const revoked = await ctx.db.query("workspaceRevocations")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", room.workspaceId).eq("userId", userId))
    .unique();
  if (revoked) throw new ConvexError("Forbidden");
  return userId;
}

/** Requires the caller to be the room host OR an owner/admin of the workspace. */
export async function requireHostOrAdmin(
  ctx: QueryCtx,
  room: {
    hostId: Id<"users">;
    workspaceId: Id<"workspaces">;
  },
): Promise<Id<"users">> {
  const userId = await requireAuth(ctx);
  if (userId === room.hostId) {
    await requireMember(ctx, userId, room.workspaceId);
    const revoked = await ctx.db.query("workspaceRevocations")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", room.workspaceId).eq("userId", userId))
      .unique();
    if (revoked) throw new ConvexError("Forbidden");
    return userId;
  }
  await requireRole(ctx, userId, room.workspaceId, ["owner", "admin"]);
  return userId;
}

/** Derives a display name from a user document. */
export function displayName(
  user: { name?: string; username?: string; email?: string } | null,
): string {
  if (!user) return "Unknown";
  return user.name ?? user.username ?? user.email ?? "Unknown";
}

/** Uses the single persistent transaction-safe rate-limit implementation. */
export async function rateLimit(
  ctx: MutationCtx,
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  await assertPersistentRateLimit(ctx, key, limit, windowMs);
}

const UNSAFE_DISPLAY_CODE_POINTS = new Set([
  0x00ad, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a,
  0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063,
  0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

export function sanitizeDisplayText(raw: string, maxLength: number): string {
  let out = "";
  for (const ch of raw.normalize("NFKC")) {
    const code = ch.codePointAt(0);
    if (
      code === undefined ||
      code < 32 ||
      code === 60 ||
      code === 62 ||
      (code >= 0x7f && code <= 0x9f) ||
      UNSAFE_DISPLAY_CODE_POINTS.has(code)
    ) continue;
    out += ch;
  }
  return out.trim().slice(0, maxLength);
}

export function sanitizeName(raw: string): string {
  return sanitizeDisplayText(raw, 50);
}

/** Records a screenshare security-relevant action into the audit log. */
export async function auditScreenshare(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  action: string,
  meta?: unknown,
) {
  await audit(ctx, workspaceId, userId, `screenshare.${action}`, meta);
}

export const assertRateLimit = rateLimit;
