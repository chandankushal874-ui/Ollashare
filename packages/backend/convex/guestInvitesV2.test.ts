import { describe, expect, test, vi } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { disableScreenshareSchedulingForTests } from "./screenshare/lib";
import { projectPublicUser } from "./userProjection";

disableScreenshareSchedulingForTests();
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seed(t: ReturnType<typeof convexTest>) {
	const seeded = await t.run(async (ctx) => {
		const owner = await ctx.db.insert("users", { email: "owner@invite.test" });
		const member = await ctx.db.insert("users", {
			email: "member@invite.test",
		});
		const ws = await ctx.db.insert("workspaces", {
			name: "Invite tests",
			ownerId: owner,
			createdAt: Date.now(),
		});
		await ctx.db.insert("members", {
			workspaceId: ws,
			userId: owner,
			role: "owner",
			createdAt: Date.now(),
		});
		await ctx.db.insert("members", {
			workspaceId: ws,
			userId: member,
			role: "member",
			createdAt: Date.now(),
		});
		return { owner, member, ws };
	});
	const { code } = await t
		.withIdentity(as(seeded.owner))
		.mutation(api.screenshare.createRoom, { workspaceId: seeded.ws });
	return { ...seeded, code };
}

async function bindGuest(
	t: ReturnType<typeof convexTest>,
	roomCode: string,
	requestSecret: string,
) {
	const guest = await t.run((ctx) =>
		ctx.db.insert("users", { name: "Guest", isAnonymous: true }),
	);
	const result = await t.mutation(
		internal.security.finalizeAnonymousAdmissionBinding,
		{
			userId: guest,
			roomCode,
			requestSecret,
		},
	);
	return { guest, result };
}

