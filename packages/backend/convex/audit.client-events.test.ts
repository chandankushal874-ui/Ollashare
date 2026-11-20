import { describe, expect, test } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	CLIENT_AUDIT_RATE_LIMITS,
	clientAuditRateLimitKey,
	sanitizeClientEventMetadata,
} from "./audit";
import { audit } from "./auditLog";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => {
		const owner = await ctx.db.insert("users", {
			email: "owner@audit.test",
			emailVerificationTime: Date.now(),
		});
		const member = await ctx.db.insert("users", {
			email: "member@audit.test",
			emailVerificationTime: Date.now(),
		});
		const secondMember = await ctx.db.insert("users", {
			email: "second@audit.test",
			emailVerificationTime: Date.now(),
		});
		const outsider = await ctx.db.insert("users", {
			email: "outsider@audit.test",
			emailVerificationTime: Date.now(),
		});
		const workspaceId = await ctx.db.insert("workspaces", {
			name: "Audit boundary",
			ownerId: owner,
			createdAt: Date.now(),
		});
		for (const [userId, role] of [
			[owner, "owner"],
			[member, "member"],
			[secondMember, "member"],
		] as const) {
			await ctx.db.insert("members", {
				workspaceId,
				userId,
				role,
				createdAt: Date.now(),
			});
		}
		return { member, secondMember, outsider, workspaceId };
	});
}

async function sideEffectCounts(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => ({
		audit: (await ctx.db.query("auditLogs").collect()).length,
		daily: (await ctx.db.query("workspaceAnalyticsDaily").collect()).length,
		actors: (await ctx.db.query("workspaceAnalyticsActors").collect()).length,
		security: (await ctx.db.query("workspaceAnalyticsSecurityEvents").collect())
			.length,
		rates: (await ctx.db.query("rateLimits").collect()).length,
	}));
}

function validEvent(workspaceId: Id<"workspaces">) {
	return {
		workspaceId,
		action: "client.auth.failure",
		meta: {
			reason: "credentials_rejected",
			retryable: false,
			attempt: 2,
			elapsedMs: 1250,
		},
	};
}

