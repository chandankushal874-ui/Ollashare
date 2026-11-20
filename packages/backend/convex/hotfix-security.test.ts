/// <reference types="vite/client" />
import { convexTest } from '../testSessions';
import { makeFunctionReference } from 'convex/server';
import { expect, test, vi, afterEach } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
import { disableScreenshareSchedulingForTests } from './screenshare/lib';
const modules = import.meta.glob(['./**/*.*s', '!./**/*.test.*']);
vi.mock('./subscriptions', () => ({ polar: { getCurrentSubscription: vi.fn().mockResolvedValue(null) } }));
disableScreenshareSchedulingForTests();
afterEach(() => vi.unstubAllGlobals());
test('server chat rejects impersonation input, bounds content, and denies ended-room writes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network disabled')));
  const t = convexTest(schema, modules);
  const { owner, guest, ws } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert('users', { email: 'owner@hotfix.invalid' });
    const guest = await ctx.db.insert('users', { isAnonymous: true });
    const ws = await ctx.db.insert('workspaces', { ownerId: owner, name: 'Test', createdAt: Date.now() });
    await ctx.db.insert('members', { workspaceId: ws, userId: owner, role: 'owner', createdAt: Date.now() });
    return { owner, guest, ws };
  });
  const host = t.withIdentity({ subject: `${owner}|fixture` });
  const visitor = t.withIdentity({ subject: `${guest}|fixture` });
  const room = await host.mutation(api.screenshare.createRoom, { workspaceId: ws });
  await visitor.mutation(api.screenshare.joinRoom, { roomCode: room.code, name: 'Guest' });
  const send = makeFunctionReference<'mutation'>('screenshare:sendChatMessage');
  const list = makeFunctionReference<'query'>('screenshare:listChatMessages');
  await visitor.mutation(send, { roomCode: room.code, text: 'hello' });
  expect((await host.query(list, { roomCode: room.code }))[0]).toMatchObject({ senderId: guest, senderRole: 'guest', text: 'hello' });
  await expect(visitor.mutation(send, { roomCode: room.code, text: 'x'.repeat(2001) })).rejects.toThrow();
  await host.mutation(api.screenshare.endRoom, { code: room.code });
  await expect(visitor.mutation(send, { roomCode: room.code, text: 'late' })).rejects.toThrow(/not live/);
  await expect(visitor.mutation(api.screenshare.sendSignal, { roomCode: room.code, type: 'offer', payload: '{}' })).rejects.toThrow(/not live/);
});
test('uploads cannot attach another user storage ID or lie about authoritative metadata', async () => {
  const t = convexTest(schema, modules);
  const { userId, workspaceId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'upload@hotfix.invalid', isAnonymous: false });
    await ctx.db.insert('authAccounts', { userId, provider: 'password', providerAccountId: 'upload@hotfix.invalid', secret: 'fabricated-hash' });
    const workspaceId = await ctx.db.insert('workspaces', { ownerId: userId, name: 'Uploads', createdAt: Date.now() });
    await ctx.db.insert('members', { workspaceId, userId, role: 'owner', createdAt: Date.now() });
    return { userId, workspaceId };
  });
  const caller = t.withIdentity({ subject: `${userId}|fixture` });
  const ticket = await caller.mutation(api.files.generateUploadUrl, { workspaceId });
  expect(ticket.url).toBe('/api/uploads');
  const raw = await t.run((ctx) => ctx.storage.store(new Blob(['private'], { type: 'text/plain' })));
  await expect(caller.mutation(api.files.saveFile, { workspaceId, storageId: raw, name: 'file.txt', size: 7, contentType: 'text/plain' })).rejects.toThrow(/Upload/);
  await expect(caller.mutation(api.users.updateUserImage, { imageId: raw })).rejects.toThrow(/Upload/);
});
