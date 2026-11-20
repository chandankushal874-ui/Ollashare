import { describe, expect, test } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => {
		const now = Date.now();
		const owner = await ctx.db.insert("users", { email: "owner@keys.test" });
		const admin = await ctx.db.insert("users", { email: "admin@keys.test" });
		const member = await ctx.db.insert("users", { email: "member@keys.test" });
		const otherMember = await ctx.db.insert("users", {
			email: "other@keys.test",
		});
		const outsider = await ctx.db.insert("users", {
			email: "outsider@keys.test",
		});
		const workspaceId = await ctx.db.insert("workspaces", {
			name: "API key workspace",
			ownerId: owner,
			createdAt: now,
		});
		const otherWorkspaceId = await ctx.db.insert("workspaces", {
			name: "Other workspace",
			ownerId: owner,
			createdAt: now,
		});
		await Promise.all([
			ctx.db.insert("members", {
				workspaceId,
				userId: owner,
				role: "owner",
				createdAt: now,
			}),
			ctx.db.insert("members", {
				workspaceId,
				userId: admin,
				role: "admin",
				createdAt: now,
			}),
			ctx.db.insert("members", {
				workspaceId,
				userId: member,
				role: "member",
				createdAt: now,
			}),
			ctx.db.insert("members", {
				workspaceId,
				userId: otherMember,
				role: "member",
				createdAt: now,
			}),
			ctx.db.insert("members", {
				workspaceId: otherWorkspaceId,
				userId: owner,
				role: "owner",
				createdAt: now,
			}),
			ctx.db.insert("members", {
				workspaceId: otherWorkspaceId,
				userId: member,
				role: "member",
				createdAt: now,
			}),
		]);
		return {
			owner,
			admin,
			member,
			otherMember,
			outsider,
			workspaceId,
			otherWorkspaceId,
		};
	});
}

async function insertKey(
	t: ReturnType<typeof convexTest>,
	seeded: Seed,
	userId: Id<"users">,
	suffix: string,
	workspaceId = seeded.workspaceId,
) {
	return t.run((ctx) =>
		ctx.db.insert("apiKeys", {
			workspaceId,
			userId,
			name: `${suffix} key`,
			prefix: `sk_${suffix}`,
			hash: `${suffix}-hash`,
			revoked: false,
			createdAt: Date.now(),
		}),
	);
}

async function resolveHash(t: ReturnType<typeof convexTest>, hash: string) {
	return t.query(internal.apiKeys.resolveByHash, { hash });
}

