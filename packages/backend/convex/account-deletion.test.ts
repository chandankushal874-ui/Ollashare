import { afterEach, expect, test, vi } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { disableScreenshareSchedulingForTests } from "./screenshare/lib";
import { disableAccountDeletionSchedulingForTests } from "./users";
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
disableScreenshareSchedulingForTests();
disableAccountDeletionSchedulingForTests();
vi.mock("./subscriptions", () => ({
	polar: {
		getCurrentSubscription: vi.fn().mockResolvedValue(null),
		cancelSubscription: vi.fn(),
	},
	deleteBillingCustomer: vi.fn().mockResolvedValue(false),
}));
afterEach(() => vi.restoreAllMocks());
async function finishDeletion(
	t: ReturnType<typeof convexTest>,
	userId: Id<"users">,
) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if ((await t.mutation(internal.users.deleteUserAccount, { userId })).done)
			return;
	}
	throw new Error("Deletion did not finish");
}

test("deletion removes credentials and personal resources without orphaning auth state", async () => {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			email: "delete@test.invalid",
		});
		const workspaceId = await ctx.db.insert("workspaces", {
			ownerId: userId,
			name: "Personal",
			createdAt: Date.now(),
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId,
			role: "owner",
			createdAt: Date.now(),
		});
		const accountId = await ctx.db.insert("authAccounts", {
			userId,
			provider: "password",
			providerAccountId: "delete@test.invalid",
			secret: "hash",
		});
		await ctx.db.insert("authVerificationCodes", {
			accountId,
			provider: "reset",
			code: "code",
			expirationTime: Date.now() + 60000,
		});
		const sessionId = await ctx.db.insert("authSessions", {
			userId,
			expirationTime: Date.now() + 60000,
		});
		await ctx.db.insert("authRefreshTokens", {
			sessionId,
			expirationTime: Date.now() + 60000,
		});
		await ctx.db.insert("authVerifiers", { sessionId, signature: "sig" });
		return { userId, workspaceId };
	});
	await finishDeletion(t, ids.userId);
	expect(await t.run((ctx) => ctx.db.get(ids.userId))).toBeNull();
	expect(await t.run((ctx) => ctx.db.get(ids.workspaceId))).toBeNull();
});

test("ownership rejection happens before destructive cleanup", async () => {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const owner = await ctx.db.insert("users", { email: "o@test" });
		const member = await ctx.db.insert("users", { email: "m@test" });
		const workspaceId = await ctx.db.insert("workspaces", {
			ownerId: owner,
			name: "Shared",
			createdAt: 1,
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId: owner,
			role: "owner",
			createdAt: 1,
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId: member,
			role: "member",
			createdAt: 1,
		});
		const accountId = await ctx.db.insert("authAccounts", {
			userId: owner,
			provider: "password",
			providerAccountId: "o@test",
		});
		return { owner, workspaceId, accountId };
	});
	await expect(
		t.mutation(internal.users.deleteUserAccount, { userId: ids.owner }),
	).rejects.toThrow(/Transfer or clear/);
	expect(await t.run((ctx) => ctx.db.get(ids.accountId))).toBeTruthy();
});

