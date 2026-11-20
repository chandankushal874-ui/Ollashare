import { expect, test, vi } from "vitest";
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
}));

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const as = (userId: Id<"users">) => ({ subject: `${userId}|fixture` });

async function seedRegisteredUser(
	t: ReturnType<typeof convexTest>,
	email: string,
) {
	return t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { email, isAnonymous: false });
		await ctx.db.insert("authAccounts", {
			userId,
			provider: "password",
			providerAccountId: email,
			secret: "fabricated-hash",
		});
		return userId;
	});
}

async function seedAvatarUpload(
	t: ReturnType<typeof convexTest>,
	userId: Id<"users">,
	attached: boolean,
) {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(
			new Blob([png], { type: "image/png" }),
		);
		const uploadId = await ctx.db.insert("uploadObjects", {
			storageId,
			userId,
			size: png.byteLength,
			contentType: "image/png",
			attached,
			createdAt: Date.now(),
		});
		return { storageId, uploadId };
	});
}

async function storageExists(
	t: ReturnType<typeof convexTest>,
	storageId: Id<"_storage">,
) {
	return t.run(async (ctx) => Boolean(await ctx.storage.get(storageId)));
}

async function finishDeletion(
	t: ReturnType<typeof convexTest>,
	userId: Id<"users">,
) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await t.mutation(internal.users.deleteUserAccount, { userId })).done)
			return;
	}
	throw new Error("Deletion did not finish");
}

test("anonymous identities cannot issue, update, or remove general profile avatars", async () => {
	const t = convexTest(schema, modules);
	const guest = await t.run((ctx) =>
		ctx.db.insert("users", { name: "Guest", isAnonymous: true }),
	);
	const oldAvatar = await seedAvatarUpload(t, guest, true);
	const newAvatar = await seedAvatarUpload(t, guest, false);
	await t.run((ctx) => ctx.db.patch(guest, { imageId: oldAvatar.storageId }));
	const caller = t.withIdentity(as(guest));

	await expect(
		caller.mutation(api.users.generateUploadUrl, {}),
	).rejects.toThrow(/Not authenticated/);
	await expect(
		caller.mutation(api.users.updateUserImage, {
			imageId: newAvatar.storageId,
		}),
	).rejects.toThrow(/Not authenticated/);
	await expect(caller.mutation(api.users.removeUserImage, {})).rejects.toThrow(
		/Not authenticated/,
	);

	expect((await t.run((ctx) => ctx.db.get(guest)))?.imageId).toBe(
		oldAvatar.storageId,
	);
	expect(await storageExists(t, oldAvatar.storageId)).toBe(true);
	expect(await storageExists(t, newAvatar.storageId)).toBe(true);
	expect((await t.run((ctx) => ctx.db.get(newAvatar.uploadId)))?.attached).toBe(
		false,
	);
});

test("pre-existing anonymous profile tickets cannot be consumed or registered", async () => {
	const t = convexTest(schema, modules);
	const { guest, token } = await t.run(async (ctx) => {
		const guest = await ctx.db.insert("users", {
			name: "Guest",
			isAnonymous: true,
		});
		const token = "a".repeat(64);
		const { sha256 } = await import("./security");
		await ctx.db.insert("uploadTickets", {
			tokenHash: await sha256(token),
			userId: guest,
			expiresAt: Date.now() + 60_000,
		});
		return { guest, token };
	});
	expect(await t.mutation(internal.uploads.consume, { token })).toBeNull();
	const storageId = await t.run((ctx) =>
		ctx.storage.store(new Blob([png], { type: "image/png" })),
	);
	await expect(
		t.mutation(internal.uploads.register, {
			storageId,
			userId: guest,
			size: png.byteLength,
			contentType: "image/png",
		}),
	).rejects.toThrow(/Not authenticated/);
});

test("registered accounts can issue profile upload tickets", async () => {
	const t = convexTest(schema, modules);
	const userId = await seedRegisteredUser(t, "registered-avatar@test.invalid");
	await expect(
		t.withIdentity(as(userId)).mutation(api.users.generateUploadUrl, {}),
	).resolves.toMatchObject({ url: "/api/uploads" });
});

test("avatar replacement attaches the new upload and transactionally reclaims only the prior avatar", async () => {
	const t = convexTest(schema, modules);
	const userId = await seedRegisteredUser(t, "replace-avatar@test.invalid");
	const oldAvatar = await seedAvatarUpload(t, userId, true);
	const newAvatar = await seedAvatarUpload(t, userId, false);
	await t.run((ctx) => ctx.db.patch(userId, { imageId: oldAvatar.storageId }));

	await t
		.withIdentity(as(userId))
		.mutation(api.users.updateUserImage, { imageId: newAvatar.storageId });

	expect((await t.run((ctx) => ctx.db.get(userId)))?.imageId).toBe(
		newAvatar.storageId,
	);
	expect(await t.run((ctx) => ctx.storage.get(oldAvatar.storageId))).toBeNull();
	expect(await t.run((ctx) => ctx.db.get(oldAvatar.uploadId))).toBeNull();
	expect(await storageExists(t, newAvatar.storageId)).toBe(true);
	expect((await t.run((ctx) => ctx.db.get(newAvatar.uploadId)))?.attached).toBe(
		true,
	);
});