describe("stable guest invitations v2", () => {
	test("stores only hashes/verifiers and returns safe host metadata", async () => {
		const t = convexTest(schema, modules);
		const { owner, code } = await seed(t);
		const created = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, {
				code,
				label: "Private review",
				password: "correct horse battery staple",
				expiresInMs: 24 * 60 * 60_000,
				maxUses: 4,
				requireApproval: true,
			});
		const row = await t.run((ctx) => ctx.db.get(created.inviteId));
		expect(row?.version).toBe(2);
		expect(row?.tokenHash).not.toBe(created.token);
		expect(row?.passwordVerifier).not.toContain("correct horse");
		expect(JSON.stringify(row)).not.toContain(created.token);
		const listed = await t
			.withIdentity(as(owner))
			.query(api.screenshare.listGuestInvites, { code });
		expect(listed[0]).toMatchObject({
			label: "Private review",
			passwordProtected: true,
			requireApproval: true,
		});
		expect(listed[0]).not.toHaveProperty("tokenHash");
		expect(listed[0]).not.toHaveProperty("passwordSalt");
		expect(listed[0]).not.toHaveProperty("passwordVerifier");
	});

	test("password failures are generic and valid password creates an admission request", async () => {
		const t = convexTest(schema, modules);
		const { owner, code } = await seed(t);
		const created = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, {
				code,
				password: "correct horse battery staple",
			});
		await expect(
			t.action(api.screenshare.createGuestAdmissionRequestSecure, {
				roomCode: code,
				guestInviteToken: created.token,
				displayName: "Guest",
				password: "wrong password",
			}),
		).rejects.toThrow(/Invitation could not be verified/);
		await expect(
			t.action(api.screenshare.createGuestAdmissionRequestSecure, {
				roomCode: code,
				guestInviteToken: "f".repeat(64),
				displayName: "Guest",
				password: "wrong password",
			}),
		).rejects.toThrow(/Invitation could not be verified/);
		const request = await t.action(
			api.screenshare.createGuestAdmissionRequestSecure,
			{
				roomCode: code,
				guestInviteToken: created.token,
				displayName: "Guest",
				password: "correct horse battery staple",
			},
		);
		expect(request.status).toBe("approved");
	});

	test("approval does not consume; final binding consumes exactly once and rejects replay", async () => {
		const t = convexTest(schema, modules);
		const { owner, code } = await seed(t);
		const created = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, {
				code,
				oneTime: true,
				requireApproval: true,
			});
		const request = await t.action(
			api.screenshare.createGuestAdmissionRequestSecure,
			{
				roomCode: code,
				guestInviteToken: created.token,
				displayName: "Alice",
			},
		);
		const pending = await t
			.withIdentity(as(owner))
			.query(api.screenshare.listGuestAdmissionRequests, { code });
		expect(pending).toHaveLength(1);
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.decideGuestAdmission, {
				code,
				requestId: request.requestId,
				approved: true,
			});
		expect((await t.run((ctx) => ctx.db.get(created.inviteId)))?.uses).toBe(0);
		const first = await bindGuest(t, code, request.requestSecret);
		expect(first.result.allowed).toBe(true);
		expect((await t.run((ctx) => ctx.db.get(created.inviteId)))?.uses).toBe(1);
		const replay = await bindGuest(t, code, request.requestSecret);
		expect(replay.result.allowed).toBe(false);
	});

	test("concurrent final consumption enforces max uses transactionally", async () => {
		const t = convexTest(schema, modules);
		const { owner, code } = await seed(t);
		const created = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, { code, oneTime: true });
		const requests = await Promise.all(
			["A", "B"].map((displayName) =>
				t.action(api.screenshare.createGuestAdmissionRequestSecure, {
					roomCode: code,
					guestInviteToken: created.token,
					displayName,
				}),
			),
		);
		const guests = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { isAnonymous: true }),
				ctx.db.insert("users", { isAnonymous: true }),
			]),
		);
		const results = await Promise.all(
			requests.map((request, index) => {
				const userId = guests[index];
				if (!userId) throw new Error("Expected guest identity");
				return t.mutation(internal.security.finalizeAnonymousAdmissionBinding, {
					userId,
					roomCode: code,
					requestSecret: request.requestSecret,
				});
			}),
		);
		expect(results.filter((result) => result.allowed)).toHaveLength(1);
		expect((await t.run((ctx) => ctx.db.get(created.inviteId)))?.uses).toBe(1);
	});

	test("deny, approval expiry, revoke one/all, lock, end, and room binding fail closed", async () => {
		const t = convexTest(schema, modules);
		const { owner, ws, code } = await seed(t);
		const deniedInvite = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, {
				code,
				requireApproval: true,
			});
		const deniedRequest = await t.action(
			api.screenshare.createGuestAdmissionRequestSecure,
			{
				roomCode: code,
				guestInviteToken: deniedInvite.token,
				displayName: "Denied",
			},
		);
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.decideGuestAdmission, {
				code,
				requestId: deniedRequest.requestId,
				approved: false,
			});
		expect(
			(await bindGuest(t, code, deniedRequest.requestSecret)).result.allowed,
		).toBe(false);

		const expiringInvite = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, {
				code,
				requireApproval: true,
			});
		const expiringRequest = await t.action(
			api.screenshare.createGuestAdmissionRequestSecure,
			{
				roomCode: code,
				guestInviteToken: expiringInvite.token,
				displayName: "Expired approval",
			},
		);
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.decideGuestAdmission, {
				code,
				requestId: expiringRequest.requestId,
				approved: true,
			});
		await t.run((ctx) =>
			ctx.db.patch(expiringRequest.requestId, { expiresAt: Date.now() - 1 }),
		);
		expect(
			(await bindGuest(t, code, expiringRequest.requestSecret)).result.allowed,
		).toBe(false);

		const expiredInvite = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, { code });
		await t.run((ctx) =>
			ctx.db.patch(expiredInvite.inviteId, { expiresAt: Date.now() - 1 }),
		);
		await expect(
			t.action(api.screenshare.createGuestAdmissionRequestSecure, {
				roomCode: code,
				guestInviteToken: expiredInvite.token,
				displayName: "Expired invitation",
			}),
		).rejects.toThrow(/Invitation could not be verified/);

		const first = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, { code });
		const second = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, { code });
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.revokeGuestInvite, {
				code,
				inviteId: first.inviteId,
			});
		await expect(
			t.action(api.screenshare.createGuestAdmissionRequestSecure, {
				roomCode: code,
				guestInviteToken: first.token,
				displayName: "X",
			}),
		).rejects.toThrow();
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.revokeGuestInvites, { code });
		await expect(
			t.action(api.screenshare.createGuestAdmissionRequestSecure, {
				roomCode: code,
				guestInviteToken: second.token,
				displayName: "X",
			}),
		).rejects.toThrow();

		const locked = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, { code });
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.setRoomLock, { code, locked: true });
		await expect(
			t.action(api.screenshare.createGuestAdmissionRequestSecure, {
				roomCode: code,
				guestInviteToken: locked.token,
				displayName: "X",
			}),
		).rejects.toThrow();
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.setRoomLock, { code, locked: false });

		const other = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.createRoom, { workspaceId: ws });
		const bound = await t
			.withIdentity(as(owner))
			.action(api.screenshare.createGuestInviteSecure, { code });
		await expect(
			t.action(api.screenshare.createGuestAdmissionRequestSecure, {
				roomCode: other.code,
				guestInviteToken: bound.token,
				displayName: "X",
			}),
		).rejects.toThrow();
		await t.withIdentity(as(owner)).mutation(api.screenshare.endRoom, { code });
		await expect(
			t.action(api.screenshare.createGuestAdmissionRequestSecure, {
				roomCode: code,
				guestInviteToken: bound.token,
				displayName: "X",
			}),
		).rejects.toThrow();
	});

	test("legacy v1 compatibility drains while registered room-code join remains unchanged", async () => {
		const t = convexTest(schema, modules);
		const { owner, member, code } = await seed(t);
		await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
			roomCode: code,
			name: "Registered member",
		});
		const token = "a".repeat(64);
		await t.run(async (ctx) => {
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(token),
			);
			const tokenHash = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			await ctx.db.insert("screenshareGuestInvites", {
				roomCode: code,
				tokenHash,
				createdBy: owner,
				createdAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				maxUses: 1,
				uses: 0,
			});
		});
		const guest = await t.run((ctx) =>
			ctx.db.insert("users", { isAnonymous: true }),
		);
		const legacy = await t.mutation(
			internal.security.finalizeLegacyAnonymousInviteBinding,
			{
				userId: guest,
				roomCode: code,
				guestInviteToken: token,
			},
		);
		expect(legacy.allowed).toBe(true);
	});

	test("public user projection omits security-only anonymous binding fields", () => {
		const projected = projectPublicUser({
			name: "Guest",
			isAnonymous: true,
			anonymousInviteRoomCode: "MIRA-ABCDE-FGHIJ-KLMNP",
			anonymousInviteTokenHash: "secret-hash",
			anonymousInviteExpiresAt: Date.now() + 60_000,
			anonymousInviteId: "invite-id",
			anonymousAdmissionRequestId: "request-id",
			anonymousInviteVersion: 2,
		});
		expect(projected).not.toHaveProperty("anonymousInviteRoomCode");
		expect(projected).not.toHaveProperty("anonymousInviteTokenHash");
		expect(projected).not.toHaveProperty("anonymousInviteExpiresAt");
		expect(projected).not.toHaveProperty("anonymousInviteId");
		expect(projected).not.toHaveProperty("anonymousAdmissionRequestId");
	});

	test("rate limits and bounded cleanup are enforced", async () => {
		const t = convexTest(schema, modules);
		const { owner, code } = await seed(t);
		for (let index = 0; index < 20; index += 1) {
			await t
				.withIdentity(as(owner))
				.action(api.screenshare.createGuestInviteSecure, {
					code,
					label: `invite-${index}`,
				});
		}
		await expect(
			t
				.withIdentity(as(owner))
				.action(api.screenshare.createGuestInviteSecure, { code }),
		).rejects.toThrow(/Too many requests/);

		const now = Date.now();
		const expiredRequest = await t.run(async (ctx) => {
			const invite = await ctx.db.insert("screenshareGuestInvites", {
				roomCode: code,
				tokenHash: "cleanup-hash",
				version: 2,
				createdBy: owner,
				createdAt: now - 2 * 24 * 60 * 60_000,
				expiresAt: now - 24 * 60 * 60_000 - 1,
				maxUses: 1,
				uses: 0,
			});
			return ctx.db.insert("screenshareGuestAdmissionRequests", {
				roomCode: code,
				inviteId: invite,
				requestSecretHash: "cleanup-request",
				displayName: "Old",
				status: "pending",
				createdAt: now - 60_000,
				expiresAt: now - 1,
			});
		});
		vi.setSystemTime(now + 1);
		try {
			const cleanup = await t.mutation(
				internal.screenshare.cleanupGuestInvitationData,
				{},
			);
			expect(cleanup.expiredRequests).toBeGreaterThanOrEqual(1);
		} finally {
			vi.useRealTimers();
		}
		expect((await t.run((ctx) => ctx.db.get(expiredRequest)))?.status).toBe(
			"expired",
		);
	});
});
