import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import {
	type MutationCtx,
	type QueryCtx,
	internalMutation,
} from "../_generated/server";
import {
	recordParticipantJoin,
	recordRoomCreated,
	recordRoomEnded,
} from "../analytics";
import { revokeRoomSharedBrowsers } from "../sharedBrowser";
import { revokeRoomAnnotationAccess } from "./annotations";
import { revokeGuestInvites } from "./guestInvites";
import {
	assertRateLimit,
	auditScreenshare,
	displayName,
	generateRoomCode,
	getRoomByCode,
	requireAuth,
	requireHost,
	requireHostOrAdmin,
	requireRoomParticipant,
	requireScreenshareMember,
	sanitizeName,
} from "./lib";
import { enqueueLiveKitParticipantOperation } from "./livekit_participant";
import { stopRoomLocalRecordings } from "./recordings";

// Room lifecycle: create, read, update settings, end, list. The only module
// that writes to `screenshareRooms`. Handlers are exported as plain functions
// and wired into `query`/`mutation` in `screenshare.ts`.

const RESOLUTIONS = new Set(["4K", "1440p", "1080p", "720p", "360p"]);
const CREATE_UPDATE_FPS = new Set([25, 30, 60]);
const CODECS = new Set(["AV1", "VP9", "H.264"]);
const MIN_BITRATE_KBPS = 400;
const MAX_BITRATE_KBPS = 25_000;

export const createRoomArgs = {
	workspaceId: v.id("workspaces"),
	hostName: v.optional(v.string()),
	title: v.optional(v.string()),
	resolution: v.optional(v.string()),
	fps: v.optional(v.number()),
	bitrateKbps: v.optional(v.number()),
	codec: v.optional(v.string()),
	audioEnabled: v.optional(v.boolean()),
	allowGuestSharing: v.optional(v.boolean()),
};

export async function createRoom(
	ctx: MutationCtx,
	args: ObjectType<typeof createRoomArgs>,
) {
	const userId = await requireScreenshareMember(ctx, args.workspaceId);
	const user = await ctx.db.get(userId);
	const code = generateRoomCode();
	const now = Date.now();

	const resolution = args.resolution ?? "1080p";
	const codec = args.codec ?? "H.264";
	if (!RESOLUTIONS.has(resolution)) throw new ConvexError("Invalid resolution");
	if (!CODECS.has(codec)) throw new ConvexError("Invalid codec");
	if (args.fps !== undefined && !CREATE_UPDATE_FPS.has(args.fps)) {
		throw new ConvexError("Invalid fps");
	}
	if (
		args.bitrateKbps !== undefined &&
		(args.bitrateKbps < MIN_BITRATE_KBPS || args.bitrateKbps > MAX_BITRATE_KBPS)
	) {
		throw new ConvexError("Invalid bitrate");
	}

	// Rate limit room creation per user (max 10 per hour)
	await assertRateLimit(ctx, `room_create:${userId}`, 10, 3600_000);

	// Anonymous host restrictions: prevent resource exhaustion & room spamming
	if (user?.isAnonymous) {
		await assertRateLimit(ctx, `anon_room_create:${userId}`, 3, 3600_000);
		const activeRooms = await ctx.db
			.query("screenshareRooms")
			.withIndex("by_status", (q) => q.eq("status", "live"))
			.filter((q) => q.eq(q.field("hostId"), userId))
			.collect();
		if (activeRooms.length >= 1) {
			throw new ConvexError(
				"Anonymous users are limited to 1 active room at a time. Please end your existing room before creating a new one.",
			);
		}
	}

	const cleanHostName =
		sanitizeName(args.hostName ?? "") || displayName(user) || "Host";

	const roomId = await ctx.db.insert("screenshareRooms", {
		code,
		workspaceId: args.workspaceId,
		title: sanitizeName(args.title ?? "") || "Screenshare Session",
		hostId: userId,
		hostName: cleanHostName,
		status: "live",
		resolution,
		fps: args.fps ?? 60,
		bitrateKbps: args.bitrateKbps ?? 8_000,
		codec,
		audioEnabled: args.audioEnabled ?? true,
		allowGuestSharing: args.allowGuestSharing ?? true,
		startedAt: now,
	});

	// The host is a room participant too (targetable by WebRTC signals).
	await ctx.db.insert("screenshareViewers", {
		roomCode: code,
		viewerId: userId,
		name: `${cleanHostName} (Host)`,
		role: "host",
		lastPingAt: now,
	});

	const createdRoom = await ctx.db.get(roomId);
	if (createdRoom) await recordRoomCreated(ctx, createdRoom, userId, now);
	const hostViewer = await ctx.db
		.query("screenshareViewers")
		.withIndex("by_room_viewer", (q) =>
			q.eq("roomCode", code).eq("viewerId", userId),
		)
		.unique();
	if (hostViewer) {
		await recordParticipantJoin(ctx, {
			workspaceId: args.workspaceId,
			actorId: userId,
			viewerId: hostViewer._id,
			at: now,
		});
	}

	await auditScreenshare(ctx, args.workspaceId, userId, "room.create", {
		roomId,
		code,
	});

	return { roomId, code };
}