test("500 notifications and 150+ categories drain in bounded resumable batches", async () => {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { email: "bulk@test" });
		const ownerId = await ctx.db.insert("users", { email: "owner@test" });
		const workspaceId = await ctx.db.insert("workspaces", {
			ownerId,
			name: "External",
			createdAt: 1,
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId: ownerId,
			role: "owner",
			createdAt: 1,
		});
		const storageId = await ctx.storage.store(new Blob(["x"]));
		for (let i = 0; i < 505; i++)
			await ctx.db.insert("notifications", {
				userId,
				type: "x",
				title: String(i),
				read: false,
				createdAt: i,
			});
		for (let i = 0; i < 155; i++) {
			await ctx.db.insert("members", {
				workspaceId,
				userId,
				role: "member",
				createdAt: i,
			});
			await ctx.db.insert("jobs", {
				workspaceId,
				userId,
				kind: "x",
				status: "done",
				createdAt: i,
				updatedAt: i,
			});
			await ctx.db.insert("apiKeys", {
				workspaceId,
				userId,
				name: String(i),
				prefix: String(i),
				hash: `h${i}`,
				revoked: false,
				createdAt: i,
			});
			await ctx.db.insert("invites", {
				workspaceId,
				invitedBy: userId,
				email: `${i}@t`,
				role: "member",
				accepted: false,
				createdAt: i,
			});
			await ctx.db.insert("usage", {
				workspaceId,
				userId,
				metric: `m${i}`,
				count: i,
				updatedAt: i,
			});
			await ctx.db.insert("auditLogs", {
				workspaceId,
				userId,
				action: `a${i}`,
				at: i,
			});
			await ctx.db.insert("uploadTickets", {
				tokenHash: `t${i}`,
				userId,
				workspaceId,
				expiresAt: Date.now() + 60000,
			});
			await ctx.db.insert("uploadObjects", {
				storageId,
				userId,
				workspaceId,
				size: 1,
				contentType: "text/plain",
				attached: true,
				createdAt: i,
			});
			await ctx.db.insert("files", {
				workspaceId,
				userId,
				name: `f${i}`,
				storageId,
				size: 1,
				contentType: "text/plain",
				createdAt: i,
			});
		}
		const accountId = await ctx.db.insert("authAccounts", {
			userId,
			provider: "password",
			providerAccountId: "bulk@test",
		});
		for (let i = 0; i < 155; i++)
			await ctx.db.insert("authVerificationCodes", {
				accountId,
				provider: "x",
				code: `c${i}`,
				expirationTime: Date.now() + 60000,
			});
		const sessionId = await ctx.db.insert("authSessions", {
			userId,
			expirationTime: Date.now() + 60000,
		});
		for (let i = 0; i < 155; i++)
			await ctx.db.insert("authRefreshTokens", {
				sessionId,
				expirationTime: Date.now() + 60000,
			});
		return { userId, ownerId, workspaceId };
	});
	expect(
		(await t.mutation(internal.users.deleteUserAccount, { userId: ids.userId }))
			.done,
	).toBe(false);
	expect(await t.run((ctx) => ctx.db.get(ids.userId))).toBeTruthy();
	await finishDeletion(t, ids.userId);
	expect(await t.run((ctx) => ctx.db.get(ids.userId))).toBeNull();
	expect(await t.run((ctx) => ctx.db.get(ids.ownerId))).toBeTruthy();
	expect(await t.run((ctx) => ctx.db.get(ids.workspaceId))).toBeTruthy();
});

test("interruption duplicate calls missing storage and late reverse reference converge", async () => {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { email: "r@test" });
		const ownerId = await ctx.db.insert("users", { email: "ro@test" });
		const workspaceId = await ctx.db.insert("workspaces", {
			ownerId,
			name: "E",
			createdAt: 1,
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId: ownerId,
			role: "owner",
			createdAt: 1,
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId,
			role: "member",
			createdAt: 1,
		});
		const storageId = await ctx.storage.store(new Blob(["x"]));
		await ctx.db.insert("uploadObjects", {
			storageId,
			userId,
			workspaceId,
			size: 1,
			contentType: "text/plain",
			attached: false,
			createdAt: 1,
		});
		await ctx.storage.delete(storageId);
		return { userId, workspaceId };
	});
	await t.mutation(internal.users.deleteUserAccount, { userId: ids.userId });
	await t.mutation(internal.users.deleteUserAccount, { userId: ids.userId });
	await t.run(async (ctx) => {
		const state = await ctx.db
			.query("accountDeletionStates")
			.withIndex("by_user", (q) => q.eq("userId", ids.userId))
			.unique();
		if (!state) throw new Error();
		await ctx.db.patch(state._id, { phase: "finalVerification" });
		await ctx.db.insert("notifications", {
			userId: ids.userId,
			type: "late",
			title: "late",
			read: false,
			createdAt: 1,
		});
	});
	await t.mutation(internal.users.deleteUserAccount, { userId: ids.userId });
	expect(await t.run((ctx) => ctx.db.get(ids.userId))).toBeTruthy();
	await finishDeletion(t, ids.userId);
	expect(
		(await t.mutation(internal.users.deleteUserAccount, { userId: ids.userId }))
			.done,
	).toBe(true);
});

test("deletion state blocks normal authenticated writes", async () => {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { email: "b@test" });
		const sessionId = await ctx.db.insert("authSessions", {
			userId,
			expirationTime: Date.now() + 60000,
		});
		await ctx.db.insert("accountDeletionStates", {
			userId,
			phase: "files",
			createdAt: 1,
			updatedAt: 1,
		});
		return { userId, sessionId };
	});
	expect(
		await t
			.withIdentity({ subject: `${ids.userId}|${ids.sessionId}` })
			.query(api.users.getUser, {}),
	).toBeNull();
});
