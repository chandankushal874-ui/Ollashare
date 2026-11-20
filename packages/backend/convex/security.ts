import { ConvexError, v } from 'convex/values';
import { internalMutation } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { takeRateLimit } from './rateLimits';
import {
  consumeAnonymousGuestInvite,
  finalizeAnonymousAdmission,
  finalizeLegacyAnonymousInvite,
  validateAnonymousGuestInvite,
} from './screenshare/guestInvites';
import { enqueueLiveKitParticipantEvictionsForUser } from './screenshare/livekit_participant';

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function unhex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) throw new Error('Invalid encoding');
  const bytes = value.match(/../g);
  if (!bytes) throw new Error('Invalid encoding');
  return Uint8Array.from(bytes, (byte) => Number.parseInt(byte, 16));
}
export async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
export function randomSecret() { return hex(crypto.getRandomValues(new Uint8Array(32))); }

export const finalizeAnonymousAdmissionBinding = internalMutation({
  args: { userId: v.id("users"), roomCode: v.string(), requestSecret: v.string() },
  handler: async (ctx, args) => finalizeAnonymousAdmission(ctx, args),
});

export const finalizeLegacyAnonymousInviteBinding = internalMutation({
  args: { userId: v.id("users"), roomCode: v.string(), guestInviteToken: v.string() },
  handler: async (ctx, args) => finalizeLegacyAnonymousInvite(ctx, args),
});

// Compatibility-only internal binding for callers draining legacy v1 invitations.
// New v2 callers must use finalizeAnonymousAdmissionBinding so use consumption and
// exact account/request binding occur in one transaction.
export const bindAnonymousGuestInvite = internalMutation({
  args: { userId: v.id("users"), roomCode: v.string(), tokenHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, { userId, roomCode, tokenHash, expiresAt }) => {
    const user = await ctx.db.get(userId);
    if (!user?.isAnonymous) throw new ConvexError("Invalid guest account");
    const invite = await ctx.db.query("screenshareGuestInvites")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!invite || (invite.version ?? 1) !== 1 || invite.roomCode !== roomCode || invite.expiresAt !== expiresAt) {
      throw new ConvexError("Invalid guest account");
    }
    await ctx.db.patch(userId, {
      anonymousInviteRoomCode: roomCode,
      anonymousInviteTokenHash: tokenHash,
      anonymousInviteExpiresAt: expiresAt,
      anonymousInviteId: invite._id,
      anonymousInviteVersion: 1,
    });
  },
});

export const authorizeAnonymousInvite = internalMutation({
  args: { roomCode: v.string(), guestInviteToken: v.string() },
  handler: async (ctx, { roomCode, guestInviteToken }) => {
    const validation = await validateAnonymousGuestInvite(ctx, roomCode, guestInviteToken);
    if (!validation.allowed) return validation;
    if (!await takeRateLimit(ctx, `anon-signup:${await sha256(validation.roomCode)}`, 24, 10 * 60_000)) {
      return { allowed: false as const, reason: 'Invitation could not be verified' };
    }
    if (!await takeRateLimit(ctx, `anon-signup:${validation.tokenHash}`, 8, 10 * 60_000)) {
      return { allowed: false as const, reason: 'Invitation could not be verified' };
    }
    return consumeAnonymousGuestInvite(ctx, roomCode, guestInviteToken);
  },
});

async function deleteAnonymousUser(ctx: MutationCtx, userId: Id<'users'>) {
  for (const session of await ctx.db.query('authSessions').withIndex('userId', (q) => q.eq('userId', userId)).collect()) {
    for (const token of await ctx.db.query('authRefreshTokens').withIndex('sessionId', (q) => q.eq('sessionId', session._id)).collect()) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
  }
  for (const account of await ctx.db.query('authAccounts').withIndex('userIdAndProvider', (q) => q.eq('userId', userId)).collect()) {
    for (const code of await ctx.db.query('authVerificationCodes').withIndex('accountId', (q) => q.eq('accountId', account._id)).collect()) await ctx.db.delete(code._id);
    await ctx.db.delete(account._id);
  }
  for (const row of await ctx.db.query('workspaceRevocations').withIndex('by_user', (q) => q.eq('userId', userId)).collect()) await ctx.db.delete(row._id);
  await ctx.db.delete(userId);
}

export const cleanupAnonymousIdentities = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const users = await ctx.db.query('users').filter((q) => q.eq(q.field('isAnonymous'), true)).take(50);
    let deleted = 0;
    for (const user of users) {
      if (user._creationTime >= cutoff) continue;
      const viewers = await ctx.db.query('screenshareViewers').withIndex('by_viewer', (q) => q.eq('viewerId', user._id)).collect();
      let active = false;
      for (const viewer of viewers) {
        const room = await ctx.db.query('screenshareRooms').withIndex('by_code', (q) => q.eq('code', viewer.roomCode)).unique();
        if (room?.status === 'live' && viewer.status !== 'kicked') { active = true; break; }
      }
      if (active) continue;
      const accounts = await ctx.db.query('authAccounts').withIndex('userIdAndProvider', (q) => q.eq('userId', user._id)).collect();
      if (accounts.some((account) => account.provider !== 'anonymous')) continue;
      const memberships = await ctx.db.query('members').withIndex('by_user', (q) => q.eq('userId', user._id)).collect();
      if (memberships.length > 0) continue;
      const grants = await ctx.db.query('sharedBrowserGrants').filter((q) => q.eq(q.field('userId'), user._id)).take(100);
      if (grants.some((grant) => grant.status === 'issued' && grant.expiresAt > Date.now())) continue;
      await enqueueLiveKitParticipantEvictionsForUser(ctx, {
        userId: user._id,
        reason: 'anonymous-account-removal',
      });
      for (const viewer of viewers) await ctx.db.delete(viewer._id);
      await deleteAnonymousUser(ctx, user._id);
      deleted += 1;
    }
    return { deleted };
  },
});
export async function readBoundedBody(request: Pick<Request, 'headers' | 'body'>, maxBytes: number) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error('Body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Body too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
