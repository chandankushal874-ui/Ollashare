/// <reference types="vite/client" />
import { convexTest } from '../testSessions';
import { makeFunctionReference } from 'convex/server';
import { Webhook } from 'standardwebhooks';
import { afterEach, expect, test, vi } from 'vitest';
import schema from './schema';
import { verifyBackendWebhook } from './webhookSecurity';
const modules = import.meta.glob(['./**/*.*s', '!./**/*.test.*']);
vi.mock('./subscriptions', () => ({ polar: { getCurrentSubscription: vi.fn().mockResolvedValue(null) } }));

afterEach(() => vi.unstubAllEnvs());
test('signed webhooks reject tampering/static secrets and atomically deduplicate effects', async () => {
	const secret = 'test-webhook-secret-'.repeat(3);
	vi.stubEnv('BACKEND_WEBHOOK_SECRET', secret);
	const t = convexTest(schema, modules);
	const workspaceId = await t.run(async (ctx) => {
		const ownerId = await ctx.db.insert('users', { email: 'webhook@test.invalid' });
		return ctx.db.insert('workspaces', { ownerId, name: 'Webhook', createdAt: Date.now() });
	});
	const payload = JSON.stringify({ type: 'demo.echo', workspaceId });
	const messageId = 'message_id_123456789';
	const timestamp = new Date();
	const headers = new Headers({ 'webhook-id': messageId, 'webhook-timestamp': Math.floor(timestamp.getTime() / 1000).toString(), 'webhook-signature': new Webhook(secret, { format: 'raw' }).sign(messageId, timestamp, payload) });
	expect(verifyBackendWebhook(payload, headers).messageId).toBe(messageId);
	expect(() => verifyBackendWebhook(`${payload} `, headers)).toThrow();
	expect(() => verifyBackendWebhook(payload, new Headers({ 'x-webhook-secret': secret }))).toThrow();
	const accept = makeFunctionReference<'mutation'>('webhookSecurity:accept');
	expect(await t.mutation(accept, { messageId, payload: JSON.parse(payload) })).toBe('accepted');
	expect(await t.mutation(accept, { messageId, payload: JSON.parse(payload) })).toBe('duplicate');
	expect(await t.run((ctx) => ctx.db.query('events').collect())).toHaveLength(1);
	await expect(t.mutation(accept, { messageId: 'invalid_job_1234567', payload: { type: 'job.result', jobId: 'invalid' } })).rejects.toThrow();
	expect((await t.run((ctx) => ctx.db.query('webhookReceipts').collect())).map((row) => row.messageId)).not.toContain('invalid_job_1234567');
});

test('job result webhooks bind the signed workspace, user, and kind before completion', async () => {
	const secret = 'test-webhook-secret-'.repeat(3);
	vi.stubEnv('BACKEND_WEBHOOK_SECRET', secret);
	const t = convexTest(schema, modules);
	const { jobId, workspaceId, otherWorkspaceId, userId, otherUserId } = await t.run(async (ctx) => {
		const userId = await ctx.db.insert('users', { email: 'job-owner@test.invalid' });
		const otherUserId = await ctx.db.insert('users', { email: 'other-owner@test.invalid' });
		const workspaceId = await ctx.db.insert('workspaces', { ownerId: userId, name: 'Job owner', createdAt: Date.now() });
		const otherWorkspaceId = await ctx.db.insert('workspaces', { ownerId: otherUserId, name: 'Other owner', createdAt: Date.now() });
		const jobId = await ctx.db.insert('jobs', {
			workspaceId,
			userId,
			kind: 'demo',
			status: 'running',
			input: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await ctx.db.insert('counters', { workspaceId, metric: 'openJobs', value: 1 });
		return { jobId, workspaceId, otherWorkspaceId, userId, otherUserId };
	});
	const accept = makeFunctionReference<'mutation'>('webhookSecurity:accept');
	const signed = (messageId: string, body: Record<string, unknown>) => {
		const payload = JSON.stringify(body);
		const timestamp = new Date();
		const headers = new Headers({
			'webhook-id': messageId,
			'webhook-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
			'webhook-signature': new Webhook(secret, { format: 'raw' }).sign(messageId, timestamp, payload),
		});
		return verifyBackendWebhook(payload, headers);
	};
	const mismatches = [
		['mismatch_workspace_123456', { workspaceId: otherWorkspaceId, userId, kind: 'demo' }],
		['mismatch_user_1234567890', { workspaceId, userId: otherUserId, kind: 'demo' }],
		['mismatch_kind_1234567890', { workspaceId, userId, kind: 'other' }],
	] as const;
	for (const [messageId, ownership] of mismatches) {
		await expect(t.mutation(accept, signed(messageId, {
			type: 'job.result',
			jobId,
			...ownership,
			result: { accepted: false },
		}))).rejects.toThrow(/Invalid job/);
		const state = await t.run(async (ctx) => ({
			job: await ctx.db.get(jobId),
			receipt: await ctx.db.query('webhookReceipts').withIndex('by_message', (q) => q.eq('messageId', messageId)).unique(),
			notifications: await ctx.db.query('notifications').collect(),
		}));
		expect(state.job?.status).toBe('running');
		expect(state.job?.result).toBeUndefined();
		expect(state.receipt).toBeNull();
		expect(state.notifications).toHaveLength(0);
	}
	const validMessageId = 'matching_job_result_123456';
	const validPayload = signed(validMessageId, {
		type: 'job.result',
		jobId,
		workspaceId,
		userId,
		kind: 'demo',
		result: { accepted: true },
	});
	expect(await t.mutation(accept, validPayload)).toBe('accepted');
	expect(await t.mutation(accept, validPayload)).toBe('duplicate');
	const completed = await t.run(async (ctx) => ({
		job: await ctx.db.get(jobId),
		receipt: await ctx.db.query('webhookReceipts').withIndex('by_message', (q) => q.eq('messageId', validMessageId)).unique(),
		notifications: await ctx.db.query('notifications').collect(),
		counter: await ctx.db.query('counters').withIndex('by_workspace_metric', (q) => q.eq('workspaceId', workspaceId).eq('metric', 'openJobs')).unique(),
	}));
	expect(completed.job?.status).toBe('done');
	expect(completed.job?.result).toEqual({ accepted: true });
	expect(completed.receipt).not.toBeNull();
	expect(completed.notifications).toHaveLength(1);
	expect(completed.counter?.value).toBe(0);
});