export const getRoomArgs = { code: v.string() };

export async function getRoom(
	ctx: QueryCtx,
	args: ObjectType<typeof getRoomArgs>,
) {
	await requireAuth(ctx);
	const room = await getRoomByCode(ctx, args.code);
	if (!room) return null;
	// A room participant (member or joined guest) may read the room so guests can
	// discover the host's real userId for WebRTC peer targeting.
	await requireRoomParticipant(ctx, args.code, room.workspaceId);
	return room;
}

export const listActiveRoomsArgs = { workspaceId: v.id("workspaces") };

export async function listActiveRooms(
	ctx: QueryCtx,
	args: ObjectType<typeof listActiveRoomsArgs>,
) {
	await requireScreenshareMember(ctx, args.workspaceId);
	return await ctx.db
		.query("screenshareRooms")
		.withIndex("by_workspace_status", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("status", "live"),
		)
		.order("desc")
		.take(20);
}

export const updateRoomSettingsArgs = {
	code: v.string(),
	resolution: v.optional(v.string()),
	fps: v.optional(v.number()),
	bitrateKbps: v.optional(v.number()),
	codec: v.optional(v.string()),
	audioEnabled: v.optional(v.boolean()),
	allowGuestSharing: v.optional(v.boolean()),
};

export async function updateRoomSettings(
	ctx: MutationCtx,
	args: ObjectType<typeof updateRoomSettingsArgs>,
) {
	await requireAuth(ctx);
	const room = await getRoomByCode(ctx, args.code);
	if (!room) throw new ConvexError("Room not found");
	await requireHost(ctx, room);

	const updates: Partial<{
		resolution: string;
		fps: number;
		bitrateKbps: number;
		codec: string;
		audioEnabled: boolean;
	}> = {};
	if (args.resolution !== undefined) {
		if (!RESOLUTIONS.has(args.resolution))
			throw new ConvexError("Invalid resolution");
		updates.resolution = args.resolution;
	}
	if (args.fps !== undefined) {
		// Stored legacy 120 FPS rooms remain readable through existing queries, but
		// create/update cannot write 120 again.
		if (!CREATE_UPDATE_FPS.has(args.fps)) {
			throw new ConvexError("Invalid fps");
		}
		updates.fps = args.fps;
	}
	if (args.bitrateKbps !== undefined) {
		if (
			args.bitrateKbps < MIN_BITRATE_KBPS ||
			args.bitrateKbps > MAX_BITRATE_KBPS
		) {
			throw new ConvexError("Invalid bitrate");
		}
		updates.bitrateKbps = args.bitrateKbps;
	}
	if (args.codec !== undefined) {
		if (!CODECS.has(args.codec)) throw new ConvexError("Invalid codec");
		updates.codec = args.codec;
	}
	if (args.audioEnabled !== undefined) updates.audioEnabled = args.audioEnabled;

	await ctx.db.patch(room._id, updates);
	return true;
}

export const endRoomArgs = { code: v.string() };

export async function endRoom(
	ctx: MutationCtx,
	args: ObjectType<typeof endRoomArgs>,
) {
	await requireAuth(ctx);
	const room = await getRoomByCode(ctx, args.code);
	if (!room) return true;
	const actorId = await requireHostOrAdmin(ctx, room);

	if (room.status === "ended") return true;
	const endedAt = Date.now();
	await recordRoomEnded(ctx, room, endedAt);
	await ctx.db.patch(room._id, {
		status: "ended",
		endedAt,
	});
	await stopRoomLocalRecordings(ctx, args.code, endedAt);
	await revokeRoomSharedBrowsers(ctx, args.code, actorId);
	await revokeRoomAnnotationAccess(ctx, args.code);
	await revokeGuestInvites(ctx, room.code);
	await auditScreenshare(ctx, room.workspaceId, actorId, "room.end", {
		roomCode: args.code,
	});
	return true;
}

export const setRoomLockArgs = {
	code: v.string(),
	locked: v.boolean(),
};

