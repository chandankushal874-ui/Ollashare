/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { expect, test, vi, afterEach } from 'vitest';
import schema from './schema';
import { disableScreenshareSchedulingForTests } from './screenshare/lib';
const modules = import.meta.glob(['./**/*.*s', '!./**/*.test.*']);
const current = makeFunctionReference<'query'>('activeSession:current');
disableScreenshareSchedulingForTests();
afterEach(() => vi.unstubAllGlobals());
test('valid, expired, revoked and mismatched sessions fail or succeed against real rows', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network disabled')));
  const t = convexTest(schema, modules);
  const { userId, other, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'session@test.invalid' });
    const other = await ctx.db.insert('users', { email: 'other@test.invalid' });
    const sessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 });
    return { userId, other, sessionId };
  });
  expect(await t.query(current, {})).toBeNull();
  const caller = t.withIdentity({ subject: `${userId}|${sessionId}` });
  expect(await caller.query(current, {})).toBe(userId);
  expect(await t.withIdentity({ subject: `${other}|${sessionId}` }).query(current, {})).toBeNull();
  await t.run((ctx) => ctx.db.patch(sessionId, { expirationTime: 0 }));
  expect(await caller.query(current, {})).toBeNull();
  await t.run((ctx) => ctx.db.delete(sessionId));
  expect(await caller.query(current, {})).toBeNull();
  await expect(caller.mutation(makeFunctionReference<'mutation'>('screenshare:issueLiveKitToken'), { roomCode: 'test' })).rejects.toThrow(/authenticated/);
});

test('session revocation enqueues LiveKit eviction for active room identities', async () => {
  const t = convexTest(schema, modules);
  const { userId, sessionId, roomCode } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'revoke@test.invalid' });
    const sessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 });
    const workspaceId = await ctx.db.insert('workspaces', { ownerId: userId, name: 'Sessions', createdAt: Date.now() });
    await ctx.db.insert('members', { workspaceId, userId, role: 'owner', createdAt: Date.now() });
    const roomCode = 'MIRA-REV-OKE-001';
    await ctx.db.insert('screenshareRooms', {
      code: roomCode,
      workspaceId,
      title: 'Session revocation',
      hostId: userId,
      hostName: 'Owner',
      status: 'live',
      resolution: '1080p',
      fps: 60,
      bitrateKbps: 8000,
      codec: 'H.264',
      audioEnabled: true,
      startedAt: Date.now(),
    });
    await ctx.db.insert('screenshareViewers', { roomCode, viewerId: userId, name: 'Owner', role: 'host', lastPingAt: Date.now() });
    return { userId, sessionId, roomCode };
  });
  await t.withIdentity({ subject: `${userId}|${sessionId}` }).mutation(makeFunctionReference<'mutation'>('sessions:revokeSession'), { sessionId });
  expect(await t.run((ctx) => ctx.db.query('screenshareLiveKitParticipantOperations').withIndex('by_key', (q) => q.eq('operationKey', `evict:${roomCode}:${userId}`)).unique())).toMatchObject({
    status: 'pending',
    reason: 'auth-session-revoked',
  });
});

test('revoking other sessions enqueues one durable LiveKit eviction per active room', async () => {
  const t = convexTest(schema, modules);
  const { userId, currentSessionId, otherSessionId, roomCodes } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'revoke-others@test.invalid' });
    const currentSessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 });
    const otherSessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 });
    const workspaceId = await ctx.db.insert('workspaces', { ownerId: userId, name: 'Other sessions', createdAt: Date.now() });
    await ctx.db.insert('members', { workspaceId, userId, role: 'owner', createdAt: Date.now() });
    const roomCodes = ['MIRA-REV-OTH-001', 'MIRA-REV-OTH-002'];
    for (const roomCode of roomCodes) {
      await ctx.db.insert('screenshareRooms', {
        code: roomCode,
        workspaceId,
        title: roomCode,
        hostId: userId,
        hostName: 'Owner',
        status: 'live',
        resolution: '1080p',
        fps: 60,
        bitrateKbps: 8000,
        codec: 'H.264',
        audioEnabled: true,
        startedAt: Date.now(),
      });
      await ctx.db.insert('screenshareViewers', { roomCode, viewerId: userId, name: 'Owner', role: 'host', lastPingAt: Date.now() });
    }
    return { userId, currentSessionId, otherSessionId, roomCodes };
  });

  expect(await t.withIdentity({ subject: `${userId}|${currentSessionId}` }).mutation(makeFunctionReference<'mutation'>('sessions:revokeOtherSessions'), {})).toBe(1);
  expect(await t.run((ctx) => ctx.db.get(currentSessionId))).toBeTruthy();
  expect(await t.run((ctx) => ctx.db.get(otherSessionId))).toBeNull();
  for (const roomCode of roomCodes) {
    expect(await t.run((ctx) => ctx.db.query('screenshareLiveKitParticipantOperations').withIndex('by_key', (q) => q.eq('operationKey', `evict:${roomCode}:${userId}`)).unique())).toMatchObject({
      status: 'pending',
      reason: 'auth-session-revoked',
    });
  }
});
