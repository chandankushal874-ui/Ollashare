import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	incrementAnalytics,
	markDailyActiveUser,
	recordGuestAdmission,
} from "../analytics";
import { randomSecret, sha256 } from "../security";
import {
	assertRateLimit,
	auditScreenshare,
	getRoomByCode,
	requireHostOrAdmin,
	sanitizeDisplayText,
	sanitizeName,
} from "./lib";

const INVITE_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const REQUEST_SECRET_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const MIN_INVITE_TTL_MS = 5 * 60_000;
const DEFAULT_INVITE_TTL_MS = 60 * 60_000;
const ADMISSION_TTL_MS = 30 * 60_000;
const MAX_LABEL_LENGTH = 80;
const MAX_PASSWORD_LENGTH = 256;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KDF = `pbkdf2-sha256-v1:${PBKDF2_ITERATIONS}`;
const PUBLIC_FAILURE = "Invitation could not be verified";

function isPositiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

export function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let mismatch = 0;
	for (let index = 0; index < left.length; index += 1) {
		mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return mismatch === 0;
}

export async function derivePasswordVerifier(
	password: string,
	saltHex: string,
): Promise<string> {
	if (!password || password.length > MAX_PASSWORD_LENGTH)
		throw new ConvexError(PUBLIC_FAILURE);
	if (!crypto?.subtle?.importKey || !crypto?.subtle?.deriveBits) {
		throw new ConvexError("Password-protected invitations are unavailable");
	}
	try {
		const salt = Uint8Array.from(saltHex.match(/../g) ?? [], (byte) =>
			Number.parseInt(byte, 16),
		);
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(password),
			"PBKDF2",
			false,
			["deriveBits"],
		);
		const bits = await crypto.subtle.deriveBits(
			{ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
			key,
			256,
		);
		return Array.from(new Uint8Array(bits), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	} catch (error) {
		if (error instanceof ConvexError) throw error;
		throw new ConvexError("Password-protected invitations are unavailable");
	}
}

function normalizeRoomCode(code: string): string {
	return code.trim().toUpperCase();
}

function publicInvite(invite: {
	_id: Id<"screenshareGuestInvites">;
	version?: number;
	label?: string;
	requireApproval?: boolean;
	passwordVerifier?: string;
	createdAt: number;
	expiresAt: number;
	maxUses: number;
	uses: number;
	lastUsedAt?: number;
	revokedAt?: number;
}) {
	return {
		id: invite._id,
		version: invite.version ?? 1,
		label: invite.label,
		requireApproval: Boolean(invite.requireApproval),
		passwordProtected: Boolean(invite.passwordVerifier),
		createdAt: invite.createdAt,
		expiresAt: invite.expiresAt,
		maxUses: invite.maxUses,
		uses: invite.uses,
		lastUsedAt: invite.lastUsedAt,
		revokedAt: invite.revokedAt,
	};
}

export const createGuestInviteArgs = {
	code: v.string(),
	expiresInMs: v.optional(v.number()),
	maxUses: v.optional(v.number()),
	oneTime: v.optional(v.boolean()),
	label: v.optional(v.string()),
	requireApproval: v.optional(v.boolean()),
	password: v.optional(v.string()),
};

export async function createGuestInvite(
	ctx: MutationCtx,
	args: ObjectType<typeof createGuestInviteArgs>,
) {
	if (args.password) {
		throw new ConvexError(
			"Password-protected invitations require the secure action",
		);
	}
	return createGuestInviteV2(ctx, args);
}

export async function createGuestInviteV2(
	ctx: MutationCtx,
	args: ObjectType<typeof createGuestInviteArgs> & {
		passwordSalt?: string;
		passwordVerifier?: string;
		passwordKdf?: string;
	},
) {
	const room = await getRoomByCode(ctx, normalizeRoomCode(args.code));
	if (!room) throw new ConvexError("Room not found");
	if (room.status !== "live" || room.isLocked)
		throw new ConvexError("Room is not accepting guest invitations");
	const actorId = await requireHostOrAdmin(ctx, room);
	await assertRateLimit(
		ctx,
		`guest-invite-create:${await sha256(`${room.code}:${actorId}`)}`,
		20,
		60 * 60_000,
	);
	const hasPasswordFields = Boolean(
		args.passwordSalt || args.passwordVerifier || args.passwordKdf,
	);
	if (
		hasPasswordFields &&
		(args.passwordKdf !== PBKDF2_KDF ||
			!args.passwordSalt ||
			!/^[a-f0-9]{32}$/i.test(args.passwordSalt) ||
			!args.passwordVerifier ||
			!/^[a-f0-9]{64}$/i.test(args.passwordVerifier))
	)
		throw new ConvexError("Invalid invitation settings");
	return insertGuestInvite(
		ctx,
		args,
		room,
		actorId,
		hasPasswordFields
			? {
					passwordSalt: args.passwordSalt,
					passwordVerifier: args.passwordVerifier,
					passwordKdf: args.passwordKdf,
				}
			: {},
	);
}

async function insertGuestInvite(
	ctx: MutationCtx,
	args: ObjectType<typeof createGuestInviteArgs>,
	room: NonNullable<Awaited<ReturnType<typeof getRoomByCode>>>,
	actorId: Id<"users">,
	passwordFields: {
		passwordSalt?: string;
		passwordVerifier?: string;
		passwordKdf?: string;
	},
) {
	const ttl = args.expiresInMs ?? DEFAULT_INVITE_TTL_MS;
	if (
		!Number.isFinite(ttl) ||
		ttl < MIN_INVITE_TTL_MS ||
		ttl > MAX_INVITE_TTL_MS
	) {
		throw new ConvexError(
			"Invitation expiry must be between 5 minutes and 7 days",
		);
	}
	const maxUses = args.oneTime ? 1 : args.maxUses ?? 8;
	if (!isPositiveInteger(maxUses) || maxUses > 100)
		throw new ConvexError("Invitation uses must be between 1 and 100");
	const label =
		sanitizeDisplayText(args.label ?? "", MAX_LABEL_LENGTH) || undefined;
	const now = Date.now();
	const token = randomSecret();
	const expiresAt = now + ttl;
	const inviteId = await ctx.db.insert("screenshareGuestInvites", {
		roomCode: room.code,
		tokenHash: await sha256(token),
		version: 2,
		label,
		requireApproval: args.requireApproval ?? false,
		...passwordFields,
		createdBy: actorId,
		createdAt: now,
		expiresAt,
		maxUses,
		uses: 0,
	});
	await auditScreenshare(
		ctx,
		room.workspaceId,
		actorId,
		"guest_invite.create",
		{
			roomCode: room.code,
			inviteId,
			expiresAt,
			maxUses,
			requireApproval: args.requireApproval ?? false,
			passwordProtected: Boolean(passwordFields.passwordVerifier),
			label,
		},
	);
	return {
		inviteId,
		token,
		version: 2,
		expiresAt,
		maxUses,
		requireApproval: args.requireApproval ?? false,
		passwordProtected: Boolean(passwordFields.passwordVerifier),
		label,
	};
}

export const listGuestInvitesArgs = { code: v.string() };

export async function listGuestInvites(
	ctx: QueryCtx,
	args: ObjectType<typeof listGuestInvitesArgs>,
) {
	const room = await getRoomByCode(ctx, normalizeRoomCode(args.code));
	if (!room) throw new ConvexError("Room not found");
	await requireHostOrAdmin(ctx, room);
	const invites = await ctx.db
		.query("screenshareGuestInvites")
		.withIndex("by_room", (q) => q.eq("roomCode", room.code))
		.order("desc")
		.take(100);
	return invites.map(publicInvite);
}

export const revokeGuestInviteArgs = {
	code: v.string(),
	inviteId: v.id("screenshareGuestInvites"),
};

export async function revokeGuestInviteByHost(
	ctx: MutationCtx,
	args: ObjectType<typeof revokeGuestInviteArgs>,
) {
	const room = await getRoomByCode(ctx, normalizeRoomCode(args.code));
	if (!room) throw new ConvexError("Room not found");
	const actorId = await requireHostOrAdmin(ctx, room);
	await assertRateLimit(
		ctx,
		`guest-invite-decision:${await sha256(`${room.code}:${actorId}`)}`,
		120,
		60 * 60_000,
	);
	const invite = await ctx.db.get(args.inviteId);
	if (!invite || invite.roomCode !== room.code)
		throw new ConvexError("Invitation not found");
	if (invite.revokedAt === undefined)
		await ctx.db.patch(invite._id, { revokedAt: Date.now() });
	await expireAdmissionRequestsForInvite(ctx, invite._id, Date.now());
	await auditScreenshare(
		ctx,
		room.workspaceId,
		actorId,
		"guest_invite.revoke_one",
		{
			roomCode: room.code,
			inviteId: invite._id,
		},
	);
	return true;
}

export const revokeGuestInvitesArgs = { code: v.string() };

export async function revokeGuestInvitesByHost(
	ctx: MutationCtx,
	args: ObjectType<typeof revokeGuestInvitesArgs>,
) {
	const room = await getRoomByCode(ctx, normalizeRoomCode(args.code));
	if (!room) throw new ConvexError("Room not found");
	const actorId = await requireHostOrAdmin(ctx, room);
	await assertRateLimit(
		ctx,
		`guest-invite-decision:${await sha256(`${room.code}:${actorId}`)}`,
		120,
		60 * 60_000,
	);
	const revoked = await revokeGuestInvites(ctx, room.code, Date.now());
	await auditScreenshare(
		ctx,
		room.workspaceId,
		actorId,
		"guest_invite.revoke_all",
		{
			roomCode: room.code,
			revoked,
		},
	);
	return { revoked };
}

export async function revokeGuestInvites(
	ctx: MutationCtx,
	roomCode: string,
	revokedAt = Date.now(),
) {
	const invites = await ctx.db
		.query("screenshareGuestInvites")
		.withIndex("by_room", (q) => q.eq("roomCode", roomCode))
		.take(200);
	let revoked = 0;
	for (const invite of invites) {
		if (invite.revokedAt === undefined) {
			await ctx.db.patch(invite._id, { revokedAt });
			revoked += 1;
		}
		await expireAdmissionRequestsForInvite(ctx, invite._id, revokedAt);
	}
	return revoked;
}

async function expireAdmissionRequestsForInvite(
	ctx: MutationCtx,
	inviteId: Id<"screenshareGuestInvites">,
	now: number,
) {
	for (const status of ["pending", "approved"] as const) {
		const requests = await ctx.db
			.query("screenshareGuestAdmissionRequests")
			.withIndex("by_invite_status", (q) =>
				q.eq("inviteId", inviteId).eq("status", status),
			)
			.take(100);
		for (const request of requests)
			await ctx.db.patch(request._id, { status: "expired", decidedAt: now });
	}
}

async function findActiveInvite(
	ctx: QueryCtx,
	roomCode: string,
	guestInviteToken: string,
) {
	if (!INVITE_TOKEN_PATTERN.test(guestInviteToken)) return null;
	const room = await getRoomByCode(ctx, normalizeRoomCode(roomCode));
	if (!room || room.status !== "live" || room.isLocked) return null;
	const tokenHash = await sha256(guestInviteToken);
	const invite = await ctx.db
		.query("screenshareGuestInvites")
		.withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
		.unique();
	const now = Date.now();
	if (
		!invite ||
		invite.roomCode !== room.code ||
		invite.revokedAt !== undefined ||
		invite.expiresAt <= now ||
		invite.uses >= invite.maxUses
	)
		return null;
	return { room, invite, tokenHash, now };
}

export const createGuestAdmissionRequestArgs = {
	roomCode: v.string(),
	guestInviteToken: v.string(),
	displayName: v.string(),
	password: v.optional(v.string()),
};

export async function createGuestAdmissionRequest(
	ctx: MutationCtx,
	args: ObjectType<typeof createGuestAdmissionRequestArgs>,
) {
	return createGuestAdmissionRequestVerified(ctx, args, false);
}

export async function prepareGuestAdmissionPasswordAttempt(
	ctx: MutationCtx,
	args: ObjectType<typeof createGuestAdmissionRequestArgs>,
) {
	const tokenIdentifier = await sha256(args.guestInviteToken);
	await assertRateLimit(
		ctx,
		`guest-admission-attempt:${tokenIdentifier}`,
		20,
		10 * 60_000,
	);
	const found = await findActiveInvite(
		ctx,
		args.roomCode,
		args.guestInviteToken,
	);
	if (!found || (found.invite.version ?? 1) !== 2)
		throw new ConvexError(PUBLIC_FAILURE);
	if (!found.invite.passwordVerifier)
		return { passwordProtected: false as const };
	if (!found.invite.passwordSalt || found.invite.passwordKdf !== PBKDF2_KDF)
		throw new ConvexError(PUBLIC_FAILURE);
	return {
		passwordProtected: true as const,
		passwordSalt: found.invite.passwordSalt,
		passwordVerifier: found.invite.passwordVerifier,
		passwordKdf: found.invite.passwordKdf,
	};
}

export async function createGuestAdmissionRequestVerified(
	ctx: MutationCtx,
	args: ObjectType<typeof createGuestAdmissionRequestArgs>,
	passwordVerified: boolean,
) {
	const tokenIdentifier = await sha256(args.guestInviteToken);
	const found = await findActiveInvite(
		ctx,
		args.roomCode,
		args.guestInviteToken,
	);
	if (!found || (found.invite.version ?? 1) !== 2)
		throw new ConvexError(PUBLIC_FAILURE);
	const { invite, room, now } = found;
	if (invite.passwordVerifier && !passwordVerified)
		throw new ConvexError(PUBLIC_FAILURE);
	if (!invite.passwordVerifier)
		await assertRateLimit(
			ctx,
			`guest-admission-attempt:${tokenIdentifier}`,
			20,
			10 * 60_000,
		);

	const displayName = sanitizeName(args.displayName);
	if (!displayName) throw new ConvexError("A display name is required");
	await assertRateLimit(
		ctx,
		`guest-admission-create:${await sha256(`${room.code}:${tokenIdentifier}`)}`,
		10,
		10 * 60_000,
	);
	const requestSecret = randomSecret();
	const requestSecretHash = await sha256(requestSecret);
	const expiresAt = Math.min(invite.expiresAt, now + ADMISSION_TTL_MS);
	const status = invite.requireApproval ? "pending" : "approved";
	const requestId = await ctx.db.insert("screenshareGuestAdmissionRequests", {
		roomCode: room.code,
		inviteId: invite._id,
		requestSecretHash,
		displayName,
		status,
		createdAt: now,
		expiresAt,
		...(status === "approved" ? { decidedAt: now } : {}),
	});
	return {
		requestId,
		requestSecret,
		roomCode: room.code,
		displayName,
		status,
		expiresAt,
		requiresApproval: Boolean(invite.requireApproval),
		label: invite.label,
	};
}

async function findAdmissionBySecret(
	ctx: QueryCtx,
	roomCode: string,
	requestSecret: string,
) {
	if (!REQUEST_SECRET_PATTERN.test(requestSecret)) return null;
	const requestSecretHash = await sha256(requestSecret);
	const request = await ctx.db
		.query("screenshareGuestAdmissionRequests")
		.withIndex("by_secret_hash", (q) =>
			q.eq("requestSecretHash", requestSecretHash),
		)
		.unique();
	if (!request || request.roomCode !== normalizeRoomCode(roomCode)) return null;
	return { request, requestSecretHash };
}

export const pollGuestAdmissionArgs = {
	roomCode: v.string(),
	requestSecret: v.string(),
};

export async function pollGuestAdmission(
	ctx: MutationCtx,
	args: ObjectType<typeof pollGuestAdmissionArgs>,
) {
	const identifier = await sha256(args.requestSecret);
	await assertRateLimit(
		ctx,
		`guest-admission-poll:${identifier}`,
		120,
		10 * 60_000,
	);
	const found = await findAdmissionBySecret(
		ctx,
		args.roomCode,
		args.requestSecret,
	);
	if (!found) return { status: "expired" as const };
	const { request } = found;
	if (
		request.expiresAt <= Date.now() &&
		request.status !== "consumed" &&
		request.status !== "denied"
	) {
		await ctx.db.patch(request._id, {
			status: "expired",
			decidedAt: Date.now(),
		});
		return { status: "expired" as const };
	}
	return {
		status: request.status,
		expiresAt: request.expiresAt,
		displayName: request.displayName,
		roomCode: request.roomCode,
	};
}

export const listGuestAdmissionRequestsArgs = { code: v.string() };

export async function listGuestAdmissionRequests(
	ctx: QueryCtx,
	args: ObjectType<typeof listGuestAdmissionRequestsArgs>,
) {
	const room = await getRoomByCode(ctx, normalizeRoomCode(args.code));
	if (!room) throw new ConvexError("Room not found");
	await requireHostOrAdmin(ctx, room);
	const requests = await ctx.db
		.query("screenshareGuestAdmissionRequests")
		.withIndex("by_room_status", (q) =>
			q.eq("roomCode", room.code).eq("status", "pending"),
		)
		.order("asc")
		.take(100);
	const now = Date.now();
	return requests
		.filter((request) => request.expiresAt > now)
		.map((request) => ({
			id: request._id,
			inviteId: request.inviteId,
			displayName: request.displayName,
			createdAt: request.createdAt,
			expiresAt: request.expiresAt,
			status: request.status,
		}));
}

export const decideGuestAdmissionArgs = {
	code: v.string(),
	requestId: v.id("screenshareGuestAdmissionRequests"),
	approved: v.boolean(),
};

export async function decideGuestAdmission(
	ctx: MutationCtx,
	args: ObjectType<typeof decideGuestAdmissionArgs>,
) {
	const room = await getRoomByCode(ctx, normalizeRoomCode(args.code));
	if (!room) throw new ConvexError("Room not found");
	const actorId = await requireHostOrAdmin(ctx, room);
	await assertRateLimit(
		ctx,
		`guest-admission-decision:${await sha256(`${room.code}:${actorId}`)}`,
		120,
		60 * 60_000,
	);
	const request = await ctx.db.get(args.requestId);
	const now = Date.now();
	if (
		!request ||
		request.roomCode !== room.code ||
		request.status !== "pending"
	) {
		throw new ConvexError("Admission request is no longer pending");
	}
	const invite = await ctx.db.get(request.inviteId);
	const valid =
		room.status === "live" &&
		!room.isLocked &&
		request.expiresAt > now &&
		invite &&
		invite.roomCode === room.code &&
		invite.revokedAt === undefined &&
		invite.expiresAt > now &&
		invite.uses < invite.maxUses;
	const status =
		args.approved && valid ? "approved" : args.approved ? "expired" : "denied";
	await ctx.db.patch(request._id, {
		status,
		decidedAt: now,
		decidedBy: actorId,
	});
	await auditScreenshare(
		ctx,
		room.workspaceId,
		actorId,
		`guest_admission.${status}`,
		{
			roomCode: room.code,
			requestId: request._id,
			inviteId: request.inviteId,
		},
	);
	return { status };
}

export async function finalizeAnonymousAdmission(
	ctx: MutationCtx,
	args: { userId: Id<"users">; roomCode: string; requestSecret: string },
) {
	const user = await ctx.db.get(args.userId);
	if (
		!user?.isAnonymous ||
		user.anonymousInviteId ||
		user.anonymousInviteTokenHash
	) {
		return { allowed: false as const, reason: PUBLIC_FAILURE };
	}
	const found = await findAdmissionBySecret(
		ctx,
		args.roomCode,
		args.requestSecret,
	);
	if (!found) return { allowed: false as const, reason: PUBLIC_FAILURE };
	const { request } = found;
	const now = Date.now();
	const room = await getRoomByCode(ctx, request.roomCode);
	const invite = await ctx.db.get(request.inviteId);
	if (
		request.status !== "approved" ||
		request.boundUserId !== undefined ||
		request.expiresAt <= now ||
		!room ||
		room.status !== "live" ||
		room.isLocked ||
		!invite ||
		(invite.version ?? 1) !== 2 ||
		invite.roomCode !== room.code ||
		invite.revokedAt !== undefined ||
		invite.expiresAt <= now ||
		invite.uses >= invite.maxUses
	)
		return { allowed: false as const, reason: PUBLIC_FAILURE };

	await recordGuestAdmission(ctx, {
		workspaceId: room.workspaceId,
		actorId: args.userId,
		requestId: request._id,
		at: now,
	});
	await ctx.db.patch(invite._id, { uses: invite.uses + 1, lastUsedAt: now });
	await ctx.db.patch(request._id, {
		status: "consumed",
		consumedAt: now,
		boundUserId: args.userId,
	});
	await ctx.db.patch(args.userId, {
		name: request.displayName,
		anonymousInviteRoomCode: room.code,
		anonymousInviteExpiresAt: invite.expiresAt,
		anonymousInviteId: invite._id,
		anonymousAdmissionRequestId: request._id,
		anonymousInviteVersion: 2,
	});
	return {
		allowed: true as const,
		roomCode: room.code,
		displayName: request.displayName,
	};
}

export async function finalizeLegacyAnonymousInvite(
	ctx: MutationCtx,
	args: { userId: Id<"users">; roomCode: string; guestInviteToken: string },
) {
	const user = await ctx.db.get(args.userId);
	if (
		!user?.isAnonymous ||
		user.anonymousInviteId ||
		user.anonymousInviteTokenHash
	) {
		return { allowed: false as const, reason: PUBLIC_FAILURE };
	}
	const found = await findActiveInvite(
		ctx,
		args.roomCode,
		args.guestInviteToken,
	);
	if (!found || (found.invite.version ?? 1) !== 1)
		return { allowed: false as const, reason: PUBLIC_FAILURE };
	await assertRateLimit(
		ctx,
		`guest-legacy-bind:${await sha256(`${found.room.code}:${found.tokenHash}`)}`,
		8,
		10 * 60_000,
	);
	await incrementAnalytics(
		ctx,
		found.room.workspaceId,
		"guestAdmissions",
		1,
		found.now,
	);
	await markDailyActiveUser(
		ctx,
		found.room.workspaceId,
		args.userId,
		found.now,
	);
	await ctx.db.patch(found.invite._id, {
		uses: found.invite.uses + 1,
		lastUsedAt: found.now,
	});
	await ctx.db.patch(args.userId, {
		anonymousInviteRoomCode: found.room.code,
		anonymousInviteTokenHash: found.tokenHash,
		anonymousInviteExpiresAt: found.invite.expiresAt,
		anonymousInviteId: found.invite._id,
		anonymousInviteVersion: 1,
	});
	return { allowed: true as const, roomCode: found.room.code };
}

export async function validateAnonymousGuestInvite(
	ctx: MutationCtx,
	roomCode: string,
	guestInviteToken: string,
) {
	const found = await findActiveInvite(ctx, roomCode, guestInviteToken);
	if (!found || (found.invite.version ?? 1) !== 1) {
		return { allowed: false as const, reason: PUBLIC_FAILURE };
	}
	return {
		allowed: true as const,
		roomCode: found.room.code,
		tokenHash: found.tokenHash,
		expiresAt: found.invite.expiresAt,
		inviteId: found.invite._id,
		uses: found.invite.uses,
	};
}

export async function consumeAnonymousGuestInvite(
	ctx: MutationCtx,
	roomCode: string,
	guestInviteToken: string,
) {
	const validation = await validateAnonymousGuestInvite(
		ctx,
		roomCode,
		guestInviteToken,
	);
	if (!validation.allowed) return validation;
	const now = Date.now();
	const invite = await ctx.db.get(validation.inviteId);
	if (
		!invite ||
		invite.uses >= invite.maxUses ||
		invite.revokedAt !== undefined ||
		invite.expiresAt <= now
	) {
		return { allowed: false as const, reason: PUBLIC_FAILURE };
	}
	await ctx.db.patch(invite._id, { uses: invite.uses + 1, lastUsedAt: now });
	return {
		allowed: true as const,
		roomCode: validation.roomCode,
		tokenHash: validation.tokenHash,
		expiresAt: validation.expiresAt,
	};
}

export async function cleanupGuestInvitationData(ctx: MutationCtx) {
	const now = Date.now();
	const requests = await ctx.db
		.query("screenshareGuestAdmissionRequests")
		.withIndex("by_expiry", (q) => q.lt("expiresAt", now))
		.take(100);
	let expiredRequests = 0;
	let deletedRequests = 0;
	for (const request of requests) {
		if (request.status === "pending" || request.status === "approved") {
			await ctx.db.patch(request._id, { status: "expired", decidedAt: now });
			expiredRequests += 1;
		} else if (request.expiresAt < now - 24 * 60 * 60_000) {
			await ctx.db.delete(request._id);
			deletedRequests += 1;
		}
	}

	const invites = await ctx.db
		.query("screenshareGuestInvites")
		.withIndex("by_expiry", (q) => q.lt("expiresAt", now - 24 * 60 * 60_000))
		.take(100);
	let deletedInvites = 0;
	for (const invite of invites) {
		const boundUser = await ctx.db
			.query("users")
			.filter((q) => q.eq(q.field("anonymousInviteId"), invite._id))
			.first();
		const request = await ctx.db
			.query("screenshareGuestAdmissionRequests")
			.withIndex("by_invite_status", (q) =>
				q.eq("inviteId", invite._id).eq("status", "consumed"),
			)
			.first();
		if (!boundUser && !request) {
			await ctx.db.delete(invite._id);
			deletedInvites += 1;
		}
	}
	return { expiredRequests, deletedRequests, deletedInvites };
}
