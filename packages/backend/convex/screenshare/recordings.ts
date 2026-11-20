import { ConvexError, type ObjectType, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	auditScreenshare,
	getRoomByCode,
	requireHost,
	requireRoomParticipant,
} from "./lib";

export const LOCAL_RECORDING_HEARTBEAT_MS = 15_000;
export const LOCAL_RECORDING_LEASE_MS = 45_000;
const ACTIVE_STATES = new Set(["preparing", "recording", "paused", "stopping"]);
const RESOLUTIONS = new Set(["1080p", "720p", "360p"]);
const FPS = new Set([25, 30, 60]);
const TARGETS = new Set(["focused", "grid", "shared-browser"]);

export const localRecordingProfileFields = {
	resolution: v.string(),
	fps: v.number(),
	width: v.number(),
	height: v.number(),
	videoBitrateKbps: v.number(),
	audioIncluded: v.boolean(),
};
export const localRecordingProfileValidator = v.object(
	localRecordingProfileFields,
);

type RecordingProfile = ObjectType<typeof localRecordingProfileFields>;

function assertProfile(profile: RecordingProfile): void {
	if (!RESOLUTIONS.has(profile.resolution))
		throw new ConvexError("Invalid recording resolution");
	if (!FPS.has(profile.fps)) throw new ConvexError("Invalid recording fps");
	if (profile.fps === 60 && profile.resolution !== "360p") {
		throw new ConvexError(
			"60 FPS local recording is supported only at 360p in this release",
		);
	}
	const expected =
		profile.resolution === "1080p"
			? { width: 1920, height: 1080 }
			: profile.resolution === "720p"
				? { width: 1280, height: 720 }
				: { width: 640, height: 360 };
	if (profile.width !== expected.width || profile.height !== expected.height) {
		throw new ConvexError("Invalid recording dimensions");
	}
	if (
		!Number.isInteger(profile.videoBitrateKbps) ||
		profile.videoBitrateKbps < 400 ||
		profile.videoBitrateKbps > 20_000
	) {
		throw new ConvexError("Invalid recording bitrate");
	}
}

function isActive(
	recording: { state: string; leaseExpiresAt?: number },
	now: number,
): boolean {
	return (
		ACTIVE_STATES.has(recording.state) && (recording.leaseExpiresAt ?? 0) > now
	);
}

async function activeForRoom(ctx: QueryCtx, roomCode: string, now: number) {
	const candidates = await ctx.db
		.query("screenshareLocalRecordings")
		.withIndex("by_room_created", (q) => q.eq("roomCode", roomCode))
		.order("desc")
		.take(10);
	return candidates.find((recording) => isActive(recording, now)) ?? null;
}

async function requireHostRecording(
	ctx: MutationCtx,
	args: { code: string; recordingId: Id<"screenshareLocalRecordings"> },
) {
	const room = await getRoomByCode(ctx, args.code);
	if (!room) throw new ConvexError("Room not found");
	const hostId = await requireHost(ctx, room);
	const recording = await ctx.db.get(args.recordingId);
	if (
		!recording ||
		recording.roomCode !== args.code ||
		recording.hostId !== hostId ||
		recording.workspaceId !== room.workspaceId
	) {
		throw new ConvexError("Recording not found");
	}
	return { room, recording, hostId };
}

export const startLocalRecordingArgs = {
	code: v.string(),
	target: v.string(),
	profile: localRecordingProfileValidator,
};

export async function startLocalRecording(
	ctx: MutationCtx,
	args: ObjectType<typeof startLocalRecordingArgs>,
) {
	const room = await getRoomByCode(ctx, args.code);
	if (!room) throw new ConvexError("Room not found");
	const hostId = await requireHost(ctx, room);
	if (room.status !== "live") throw new ConvexError("Room is not live");
	if (!TARGETS.has(args.target))
		throw new ConvexError("Invalid recording target");
	assertProfile(args.profile);
	if (args.target === "shared-browser" && args.profile.audioIncluded) {
		throw new ConvexError("Shared Browser recording is video only");
	}
	const now = Date.now();
	const current = await activeForRoom(ctx, room.code, now);
	if (current)
		throw new ConvexError("A local recording is already active for this room");

	const stale = await ctx.db
		.query("screenshareLocalRecordings")
		.withIndex("by_room_created", (q) => q.eq("roomCode", room.code))
		.order("desc")
		.take(10);
	for (const recording of stale) {
		if (
			ACTIVE_STATES.has(recording.state) &&
			(recording.leaseExpiresAt ?? 0) <= now
		) {
			await ctx.db.patch(recording._id, {
				state: "failed",
				stoppedAt: now,
				failureCategory: "heartbeat_timeout",
				leaseExpiresAt: now,
			});
		}
	}

	const recordingId = await ctx.db.insert("screenshareLocalRecordings", {
		roomCode: room.code,
		workspaceId: room.workspaceId,
		hostId,
		target: args.target,
		profile: args.profile,
		state: "recording",
		createdAt: now,
		startedAt: now,
		heartbeatAt: now,
		leaseExpiresAt: now + LOCAL_RECORDING_LEASE_MS,
	});
	await auditScreenshare(ctx, room.workspaceId, hostId, "recording.start", {
		roomCode: room.code,
		recordingId,
		target: args.target,
		resolution: args.profile.resolution,
		fps: args.profile.fps,
		audioIncluded: args.profile.audioIncluded,
	});
	return { recordingId, heartbeatIntervalMs: LOCAL_RECORDING_HEARTBEAT_MS };
}