describe("API-key inventory and revocation authorization", () => {
	test("listMine returns only the caller's workspace keys and never secret or owner fields", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const memberKey = await insertKey(t, seeded, seeded.member, "member");
		await insertKey(t, seeded, seeded.owner, "owner");
		await insertKey(t, seeded, seeded.admin, "admin");
		await insertKey(
			t,
			seeded,
			seeded.member,
			"other-workspace",
			seeded.otherWorkspaceId,
		);

		const memberKeys = await t
			.withIdentity(as(seeded.member))
			.query(api.apiKeys.listMine, { workspaceId: seeded.workspaceId });
		expect(memberKeys).toEqual([
			{
				_id: memberKey,
				name: "member key",
				prefix: "sk_member",
				revoked: false,
				createdAt: expect.any(Number),
			},
		]);
		expect(memberKeys[0]).not.toHaveProperty("hash");
		expect(memberKeys[0]).not.toHaveProperty("userId");
		expect(memberKeys[0]).not.toHaveProperty("workspaceId");

		const ownerKeys = await t
			.withIdentity(as(seeded.owner))
			.query(api.apiKeys.listMine, { workspaceId: seeded.workspaceId });
		expect(ownerKeys.map((key) => key.name)).toEqual(["owner key"]);
		await expect(
			t.withIdentity(as(seeded.outsider)).query(api.apiKeys.listMine, {
				workspaceId: seeded.workspaceId,
			}),
		).rejects.toThrow(/Forbidden/);
	});

	test("members revoke their own keys while current owners and admins can revoke member keys", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const ownKey = await insertKey(t, seeded, seeded.member, "own");
		const ownerTarget = await insertKey(
			t,
			seeded,
			seeded.otherMember,
			"owner-target",
		);
		const adminTarget = await insertKey(
			t,
			seeded,
			seeded.otherMember,
			"admin-target",
		);

		await t.withIdentity(as(seeded.member)).mutation(api.apiKeys.revoke, {
			workspaceId: seeded.workspaceId,
			id: ownKey,
		});
		await t.withIdentity(as(seeded.owner)).mutation(api.apiKeys.revoke, {
			workspaceId: seeded.workspaceId,
			id: ownerTarget,
		});
		await t.withIdentity(as(seeded.admin)).mutation(api.apiKeys.revoke, {
			workspaceId: seeded.workspaceId,
			id: adminTarget,
		});

		expect((await t.run((ctx) => ctx.db.get(ownKey)))?.revoked).toBe(true);
		expect((await t.run((ctx) => ctx.db.get(ownerTarget)))?.revoked).toBe(true);
		expect((await t.run((ctx) => ctx.db.get(adminTarget)))?.revoked).toBe(true);
	});

	test("ordinary members cannot revoke another member, owner, or admin key by guessed ID", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const targets = await Promise.all([
			insertKey(t, seeded, seeded.otherMember, "other-member"),
			insertKey(t, seeded, seeded.owner, "owner"),
			insertKey(t, seeded, seeded.admin, "admin"),
		]);

		for (const id of targets) {
			await expect(
				t.withIdentity(as(seeded.member)).mutation(api.apiKeys.revoke, {
					workspaceId: seeded.workspaceId,
					id,
				}),
			).rejects.toThrow(/API key unavailable/);
			expect((await t.run((ctx) => ctx.db.get(id)))?.revoked).toBe(false);
		}
	});

	test("outsiders, wrong-workspace IDs, and nonexistent IDs fail without revealing key existence", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const target = await insertKey(t, seeded, seeded.owner, "target");
		const deleted = await insertKey(
			t,
			seeded,
			seeded.member,
			"deleted",
			seeded.otherWorkspaceId,
		);
		await t.run((ctx) => ctx.db.delete(deleted));

		await expect(
			t.withIdentity(as(seeded.outsider)).mutation(api.apiKeys.revoke, {
				workspaceId: seeded.workspaceId,
				id: target,
			}),
		).rejects.toThrow(/Forbidden/);
		await expect(
			t.withIdentity(as(seeded.outsider)).mutation(api.apiKeys.revoke, {
				workspaceId: seeded.workspaceId,
				id: deleted,
			}),
		).rejects.toThrow(/Forbidden/);

		const wrongWorkspace = t
			.withIdentity(as(seeded.member))
			.mutation(api.apiKeys.revoke, {
				workspaceId: seeded.otherWorkspaceId,
				id: target,
			});
		const nonexistent = t
			.withIdentity(as(seeded.member))
			.mutation(api.apiKeys.revoke, {
				workspaceId: seeded.otherWorkspaceId,
				id: deleted,
			});
		await expect(wrongWorkspace).rejects.toThrow(/API key unavailable/);
		await expect(nonexistent).rejects.toThrow(/API key unavailable/);
		expect((await t.run((ctx) => ctx.db.get(target)))?.revoked).toBe(false);
	});

	test("revocation and membership removal immediately invalidate keys", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const revokedKey = await insertKey(t, seeded, seeded.member, "revoked");
		const removedKey = await insertKey(
			t,
			seeded,
			seeded.otherMember,
			"removed",
		);

		expect(await resolveHash(t, "revoked-hash")).toMatchObject({
			keyId: revokedKey,
		});
		await t.withIdentity(as(seeded.member)).mutation(api.apiKeys.revoke, {
			workspaceId: seeded.workspaceId,
			id: revokedKey,
		});
		expect(await resolveHash(t, "revoked-hash")).toBeNull();

		expect(await resolveHash(t, "removed-hash")).toMatchObject({
			keyId: removedKey,
		});
		const membership = await t.run((ctx) =>
			ctx.db
				.query("members")
				.withIndex("by_user_workspace", (q) =>
					q
						.eq("userId", seeded.otherMember)
						.eq("workspaceId", seeded.workspaceId),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected member membership");
		await t.withIdentity(as(seeded.owner)).mutation(api.orgs.removeMember, {
			workspaceId: seeded.workspaceId,
			memberId: membership._id,
		});
		expect((await t.run((ctx) => ctx.db.get(removedKey)))?.revoked).toBe(true);
		expect(await resolveHash(t, "removed-hash")).toBeNull();
	});

	test("current membership and role are rechecked for listing and administrative revocation", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const target = await insertKey(
			t,
			seeded,
			seeded.otherMember,
			"role-recheck",
		);
		const adminMembership = await t.run((ctx) =>
			ctx.db
				.query("members")
				.withIndex("by_user_workspace", (q) =>
					q.eq("userId", seeded.admin).eq("workspaceId", seeded.workspaceId),
				)
				.unique(),
		);
		if (!adminMembership) throw new Error("Expected admin membership");
		await t.run((ctx) => ctx.db.patch(adminMembership._id, { role: "member" }));

		await expect(
			t.withIdentity(as(seeded.admin)).mutation(api.apiKeys.revoke, {
				workspaceId: seeded.workspaceId,
				id: target,
			}),
		).rejects.toThrow(/API key unavailable/);

		const memberMembership = await t.run((ctx) =>
			ctx.db
				.query("members")
				.withIndex("by_user_workspace", (q) =>
					q.eq("userId", seeded.member).eq("workspaceId", seeded.workspaceId),
				)
				.unique(),
		);
		if (!memberMembership) throw new Error("Expected member membership");
		await t.run((ctx) => ctx.db.delete(memberMembership._id));
		await expect(
			t.withIdentity(as(seeded.member)).query(api.apiKeys.listMine, {
				workspaceId: seeded.workspaceId,
			}),
		).rejects.toThrow(/Forbidden/);
	});
});
