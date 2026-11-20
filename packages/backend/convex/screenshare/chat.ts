import { ConvexError, v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { displayName, getRoomByCode, requireRoomParticipant, sanitizeDisplayText, sanitizeName } from './lib';
import { rateLimit as enforceRateLimit } from './lib';
export const sendArgs = { roomCode: v.string(), text: v.string() };
export async function send(ctx: MutationCtx, { roomCode, text }: { roomCode: string; text: string }) {
  const room = await getRoomByCode(ctx, roomCode);
  if (!room || room.status !== 'live') throw new ConvexError('Room is not live');
  const senderId = await requireRoomParticipant(ctx, roomCode, room.workspaceId);
  const cleanText = sanitizeDisplayText(text, 2000);
  if (!cleanText) throw new ConvexError('Invalid message');
  await enforceRateLimit(ctx, `chat:${senderId}`, 20, 60_000);
  await enforceRateLimit(ctx, `chat-room:${roomCode}`, 120, 60_000);
  const user = await ctx.db.get(senderId);
  return ctx.db.insert('screenshareMessages', { roomCode, senderId, senderName: sanitizeName(displayName(user)), senderRole: senderId === room.hostId ? 'host' : 'guest', text: cleanText, timestamp: Date.now() });
}
export const listArgs = { roomCode: v.string() };
export async function list(ctx: QueryCtx, { roomCode }: { roomCode: string }) {
  const room = await getRoomByCode(ctx, roomCode);
  if (!room) throw new ConvexError('Room not found');
  await requireRoomParticipant(ctx, roomCode, room.workspaceId);
  return (await ctx.db.query('screenshareMessages').withIndex('by_room_time', (q) => q.eq('roomCode', roomCode).gte('timestamp', Date.now() - 7 * 24 * 60 * 60_000)).order('desc').take(100)).reverse();
}