export const heartbeatLocalRecordingArgs = {
	code: v.string(),
	recordingId: v.id("screenshareLocalRecordings"),
};

export async function heartbeatLocalRecording(
	ctx: MutationCtx,
	args: ObjectType<typeof heartbeatLocalRecordingArgs>,
) {
	const { recording } = await requireHostRecording(ctx, args);
	const now = Date.now();
	if (!isActive(recording, now))
		throw new ConvexError("Recording lease is not active");
	await ctx.db.patch(recording._id, {
		heartbeatAt: now,
		leaseExpiresAt: now + LOCAL_RECORDING_LEASE_MS,
	});
	return { leaseExpiresAt: now + LOCAL_RECORDING_LEASE_MS };
}

export const setLocalRecordingPausedArgs = {
	code: v.string(),
	recordingId: v.id("screenshareLocalRecordings"),
	paused: v.boolean(),
};

export async function setLocalRecordingPaused(
	ctx: MutationCtx,
	args: ObjectType<typeof setLocalRecordingPausedArgs>,
) {
	const { room, recording, hostId } = await requireHostRecording(ctx, args);
	const now = Date.now();
	if (!isActive(recording, now))
		throw new ConvexError("Recording lease is not active");
	if (args.paused && recording.state === "paused") return true;
	if (!args.paused && recording.state === "recording") return true;
	if (!new Set(["recording", "paused"]).has(recording.state)) {
		throw new ConvexError("Recording cannot change pause state");
	}
	await ctx.db.patch(
		recording._id,
		args.paused
			? {
					state: "paused",
					pausedAt: now,
					heartbeatAt: now,
					leaseExpiresAt: now + LOCAL_RECORDING_LEASE_MS,
				}
			: {
					state: "recording",
					resumedAt: now,
					heartbeatAt: now,
					leaseExpiresAt: now + LOCAL_RECORDING_LEASE_MS,
				},
	);
	await auditScreenshare(
		ctx,
		room.workspaceId,
		hostId,
		args.paused ? "recording.pause" : "recording.resume",
		{ roomCode: room.code, recordingId: recording._id },
	);
	return true;
}

export const finishLocalRecordingArgs = {
	code: v.string(),
	recordingId: v.id("screenshareLocalRecordings"),
	failureCategory: v.optional(v.string()),
};

export async function finishLocalRecording(
	ctx: MutationCtx,
	args: ObjectType<typeof finishLocalRecordingArgs>,
) {
	const { room, recording, hostId } = await requireHostRecording(ctx, args);
	if (new Set(["stopped", "failed"]).has(recording.state)) return true;
	const now = Date.now();
	const failed = args.failureCategory !== undefined;
	const failureCategory = args.failureCategory?.trim().slice(0, 64);
	if (failed && !failureCategory)
		throw new ConvexError("Invalid failure category");
	await ctx.db.patch(recording._id, {
		state: failed ? "failed" : "stopped",
		stoppedAt: now,
		heartbeatAt: now,
		leaseExpiresAt: now,
		failureCategory,
	});
	await auditScreenshare(
		ctx,
		room.workspaceId,
		hostId,
		failed ? "recording.fail" : "recording.stop",
		{
			roomCode: room.code,
			recordingId: recording._id,
			failureCategory: failed ? failureCategory : undefined,
		},
	);
	return true;
}

export const getActiveLocalRecordingArgs = { code: v.string() };

export async function getActiveLocalRecording(
	ctx: QueryCtx,
	args: ObjectType<typeof getActiveLocalRecordingArgs>,
) {
	const room = await getRoomByCode(ctx, args.code);
	if (!room || room.status !== "live") return null;
	await requireRoomParticipant(ctx, room.code, room.workspaceId);
	const recording = await activeForRoom(ctx, room.code, Date.now());
	if (!recording) return null;
	return {
		target: recording.target,
		profile: recording.profile,
		state: recording.state,
		startedAt: recording.startedAt,
	};
}

export async function stopRoomLocalRecordings(
	ctx: MutationCtx,
	roomCode: string,
	now = Date.now(),
): Promise<number> {
	const recordings = await ctx.db
		.query("screenshareLocalRecordings")
		.withIndex("by_room_created", (q) => q.eq("roomCode", roomCode))
		.order("desc")
		.take(20);
	let stopped = 0;
	for (const recording of recordings) {
		if (!ACTIVE_STATES.has(recording.state)) continue;
		await ctx.db.patch(recording._id, {
			state: "stopped",
			stoppedAt: now,
			leaseExpiresAt: now,
		});
		stopped += 1;
	}
	return stopped;
}

export async function cleanupLocalRecordings(ctx: MutationCtx) {
	const now = Date.now();
	const active = await ctx.db
		.query("screenshareLocalRecordings")
		.withIndex("by_state_lease")
		.filter((q) => q.lt(q.field("leaseExpiresAt"), now))
		.take(200);
	let failed = 0;
	for (const recording of active) {
		if (!ACTIVE_STATES.has(recording.state)) continue;
		await ctx.db.patch(recording._id, {
			state: "failed",
			stoppedAt: now,
			failureCategory: "heartbeat_timeout",
			leaseExpiresAt: now,
		});
		failed += 1;
	}
	return { checked: active.length, failed };
}