test("same-storage-id replacement and repeated removal are idempotent", async () => {
	const t = convexTest(schema, modules);
	const userId = await seedRegisteredUser(t, "idempotent-avatar@test.invalid");
	const avatar = await seedAvatarUpload(t, userId, true);
	await t.run((ctx) => ctx.db.patch(userId, { imageId: avatar.storageId }));
	const caller = t.withIdentity(as(userId));

	await caller.mutation(api.users.updateUserImage, {
		imageId: avatar.storageId,
	});
	await caller.mutation(api.users.updateUserImage, {
		imageId: avatar.storageId,
	});
	expect(await storageExists(t, avatar.storageId)).toBe(true);
	expect(await t.run((ctx) => ctx.db.get(avatar.uploadId))).not.toBeNull();

	await caller.mutation(api.users.removeUserImage, {});
	await caller.mutation(api.users.removeUserImage, {});
	expect((await t.run((ctx) => ctx.db.get(userId)))?.imageId).toBeUndefined();
	expect(await t.run((ctx) => ctx.storage.get(avatar.storageId))).toBeNull();
	expect(await t.run((ctx) => ctx.db.get(avatar.uploadId))).toBeNull();
});

test("replacement does not delete prior storage whose upload metadata belongs to another user", async () => {
	const t = convexTest(schema, modules);
	const userId = await seedRegisteredUser(t, "avatar-owner@test.invalid");
	const otherId = await seedRegisteredUser(
		t,
		"other-avatar-owner@test.invalid",
	);
	const mismatchedOld = await seedAvatarUpload(t, otherId, true);
	const newAvatar = await seedAvatarUpload(t, userId, false);
	await t.run((ctx) =>
		ctx.db.patch(userId, { imageId: mismatchedOld.storageId }),
	);

	await t
		.withIdentity(as(userId))
		.mutation(api.users.updateUserImage, { imageId: newAvatar.storageId });

	expect((await t.run((ctx) => ctx.db.get(userId)))?.imageId).toBe(
		newAvatar.storageId,
	);
	expect(await storageExists(t, mismatchedOld.storageId)).toBe(true);
	expect(
		await t.run((ctx) => ctx.db.get(mismatchedOld.uploadId)),
	).not.toBeNull();
});

test("cleanup failure rolls back replacement so the user never points at a deleted or half-swapped avatar", async () => {
	const t = convexTest(schema, modules);
	const userId = await seedRegisteredUser(t, "rollback-avatar@test.invalid");
	const oldAvatar = await seedAvatarUpload(t, userId, true);
	const newAvatar = await seedAvatarUpload(t, userId, false);
	await t.run(async (ctx) => {
		await ctx.db.patch(userId, { imageId: oldAvatar.storageId });
		await ctx.db.patch(oldAvatar.uploadId, { size: png.byteLength + 1 });
	});

	await expect(
		t
			.withIdentity(as(userId))
			.mutation(api.users.updateUserImage, { imageId: newAvatar.storageId }),
	).rejects.toThrow(/metadata mismatch/i);

	expect((await t.run((ctx) => ctx.db.get(userId)))?.imageId).toBe(
		oldAvatar.storageId,
	);
	expect(await storageExists(t, oldAvatar.storageId)).toBe(true);
	expect((await t.run((ctx) => ctx.db.get(newAvatar.uploadId)))?.attached).toBe(
		false,
	);
});

test("removal reclaims the active owned avatar blob and metadata", async () => {
	const t = convexTest(schema, modules);
	const userId = await seedRegisteredUser(t, "remove-avatar@test.invalid");
	const avatar = await seedAvatarUpload(t, userId, true);
	await t.run((ctx) => ctx.db.patch(userId, { imageId: avatar.storageId }));

	await t.withIdentity(as(userId)).mutation(api.users.removeUserImage, {});

	expect((await t.run((ctx) => ctx.db.get(userId)))?.imageId).toBeUndefined();
	expect(await t.run((ctx) => ctx.storage.get(avatar.storageId))).toBeNull();
	expect(await t.run((ctx) => ctx.db.get(avatar.uploadId))).toBeNull();
});

test("account deletion remains idempotent after avatar lifecycle cleanup", async () => {
	const t = convexTest(schema, modules);
	const userId = await seedRegisteredUser(t, "delete-avatar@test.invalid");
	const avatar = await seedAvatarUpload(t, userId, true);
	await t.run((ctx) => ctx.db.patch(userId, { imageId: avatar.storageId }));

	await finishDeletion(t, userId);

	expect(await t.run((ctx) => ctx.db.get(userId))).toBeNull();
	expect(await t.run((ctx) => ctx.storage.get(avatar.storageId))).toBeNull();
	expect(await t.run((ctx) => ctx.db.get(avatar.uploadId))).toBeNull();
	expect(
		(await t.mutation(internal.users.deleteUserAccount, { userId })).done,
	).toBe(true);
});

test("anonymous workspace file uploads retain their existing workspace-scoped behavior", async () => {
	const t = convexTest(schema, modules);
	const { guest, workspaceId } = await t.run(async (ctx) => {
		const owner = await ctx.db.insert("users", {
			email: "workspace-owner@test.invalid",
		});
		const guest = await ctx.db.insert("users", {
			name: "Guest",
			isAnonymous: true,
		});
		const workspaceId = await ctx.db.insert("workspaces", {
			ownerId: owner,
			name: "Uploads",
			createdAt: Date.now(),
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId: owner,
			role: "owner",
			createdAt: Date.now(),
		});
		await ctx.db.insert("members", {
			workspaceId,
			userId: guest,
			role: "member",
			createdAt: Date.now(),
		});
		return { guest, workspaceId };
	});

	await expect(
		t
			.withIdentity(as(guest))
			.mutation(api.files.generateUploadUrl, { workspaceId }),
	).resolves.toMatchObject({ url: "/api/uploads" });
});
