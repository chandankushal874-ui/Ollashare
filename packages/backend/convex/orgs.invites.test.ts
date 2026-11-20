/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seedInvite(
	t: ReturnType<typeof convexTest>,
	email: string,
	role = "member",
) {
	return t.run(async (ctx) => {
		const owner = await ctx.db.insert("users", {
			email: "owner@t.test",
			emailVerificationTime: Date.now(),
		});
		const workspaceId = await ctx.db.insert("workspaces", {
			name: "Invite Workspace",
			ownerId: owner,
			createdAt: Date.now(),
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId: owner,
			role: "owner",
			createdAt: Date.now(),
		});
		const inviteId = await ctx.db.insert("invites", {
			workspaceId,
			email,
			role,
			invitedBy: owner,
			accepted: false,
			expiresAt: Date.now() + 60_000,
			createdAt: Date.now(),
		});
		return { inviteId, owner, workspaceId };
	});
}

async function addVerifiedIdentity(
	t: ReturnType<typeof convexTest>,
	userId: string,
	provider: "password" | "resend-otp" | "google",
	providerAccountId: string,
	email: string,
) {
	await t.run((ctx) =>
		ctx.db.insert("authAccounts", {
			userId: userId as never,
			provider,
			providerAccountId,
			emailVerified: email,
			...(provider === "password" ? { secret: "hash" } : {}),
		}),
	);
}