export async function setRoomLock(
	ctx: MutationCtx,
	args: ObjectType<typeof setRoomLockArgs>,
) {
	await requireAuth(ctx);
	const room = await getRoomByCode(ctx, args.code);
	if (!room) throw new ConvexError("Room not found");
	const actorId = await requireHostOrAdmin(ctx, room);

	await ctx.db.patch(room._id, {
		isLocked: args.locked,
	});
	if (args.locked) await revokeGuestInvites(ctx, room.code);

	await auditScreenshare(
		ctx,
		room.workspaceId,
		actorId,
		args.locked ? "room.lock" : "room.unlock",
		{ roomCode: args.code },
	);

	return true;
}

export const setRoomLimitsArgs = {
	code: v.string(),
	maxViewers: v.optional(v.number()),
	maxSharers: v.optional(v.number()),
};

export async function setRoomLimits(
	ctx: MutationCtx,
	args: ObjectType<typeof setRoomLimitsArgs>,
) {
	await requireAuth(ctx);
	const room = await getRoomByCode(ctx, args.code);
	if (!room) throw new ConvexError("Room not found");
	const actorId = await requireHost(ctx, room);

	const updates: Partial<{ maxViewers: number; maxSharers: number }> = {};
	if (args.maxViewers !== undefined) {
		if (args.maxViewers < 2 || args.maxViewers > 100) {
			throw new ConvexError("maxViewers must be between 2 and 100");
		}
		updates.maxViewers = args.maxViewers;
	}
	if (args.maxSharers !== undefined) {
		if (args.maxSharers < 1 || args.maxSharers > 50) {
			throw new ConvexError("maxSharers must be between 1 and 50");
		}
		updates.maxSharers = args.maxSharers;
	}

	await ctx.db.patch(room._id, updates);

	await auditScreenshare(ctx, room.workspaceId, actorId, "room.set_limits", {
		roomCode: args.code,
		maxViewers: updates.maxViewers,
		maxSharers: updates.maxSharers,
	});

	return true;
}

export const forceEndRoomArgs = {
	code: v.string(),
	reason: v.optional(v.string()),
};

export async function forceEndRoom(
	ctx: MutationCtx,
	args: ObjectType<typeof forceEndRoomArgs>,
) {
	await requireAuth(ctx);
	const room = await getRoomByCode(ctx, args.code);
	if (!room) return true;
	const actorId = await requireHostOrAdmin(ctx, room);

	if (room.status === "ended") return true;
	const endedAt = Date.now();
	await recordRoomEnded(ctx, room, endedAt);
	await ctx.db.patch(room._id, {
		status: "ended",
		endedAt,
	});
	await stopRoomLocalRecordings(ctx, args.code, endedAt);
	await revokeRoomSharedBrowsers(ctx, args.code, actorId);
	await revokeRoomAnnotationAccess(ctx, args.code);
	await revokeGuestInvites(ctx, room.code);

	await auditScreenshare(ctx, room.workspaceId, actorId, "room.force_end", {
		roomCode: args.code,
		reason: args.reason ?? "Administrative force-close",
	});

	return true;
}

export const listAllActiveRoomsWithDetailsArgs = {
	workspaceId: v.id("workspaces"),
};

export async function listAllActiveRoomsWithDetails(
	ctx: QueryCtx,
	args: ObjectType<typeof listAllActiveRoomsWithDetailsArgs>,
) {
	await requireScreenshareMember(ctx, args.workspaceId);
	const now = Date.now();

	const rooms = await ctx.db
		.query("screenshareRooms")
		.withIndex("by_workspace_status", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("status", "live"),
		)
		.take(50);

	const detailedRooms = await Promise.all(
		rooms.map(async (r) => {
			const activeViewers = await ctx.db
				.query("screenshareViewers")
				.withIndex("by_room_ping", (q) =>
					q.eq("roomCode", r.code).gte("lastPingAt", now - 45_000),
				)
				.collect();

			const validViewers = activeViewers.filter((v) => v.status !== "kicked");
			const sharers = validViewers.filter((v) => v.isSharing);

			return {
				...r,
				viewerCount: validViewers.length,
				sharerCount: sharers.length,
				viewers: validViewers.map((v) => ({
					id: v._id,
					viewerId: v.viewerId,
					name: v.name,
					role: v.role,
					isSharing: Boolean(v.isSharing),
					lastPingAt: v.lastPingAt,
				})),
			};
		}),
	);

	return detailedRooms;
}

