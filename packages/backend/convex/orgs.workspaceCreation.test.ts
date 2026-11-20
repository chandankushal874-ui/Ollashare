import { afterEach, describe, expect, test, vi } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { api, internal } from "./_generated/api";
import {
	MAX_OWNED_WORKSPACES,
	WORKSPACE_CREATE_BURST_LIMIT,
	WORKSPACE_CREATE_DAILY_LIMIT,
	WORKSPACE_CREATE_HOURLY_LIMIT,
} from "./orgs";
import schema from "./schema";
import { WORKSPACE_NAME_MAX_LENGTH } from "./workspaceNames";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function registeredUser(
	t: ReturnType<typeof convexTest>,
	email = "owner@test.invalid",
) {
	return t.run((ctx) => ctx.db.insert("users", { email }));
}

async function creationRows(t: ReturnType<typeof convexTest>, userId: string) {
	return t.run(async (ctx) => ({
		workspaces: await ctx.db.query("workspaces").collect(),
		members: await ctx.db.query("members").collect(),
		counters: await ctx.db.query("counters").collect(),
		audits: await ctx.db.query("auditLogs").collect(),
		rateLimits: (await ctx.db.query("rateLimits").collect()).filter((row) =>
			row.key.includes(userId),
		),
	}));
}

async function expectRejectedWithoutCreationSideEffects(
	t: ReturnType<typeof convexTest>,
	userId: string,
	name: string,
	error: RegExp,
) {
	const before = await creationRows(t, userId);
	await expect(
		t.withIdentity(as(userId)).mutation(api.orgs.createWorkspace, { name }),
	).rejects.toThrow(error);
	expect(await creationRows(t, userId)).toEqual(before);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("bounded workspace creation", () => {
	test("registered users create normalized international workspace names", async () => {
		const t = convexTest(schema, modules);
		const userId = await registeredUser(t);

		const workspaceId = await t
			.withIdentity(as(userId))
			.mutation(api.orgs.createWorkspace, { name: "  東京　 Ｒ＆Ｄ   فريق  " });

		const workspace = await t.run((ctx) => ctx.db.get(workspaceId));
		expect(workspace?.name).toBe("東京 R&D فريق");
		expect(workspace?.ownerId).toBe(userId);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("members")
					.withIndex("by_user_workspace", (q) =>
						q.eq("userId", userId).eq("workspaceId", workspaceId),
					)
					.unique(),
			),
		).toMatchObject({ role: "owner" });
	});

	test("anonymous room guests cannot create or automatically ensure workspaces", async () => {
		const t = convexTest(schema, modules);
		const guestId = await t.run((ctx) =>
			ctx.db.insert("users", { isAnonymous: true }),
		);

		await expectRejectedWithoutCreationSideEffects(
			t,
			guestId,
			"Guest workspace",
			/registered account/i,
		);
		await expect(
			t.withIdentity(as(guestId)).mutation(api.orgs.ensureWorkspace, {}),
		).rejects.toThrow(/registered account/i);
		expect(await creationRows(t, guestId)).toEqual({
			workspaces: [],
			members: [],
			counters: [],
			audits: [],
			rateLimits: [],
		});
	});

	test.each([
		["blank", " 　  ", /2 to 80 characters/i],
		[
			"oversized",
			"界".repeat(WORKSPACE_NAME_MAX_LENGTH + 1),
			/2 to 80 characters/i,
		],
		["control", "Safe\nName", /unsafe characters/i],
		["bidi", "Safe\u202EName", /unsafe characters/i],
		["invisible", "Safe\u200BName", /unsafe characters/i],
		["html-like", "<b>Workspace</b>", /HTML-like text/i],
	])(
		"rejects %s names without creation side effects",
		async (_kind, name, error) => {
			const t = convexTest(schema, modules);
			const userId = await registeredUser(t);
			await expectRejectedWithoutCreationSideEffects(t, userId, name, error);
		},
	);

	test("enforces the persistent burst limit and rolls back the rejected attempt", async () => {
		const t = convexTest(schema, modules);
		const userId = await registeredUser(t);
		const caller = t.withIdentity(as(userId));

		for (let index = 0; index < WORKSPACE_CREATE_BURST_LIMIT; index += 1) {
			await caller.mutation(api.orgs.createWorkspace, {
				name: `Burst ${index + 1}`,
			});
		}
		const before = await creationRows(t, userId);
		await expect(
			caller.mutation(api.orgs.createWorkspace, { name: "Burst rejected" }),
		).rejects.toThrow(/Too many requests/);
		expect(await creationRows(t, userId)).toEqual(before);
	});

	test.each([
		["hourly", "workspace_create_hour", WORKSPACE_CREATE_HOURLY_LIMIT],
		["daily", "workspace_create_day", WORKSPACE_CREATE_DAILY_LIMIT],
	])("enforces the persistent %s limit", async (_kind, keyPrefix, limit) => {
		const t = convexTest(schema, modules);
		const userId = await registeredUser(t);
		await t.run((ctx) =>
			ctx.db.insert("rateLimits", {
				key: `${keyPrefix}:${userId}`,
				kind: keyPrefix,
				count: limit,
				resetAt: Date.now() + 60_000,
			}),
		);

		await expectRejectedWithoutCreationSideEffects(
			t,
			userId,
			`${_kind} rejected`,
			/Too many requests/,
		);
	});

	test("enforces the owned-workspace cap before any insert or rate-limit write", async () => {
		const t = convexTest(schema, modules);
		const userId = await registeredUser(t);
		await t.run(async (ctx) => {
			for (let index = 0; index < MAX_OWNED_WORKSPACES; index += 1) {
				await ctx.db.insert("workspaces", {
					ownerId: userId,
					name: `Existing ${index + 1}`,
					createdAt: Date.now() + index,
				});
			}
		});

		await expectRejectedWithoutCreationSideEffects(
			t,
			userId,
			"One too many",
			new RegExp(`Workspace limit reached \\(${MAX_OWNED_WORKSPACES}\\)`),
		);
	});

	test("ensureWorkspace is one-time and idempotent", async () => {
		const t = convexTest(schema, modules);
		const userId = await registeredUser(t);
		const caller = t.withIdentity(as(userId));

		const first = await caller.mutation(api.orgs.ensureWorkspace, {});
		const second = await caller.mutation(api.orgs.ensureWorkspace, {});
		expect(second).toBe(first);

		const rows = await creationRows(t, userId);
		expect(rows.workspaces).toHaveLength(1);
		expect(rows.workspaces[0]?.name).toBe("Personal");
		expect(rows.members).toHaveLength(1);
		expect(rows.audits).toHaveLength(1);
		expect(rows.rateLimits).toHaveLength(3);
		expect(rows.rateLimits.every((row) => row.count === 1)).toBe(true);
	});

	test("one user's limits and owned count do not affect another user", async () => {
		const t = convexTest(schema, modules);
		const limitedUser = await registeredUser(t, "limited@test.invalid");
		const otherUser = await registeredUser(t, "other@test.invalid");
		await t.run(async (ctx) => {
			for (let index = 0; index < MAX_OWNED_WORKSPACES; index += 1) {
				await ctx.db.insert("workspaces", {
					ownerId: limitedUser,
					name: `Limited ${index + 1}`,
					createdAt: Date.now() + index,
				});
			}
			await ctx.db.insert("rateLimits", {
				key: `workspace_create_day:${limitedUser}`,
				kind: "workspace_create_day",
				count: WORKSPACE_CREATE_DAILY_LIMIT,
				resetAt: Date.now() + 60_000,
			});
		});

		const workspaceId = await t
			.withIdentity(as(otherUser))
			.mutation(api.orgs.createWorkspace, { name: "Other tenant" });
		expect((await t.run((ctx) => ctx.db.get(workspaceId)))?.ownerId).toBe(
			otherUser,
		);
	});

	test("the internal seed path remains fail-closed outside explicitly enabled development", async () => {
		const t = convexTest(schema, modules);
		const userId = await registeredUser(t);
		vi.stubEnv("DEV_SEED", "1");
		vi.stubEnv("NODE_ENV", "production");

		await expect(
			t.mutation(internal.orgs.createWorkspaceForUser, {
				userId,
				name: "Internal seed",
			}),
		).rejects.toThrow(/Dev\/seed functions are disabled/);
		expect(await creationRows(t, userId)).toEqual({
			workspaces: [],
			members: [],
			counters: [],
			audits: [],
			rateLimits: [],
		});
	});
});