describe("public client audit event contract", () => {
	test("rejects server-reserved and unknown actions generically without side effects", async () => {
		const t = convexTest(schema, modules);
		const { member, workspaceId } = await seedWorkspace(t);
		const caller = t.withIdentity(as(member));
		const before = await sideEffectCounts(t);

		for (const action of [
			"member.remove",
			"security.admin.override",
			"client.arbitrary.event",
		]) {
			await expect(
				caller.mutation(api.audit.logEvent, {
					workspaceId,
					action,
					meta: {},
				}),
			).rejects.toThrow(/^.*Invalid client audit event.*$/);
		}

		expect(await sideEffectCounts(t)).toEqual(before);
	});

	test("accepts an allowed event and persists only fixed sanitized fields", async () => {
		const t = convexTest(schema, modules);
		const { member, workspaceId } = await seedWorkspace(t);

		await expect(
			t
				.withIdentity(as(member))
				.mutation(api.audit.logEvent, validEvent(workspaceId)),
		).resolves.toBe(true);

		const result = await t.run(async (ctx) => ({
			logs: await ctx.db.query("auditLogs").collect(),
			daily: await ctx.db.query("workspaceAnalyticsDaily").collect(),
			security: await ctx.db
				.query("workspaceAnalyticsSecurityEvents")
				.collect(),
		}));
		expect(result.logs).toHaveLength(1);
		expect(result.logs[0]).toMatchObject({
			workspaceId,
			userId: member,
			action: "client.auth.failure",
			meta: {
				reason: "credentials_rejected",
				retryable: false,
				attempt: 2,
				elapsedMs: 1250,
			},
		});
		expect(result.logs[0]?.actorEmail).toBeUndefined();
		expect(result.logs[0]?.actorName).toBeUndefined();
		expect(result.daily).toHaveLength(1);
		expect(result.daily[0]).toMatchObject({
			workspaceId,
			clientFailures: 1,
			roomFailures: 0,
			securityEvents: 1,
		});
		expect(result.security).toEqual([
			expect.objectContaining({
				workspaceId,
				event: "client_failure",
				reason: "authentication_failed",
				outcome: "failed",
				actorKind: "member",
			}),
		]);
	});

	test("rejects oversized, deep, cyclic, accessor, sensitive, extra, and non-JSON metadata", () => {
		expect(() =>
			sanitizeClientEventMetadata("client.auth.failure", {
				reason: "x".repeat(1000),
			}),
		).toThrow(/Invalid client audit event/);

		expect(() =>
			sanitizeClientEventMetadata("client.auth.failure", {
				reason: "unknown",
				extra: { one: { two: { three: { four: true } } } },
			}),
		).toThrow(/Invalid client audit event/);

		const cyclic: Record<string, unknown> = { reason: "unknown" };
		cyclic.self = cyclic;
		expect(() =>
			sanitizeClientEventMetadata("client.auth.failure", cyclic),
		).toThrow(/Invalid client audit event/);

		let accessorRead = false;
		const accessor = { reason: "unknown" };
		Object.defineProperty(accessor, "attempt", {
			enumerable: true,
			get() {
				accessorRead = true;
				return 1;
			},
		});
		expect(() =>
			sanitizeClientEventMetadata("client.auth.failure", accessor),
		).toThrow(/Invalid client audit event/);
		expect(accessorRead).toBe(false);

		for (const meta of [
			{ reason: "unknown", token: "secret" },
			{ reason: "unknown", url: "https://example.test/?token=secret" },
			{ reason: "unknown", detail: "arbitrary" },
			{ reason: "unknown", attempt: Number.NaN },
			{ reason: "unknown", retryable: () => true },
			Object.assign(Object.create({ inherited: true }), { reason: "unknown" }),
		]) {
			expect(() =>
				sanitizeClientEventMetadata("client.auth.failure", meta),
			).toThrow(/Invalid client audit event/);
		}
	});

	test("enforces member authentication before accepting workspace events", async () => {
		const t = convexTest(schema, modules);
		const { member, outsider, workspaceId } = await seedWorkspace(t);

		await expect(
			t
				.withIdentity(as(member))
				.mutation(api.audit.logEvent, validEvent(workspaceId)),
		).resolves.toBe(true);
		const afterMember = await sideEffectCounts(t);

		await expect(
			t
				.withIdentity(as(outsider))
				.mutation(api.audit.logEvent, validEvent(workspaceId)),
		).rejects.toThrow(/Forbidden/);
		await expect(
			t.mutation(api.audit.logEvent, validEvent(workspaceId)),
		).resolves.toBe(false);
		expect(await sideEffectCounts(t)).toEqual(afterMember);
	});

	test.each([
		["user burst", "user", "burst", "userBurst"],
		["user hourly", "user", "hourly", "userHourly"],
		["workspace burst", "workspace", "burst", "workspaceBurst"],
		["workspace hourly", "workspace", "hourly", "workspaceHourly"],
	] as const)(
		"enforces the persistent %s limit without consuming other counters",
		async (_label, scope, window, configName) => {
			const t = convexTest(schema, modules);
			const { member, workspaceId } = await seedWorkspace(t);
			const ids = {
				user: member as string,
				workspace: workspaceId as string,
			};
			const configs = CLIENT_AUDIT_RATE_LIMITS;
			const targetKey = clientAuditRateLimitKey(scope, ids[scope], window);
			const now = Date.now();
			const allKeys = [
				clientAuditRateLimitKey("user", member, "burst"),
				clientAuditRateLimitKey("user", member, "hourly"),
				clientAuditRateLimitKey("workspace", workspaceId, "burst"),
				clientAuditRateLimitKey("workspace", workspaceId, "hourly"),
			];

			await t.run(async (ctx) => {
				for (const key of allKeys) {
					await ctx.db.insert("rateLimits", {
						key,
						kind: "client_audit",
						count: key === targetKey ? configs[configName].limit : 1,
						resetAt: now + 60 * 60_000,
					});
				}
				await ctx.db.insert("rateLimits", {
					key: `files:${member}`,
					kind: "files",
					count: 7,
					resetAt: now + 60_000,
				});
			});
			const before = await t.run((ctx) => ctx.db.query("rateLimits").collect());

			await expect(
				t
					.withIdentity(as(member))
					.mutation(api.audit.logEvent, validEvent(workspaceId)),
			).rejects.toThrow(/Too many requests/);

			const after = await t.run(async (ctx) => ({
				rates: await ctx.db.query("rateLimits").collect(),
				audit: await ctx.db.query("auditLogs").collect(),
				daily: await ctx.db.query("workspaceAnalyticsDaily").collect(),
				security: await ctx.db
					.query("workspaceAnalyticsSecurityEvents")
					.collect(),
			}));
			expect(after.rates).toEqual(before);
			expect(after.audit).toHaveLength(0);
			expect(after.daily).toHaveLength(0);
			expect(after.security).toHaveLength(0);
		},
	);

	test("workspace limit is shared across members", async () => {
		const t = convexTest(schema, modules);
		const { member, secondMember, workspaceId } = await seedWorkspace(t);
		const key = clientAuditRateLimitKey("workspace", workspaceId, "burst");
		await t.run((ctx) =>
			ctx.db.insert("rateLimits", {
				key,
				kind: "client_audit",
				count: CLIENT_AUDIT_RATE_LIMITS.workspaceBurst.limit,
				resetAt: Date.now() + 60_000,
			}),
		);

		for (const userId of [member, secondMember]) {
			await expect(
				t
					.withIdentity(as(userId))
					.mutation(api.audit.logEvent, validEvent(workspaceId)),
			).rejects.toThrow(/Too many requests/);
		}
		expect((await sideEffectCounts(t)).audit).toBe(0);
	});

	test("trusted server audit helper remains able to write server-owned actions", async () => {
		const t = convexTest(schema, modules);
		const { member, workspaceId } = await seedWorkspace(t);

		await t.run((ctx) =>
			audit(ctx, workspaceId, member, "member.remove", {
				memberId: "trusted-server-value",
			}),
		);

		const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			workspaceId,
			userId: member,
			action: "member.remove",
			actorEmail: "member@audit.test",
			meta: { memberId: "trusted-server-value" },
		});
	});
});