export async function autoEndStaleRoomsHandler(ctx: MutationCtx) {
	const now = Date.now();
	const STALE_THRESHOLD_MS = 120_000; // 2 minutes

	const liveRooms = await ctx.db
		.query("screenshareRooms")
		.withIndex("by_status", (q) => q.eq("status", "live"))
		.take(200);

	let endedCount = 0;

	for (const room of liveRooms) {
		const hostViewer = await ctx.db
			.query("screenshareViewers")
			.withIndex("by_room_viewer", (q) =>
				q.eq("roomCode", room.code).eq("viewerId", room.hostId),
			)
			.first();

		const isStale =
			!hostViewer ||
			!hostViewer.lastPingAt ||
			hostViewer.lastPingAt < now - STALE_THRESHOLD_MS;

		if (isStale) {
			await recordRoomEnded(ctx, room, now);
			await ctx.db.patch(room._id, {
				status: "ended",
				endedAt: now,
			});
			await stopRoomLocalRecordings(ctx, room.code, now);
			await revokeRoomSharedBrowsers(ctx, room.code, room.hostId);
			await revokeRoomAnnotationAccess(ctx, room.code);
			await revokeGuestInvites(ctx, room.code);

			await auditScreenshare(
				ctx,
				room.workspaceId,
				room.hostId,
				"room.auto_end",
				{
					roomId: room._id,
					roomCode: room.code,
					reason: hostViewer ? "host_heartbeat_timeout" : "host_viewer_missing",
					lastPingAt: hostViewer?.lastPingAt,
				},
			);
			endedCount++;
		}
	}

	return { liveRoomsChecked: liveRooms.length, endedCount };
}

export const autoEndStaleRooms = internalMutation({
	args: {},
	handler: autoEndStaleRoomsHandler,
});

export const setAllowGuestSharingArgs = {
	code: v.string(),
	allowed: v.boolean(),
};

export async function setAllowGuestSharing(
	ctx: MutationCtx,
	args: ObjectType<typeof setAllowGuestSharingArgs>,
) {
	await requireAuth(ctx);
	const room = await getRoomByCode(ctx, args.code);
	if (!room) throw new ConvexError("Room not found");
	const actorId = await requireHost(ctx, room);

	await ctx.db.patch(room._id, {
		allowGuestSharing: args.allowed,
	});

	if (!args.allowed) {
		const viewers = await ctx.db
			.query("screenshareViewers")
			.withIndex("by_room_sharing", (q) =>
				q.eq("roomCode", args.code).eq("isSharing", true),
			)
			.collect();
		for (const viewer of viewers) {
			if (
				viewer.viewerId === room.hostId ||
				viewer.sharerApproved ||
				viewer.status === "kicked"
			)
				continue;
			await ctx.db.patch(viewer._id, { isSharing: false, role: "viewer" });
			await enqueueLiveKitParticipantOperation(ctx, {
				operationKind: "downgrade",
				roomCode: args.code,
				identity: String(viewer.viewerId),
				reason: "guest-sharing-disabled",
			});
		}
	}

	await auditScreenshare(
		ctx,
		room.workspaceId,
		actorId,
		"room.set_allow_guest_sharing",
		{
			roomCode: args.code,
			allowed: args.allowed,
		},
	);

	return true;
}

export const approveSharerArgs = {
	code: v.string(),
	viewerId: v.id("users"),
	approved: v.boolean(),
};

export async function approveSharer(
	ctx: MutationCtx,
	args: ObjectType<typeof approveSharerArgs>,
) {
	await requireAuth(ctx);
	const room = await getRoomByCode(ctx, args.code);
	if (!room) throw new ConvexError("Room not found");
	const actorId = await requireHost(ctx, room);

	const viewer = await ctx.db
		.query("screenshareViewers")
		.withIndex("by_room_viewer", (q) =>
			q.eq("roomCode", args.code).eq("viewerId", args.viewerId),
		)
		.first();
	if (!viewer) throw new ConvexError("Viewer not found in room");

	await ctx.db.patch(viewer._id, {
		sharerApproved: args.approved,
		sharerApprovedBy: args.approved ? actorId : undefined,
		sharerApprovedAt: args.approved ? Date.now() : undefined,
		...(!args.approved ? { isSharing: false, role: "viewer" } : {}),
	});

	if (!args.approved) {
		await enqueueLiveKitParticipantOperation(ctx, {
			operationKind: "downgrade",
			roomCode: args.code,
			identity: String(args.viewerId),
			reason: "sharer-approval-revoked",
		});
	}

	await auditScreenshare(
		ctx,
		room.workspaceId,
		actorId,
		"room.approve_sharer",
		{
			roomCode: args.code,
			viewerId: args.viewerId,
			approved: args.approved,
		},
	);

	return true;
}