describe("verified email workspace invites", () => {
	test("unverified password account cannot list or accept an email invite", async () => {
		const t = convexTest(schema, modules);
		const { inviteId } = await seedInvite(t, "target@t.test");
		const userId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { email: "target@t.test" });
			await ctx.db.insert("authAccounts", {
				userId,
				provider: "password",
				providerAccountId: "target@t.test",
				secret: "hash",
			});
			return userId;
		});

		const user = t.withIdentity(as(userId));
		expect(await user.query(api.orgs.myInvites, {})).toEqual([]);
		await expect(
			user.mutation(api.orgs.acceptInvite, { inviteId }),
		).rejects.toThrow(/Verified email required/);
	});

	test("fails closed for a legacy account with only profile verification state", async () => {
		const t = convexTest(schema, modules);
		const { inviteId } = await seedInvite(t, "unavailable@t.test");
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				email: "unavailable@t.test",
				emailVerificationTime: Date.now(),
			}),
		);

		const user = t.withIdentity(as(userId));
		expect(await user.query(api.orgs.myInvites, {})).toEqual([]);
		await expect(
			user.mutation(api.orgs.acceptInvite, { inviteId }),
		).rejects.toThrow(/Verified email required/);
	});

	test("verified normalized email can list and accept an invite", async () => {
		const t = convexTest(schema, modules);
		const { inviteId, workspaceId } = await seedInvite(t, "target@t.test");
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				email: "  TARGET@T.TEST  ",
				emailVerificationTime: Date.now(),
			}),
		);
		await addVerifiedIdentity(
			t,
			userId,
			"password",
			"target@t.test",
			"target@t.test",
		);

		const user = t.withIdentity(as(userId));
		expect(await user.query(api.orgs.myInvites, {})).toEqual([
			{
				_id: inviteId,
				role: "member",
				workspaceId,
				workspaceName: "Invite Workspace",
			},
		]);
		expect(await user.mutation(api.orgs.acceptInvite, { inviteId })).toBe(
			workspaceId,
		);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("members")
					.withIndex("by_user_workspace", (q) =>
						q.eq("userId", userId).eq("workspaceId", workspaceId),
					)
					.unique(),
			),
		).toMatchObject({ role: "member" });
	});

	test("pre-registration account cannot hijack an invite before verification", async () => {
		const t = convexTest(schema, modules);
		const { inviteId } = await seedInvite(t, "future@t.test");
		const attacker = await t.run(async (ctx) => {
			const attacker = await ctx.db.insert("users", { email: "future@t.test" });
			await ctx.db.insert("authAccounts", {
				userId: attacker,
				provider: "password",
				providerAccountId: "future@t.test",
				secret: "attacker-hash",
			});
			return attacker;
		});
		const attackerClient = t.withIdentity(as(attacker));

		expect(await attackerClient.query(api.orgs.myInvites, {})).toEqual([]);
		await expect(
			attackerClient.mutation(api.orgs.acceptInvite, { inviteId }),
		).rejects.toThrow(/Verified email required/);
		expect((await t.run((ctx) => ctx.db.get(inviteId)))?.accepted).toBe(false);
	});

	test("verified invite acceptance preserves admin role", async () => {
		const t = convexTest(schema, modules);
		const { inviteId, workspaceId } = await seedInvite(
			t,
			"admin@t.test",
			"admin",
		);
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				email: "ADMIN@T.TEST",
				emailVerificationTime: Date.now(),
			}),
		);
		await addVerifiedIdentity(
			t,
			userId,
			"resend-otp",
			"admin@t.test",
			"admin@t.test",
		);

		await t
			.withIdentity(as(userId))
			.mutation(api.orgs.acceptInvite, { inviteId });
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("members")
					.withIndex("by_user_workspace", (q) =>
						q.eq("userId", userId).eq("workspaceId", workspaceId),
					)
					.unique(),
			),
		).toMatchObject({ role: "admin" });
	});

	test("authoritative OTP and OAuth identities continue to work", async () => {
		for (const identity of [
			{
				provider: "resend-otp" as const,
				accountId: "otp@t.test",
				email: "otp@t.test",
			},
			{
				provider: "google" as const,
				accountId: "google-subject-123",
				email: "oauth@t.test",
			},
		]) {
			const t = convexTest(schema, modules);
			const { inviteId, workspaceId } = await seedInvite(t, identity.email);
			const userId = await t.run((ctx) =>
				ctx.db.insert("users", {
					email: "mutable-profile@t.test",
				}),
			);
			await addVerifiedIdentity(
				t,
				userId,
				identity.provider,
				identity.accountId,
				identity.email,
			);
			const user = t.withIdentity(as(userId));

			expect(await user.query(api.orgs.myInvites, {})).toHaveLength(1);
			expect(await user.mutation(api.orgs.acceptInvite, { inviteId })).toBe(
				workspaceId,
			);
		}
	});

	test("verification must be bound to the caller and, for address credentials, the same address", async () => {
		const t = convexTest(schema, modules);
		const { inviteId } = await seedInvite(t, "bound@t.test");
		const { caller, other } = await t.run(async (ctx) => ({
			caller: await ctx.db.insert("users", {
				email: "bound@t.test",
				emailVerificationTime: Date.now(),
			}),
			other: await ctx.db.insert("users", {
				email: "bound@t.test",
				emailVerificationTime: Date.now(),
			}),
		}));
		await addVerifiedIdentity(
			t,
			other,
			"resend-otp",
			"bound@t.test",
			"bound@t.test",
		);
		await addVerifiedIdentity(
			t,
			caller,
			"password",
			"different@t.test",
			"bound@t.test",
		);
		const user = t.withIdentity(as(caller));

		expect(await user.query(api.orgs.myInvites, {})).toEqual([]);
		await expect(
			user.mutation(api.orgs.acceptInvite, { inviteId }),
		).rejects.toThrow(/Verified email required/);
	});

	test("mutable profile email cannot discover or accept another address's invite", async () => {
		const t = convexTest(schema, modules);
		const { inviteId } = await seedInvite(t, "victim@t.test");
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				email: "victim@t.test",
				emailVerificationTime: Date.now(),
			}),
		);
		await addVerifiedIdentity(
			t,
			userId,
			"resend-otp",
			"attacker@t.test",
			"attacker@t.test",
		);
		const user = t.withIdentity(as(userId));

		expect(await user.query(api.orgs.myInvites, {})).toEqual([]);
		await expect(
			user.mutation(api.orgs.acceptInvite, { inviteId }),
		).rejects.toThrow(/Invite unavailable/);
	});

	test("unauthenticated and wrong-address callers receive no invitation existence signal", async () => {
		const t = convexTest(schema, modules);
		const { inviteId } = await seedInvite(t, "private@t.test");
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", { email: "other@t.test" }),
		);
		await addVerifiedIdentity(
			t,
			userId,
			"resend-otp",
			"other@t.test",
			"other@t.test",
		);
		const caller = t.withIdentity(as(userId));

		expect(await t.query(api.orgs.myInvites, {})).toEqual([]);
		await expect(
			t.mutation(api.orgs.acceptInvite, { inviteId }),
		).rejects.toThrow(/Invite unavailable/);
		await expect(
			caller.mutation(api.orgs.acceptInvite, { inviteId }),
		).rejects.toThrow(/Invite unavailable/);
	});

	test("expired and revoked invitations remain unavailable to the verified addressee", async () => {
		const t = convexTest(schema, modules);
		const expired = await seedInvite(t, "lifecycle@t.test");
		const revoked = await t.run(async (ctx) =>
			ctx.db.insert("invites", {
				workspaceId: expired.workspaceId,
				email: "lifecycle@t.test",
				role: "member",
				invitedBy: expired.owner,
				accepted: false,
				revokedAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
			}),
		);
		await t.run((ctx) =>
			ctx.db.patch(expired.inviteId, { expiresAt: Date.now() - 1 }),
		);
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", { email: "lifecycle@t.test" }),
		);
		await addVerifiedIdentity(
			t,
			userId,
			"resend-otp",
			"lifecycle@t.test",
			"lifecycle@t.test",
		);
		const user = t.withIdentity(as(userId));

		expect(await user.query(api.orgs.myInvites, {})).toEqual([]);
		await expect(
			user.mutation(api.orgs.acceptInvite, { inviteId: expired.inviteId }),
		).rejects.toThrow(/Invite not found/);
		await expect(
			user.mutation(api.orgs.acceptInvite, { inviteId: revoked }),
		).rejects.toThrow(/Invite not found/);
	});
});
