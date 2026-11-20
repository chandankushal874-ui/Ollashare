import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { getActiveUserId as getAuthUserId } from "./activeSession";

export const ANALYTICS_RETENTION_DAYS = 90;
export const SECURITY_EVENT_RETENTION_DAYS = 30;
export const MAX_SECURITY_RESULTS = 100;
export const ANALYTICS_CLEANUP_BATCH = 500;
export const ANALYTICS_ACTOR_CLEANUP_BATCH = 1000;
export const ANALYTICS_BACKFILL_BATCH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ANALYTICS_METRICS = [
	"rooms",
	"roomDurationMs",
	"participantJoins",
	"guestAdmissions",
	"screenShareStarts",
	"invitationFailures",
	"roomFailures",
	"clientFailures",
	"securityEvents",
] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export const SECURITY_EVENTS = [
	"access_denied",
	"participant_removed",
	"room_locked",
	"invitation_failed",
	"room_failure",
	"client_failure",
] as const;
export type AnalyticsSecurityEvent = (typeof SECURITY_EVENTS)[number];

export const SECURITY_REASONS = [
	"room_locked",
	"participant_banned",
	"invitation_invalid",
	"authentication_failed",
	"screenshare_failed",
	"shared_browser_failed",
	"room_end_failed",
	"stale_host",
	"policy_enforced",
	"unknown",
] as const;
export type AnalyticsSecurityReason = (typeof SECURITY_REASONS)[number];

export const SECURITY_OUTCOMES = ["denied", "failed", "enforced"] as const;
export type AnalyticsSecurityOutcome = (typeof SECURITY_OUTCOMES)[number];

export const SECURITY_ACTOR_KINDS = [
	"member",
	"guest",
	"system",
	"unknown",
] as const;
export type AnalyticsActorKind = (typeof SECURITY_ACTOR_KINDS)[number];

export function utcDayStart(timestamp: number): number {
	const date = new Date(timestamp);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function emptyDaily(
	workspaceId: Id<"workspaces">,
	dayStart: number,
	now: number,
) {
	return {
		workspaceId,
		dayStart,
		rooms: 0,
		roomDurationMs: 0,
		participantJoins: 0,
		guestAdmissions: 0,
		screenShareStarts: 0,
		activeUsers: 0,
		invitationFailures: 0,
		roomFailures: 0,
		clientFailures: 0,
		securityEvents: 0,
		createdAt: now,
		updatedAt: now,
	};
}

async function getDaily(
	ctx: QueryCtx,
	workspaceId: Id<"workspaces">,
	dayStart: number,
) {
	return ctx.db
		.query("workspaceAnalyticsDaily")
		.withIndex("by_workspace_day", (q) =>
			q.eq("workspaceId", workspaceId).eq("dayStart", dayStart),
		)
		.unique();
}

export async function incrementAnalytics(
	ctx: MutationCtx,
	workspaceId: Id<"workspaces">,
	metric: AnalyticsMetric,
	amount = 1,
	at = Date.now(),
) {
	if (!Number.isFinite(amount) || amount < 0)
		throw new ConvexError("Invalid analytics amount");
	const dayStart = utcDayStart(at);
	const current = await getDaily(ctx, workspaceId, dayStart);
	if (current) {
		await ctx.db.patch(current._id, {
			[metric]: current[metric] + amount,
			updatedAt: at,
		});
		return current._id;
	}
	return ctx.db.insert("workspaceAnalyticsDaily", {
		...emptyDaily(workspaceId, dayStart, at),
		[metric]: amount,
	});
}

async function hmacActorKey(
	workspaceId: Id<"workspaces">,
	actorId: Id<"users">,
	dayStart: number,
): Promise<string | null> {
	const pepper = process.env.ANALYTICS_ACTOR_PEPPER;
	if (!pepper || pepper.length < 32) return null;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(pepper),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signature = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(`${workspaceId}:${dayStart}:${actorId}`),
		);
		return Array.from(new Uint8Array(signature), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	} catch {
		return null;
	}
}

export async function markDailyActiveUser(
	ctx: MutationCtx,
	workspaceId: Id<"workspaces">,
	actorId: Id<"users">,
	at = Date.now(),
): Promise<boolean> {
	const dayStart = utcDayStart(at);
	const actorKey = await hmacActorKey(workspaceId, actorId, dayStart);
	if (!actorKey) return false;
	const existing = await ctx.db
		.query("workspaceAnalyticsActors")
		.withIndex("by_workspace_day_actor", (q) =>
			q
				.eq("workspaceId", workspaceId)
				.eq("dayStart", dayStart)
				.eq("actorKey", actorKey),
		)
		.unique();
	if (existing) return false;
	await ctx.db.insert("workspaceAnalyticsActors", {
		workspaceId,
		dayStart,
		actorKey,
		createdAt: at,
	});
	const daily = await getDaily(ctx, workspaceId, dayStart);
	if (daily) {
		await ctx.db.patch(daily._id, {
			activeUsers: daily.activeUsers + 1,
			updatedAt: at,
		});
	} else {
		await ctx.db.insert("workspaceAnalyticsDaily", {
			...emptyDaily(workspaceId, dayStart, at),
			activeUsers: 1,
		});
	}
	return true;
}

export async function recordSecurityEvent(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		event: AnalyticsSecurityEvent;
		reason: AnalyticsSecurityReason;
		outcome: AnalyticsSecurityOutcome;
		actorKind: AnalyticsActorKind;
		at?: number;
	},
) {
	const at = args.at ?? Date.now();
	await ctx.db.insert("workspaceAnalyticsSecurityEvents", {
		workspaceId: args.workspaceId,
		event: args.event,
		reason: args.reason,
		outcome: args.outcome,
		actorKind: args.actorKind,
		at,
	});
	await incrementAnalytics(ctx, args.workspaceId, "securityEvents", 1, at);
}

export async function recordRoomCreated(
	ctx: MutationCtx,
	room: Doc<"screenshareRooms">,
	actorId: Id<"users">,
	at = room.startedAt,
) {
	if (room.analyticsCreatedRecordedAt !== undefined) return false;
	await incrementAnalytics(ctx, room.workspaceId, "rooms", 1, at);
	await markDailyActiveUser(ctx, room.workspaceId, actorId, at);
	await ctx.db.patch(room._id, { analyticsCreatedRecordedAt: at });
	return true;
}

export async function recordRoomEnded(
	ctx: MutationCtx,
	room: Doc<"screenshareRooms">,
	endedAt: number,
) {
	if (room.analyticsDurationRecordedAt !== undefined) return false;
	const durationMs = Math.max(0, endedAt - room.startedAt);
	await incrementAnalytics(
		ctx,
		room.workspaceId,
		"roomDurationMs",
		durationMs,
		endedAt,
	);
	await ctx.db.patch(room._id, { analyticsDurationRecordedAt: endedAt });
	return true;
}

export async function recordParticipantJoin(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		actorId: Id<"users">;
		viewerId: Id<"screenshareViewers">;
		at?: number;
	},
) {
	const viewer = await ctx.db.get(args.viewerId);
	if (!viewer || viewer.analyticsJoinRecordedAt !== undefined) return false;
	const at = args.at ?? Date.now();
	await incrementAnalytics(ctx, args.workspaceId, "participantJoins", 1, at);
	await markDailyActiveUser(ctx, args.workspaceId, args.actorId, at);
	await ctx.db.patch(viewer._id, { analyticsJoinRecordedAt: at });
	return true;
}

export async function recordGuestAdmission(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		actorId: Id<"users">;
		requestId: Id<"screenshareGuestAdmissionRequests">;
		at?: number;
	},
) {
	const request = await ctx.db.get(args.requestId);
	if (!request || request.analyticsAdmissionRecordedAt !== undefined)
		return false;
	const at = args.at ?? Date.now();
	await incrementAnalytics(ctx, args.workspaceId, "guestAdmissions", 1, at);
	await markDailyActiveUser(ctx, args.workspaceId, args.actorId, at);
	await ctx.db.patch(request._id, { analyticsAdmissionRecordedAt: at });
	return true;
}

export async function recordScreenShareTransition(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		actorId: Id<"users">;
		wasSharing: boolean;
		isSharing: boolean;
		at?: number;
	},
) {
	if (args.wasSharing || !args.isSharing) return false;
	const at = args.at ?? Date.now();
	await incrementAnalytics(ctx, args.workspaceId, "screenShareStarts", 1, at);
	await markDailyActiveUser(ctx, args.workspaceId, args.actorId, at);
	return true;
}

async function requireAnalyticsAdmin(
	ctx: QueryCtx,
	workspaceId: Id<"workspaces">,
) {
	const userId = await getAuthUserId(ctx);
	if (!userId) throw new ConvexError("Not authenticated");
	const membership = await ctx.db
		.query("members")
		.withIndex("by_user_workspace", (q) =>
			q.eq("userId", userId).eq("workspaceId", workspaceId),
		)
		.unique();
	if (
		!membership ||
		(membership.role !== "owner" && membership.role !== "admin")
	) {
		throw new ConvexError("Forbidden");
	}
	return userId;
}

function validateDays(days: number) {
	if (
		!Number.isSafeInteger(days) ||
		days < 1 ||
		days > ANALYTICS_RETENTION_DAYS
	) {
		throw new ConvexError("Analytics range must be between 1 and 90 days");
	}
}

export const getWorkspaceAnalytics = query({
	args: { workspaceId: v.id("workspaces"), days: v.number() },
	handler: async (ctx, { workspaceId, days }) => {
		await requireAnalyticsAdmin(ctx, workspaceId);
		validateDays(days);
		const today = utcDayStart(Date.now());
		const start = today - (days - 1) * DAY_MS;
		const stored = await ctx.db
			.query("workspaceAnalyticsDaily")
			.withIndex("by_workspace_day", (q) =>
				q
					.eq("workspaceId", workspaceId)
					.gte("dayStart", start)
					.lte("dayStart", today),
			)
			.collect();
		const byDay = new Map(stored.map((row) => [row.dayStart, row]));
		const daily = Array.from({ length: days }, (_, index) => {
			const dayStart = start + index * DAY_MS;
			const row = byDay.get(dayStart);
			return {
				dayStart,
				rooms: row?.rooms ?? 0,
				roomDurationMs: row?.roomDurationMs ?? 0,
				participantJoins: row?.participantJoins ?? 0,
				guestAdmissions: row?.guestAdmissions ?? 0,
				screenShareStarts: row?.screenShareStarts ?? 0,
				activeUsers: row?.activeUsers ?? 0,
				invitationFailures: row?.invitationFailures ?? 0,
				roomFailures: row?.roomFailures ?? 0,
				clientFailures: row?.clientFailures ?? 0,
				securityEvents: row?.securityEvents ?? 0,
			};
		});
		const totals = daily.reduce(
			(sum, row) => ({
				rooms: sum.rooms + row.rooms,
				roomDurationMs: sum.roomDurationMs + row.roomDurationMs,
				participantJoins: sum.participantJoins + row.participantJoins,
				guestAdmissions: sum.guestAdmissions + row.guestAdmissions,
				screenShareStarts: sum.screenShareStarts + row.screenShareStarts,
				activeUsers: sum.activeUsers + row.activeUsers,
				invitationFailures: sum.invitationFailures + row.invitationFailures,
				roomFailures: sum.roomFailures + row.roomFailures,
				clientFailures: sum.clientFailures + row.clientFailures,
				securityEvents: sum.securityEvents + row.securityEvents,
			}),
			{
				rooms: 0,
				roomDurationMs: 0,
				participantJoins: 0,
				guestAdmissions: 0,
				screenShareStarts: 0,
				activeUsers: 0,
				invitationFailures: 0,
				roomFailures: 0,
				clientFailures: 0,
				securityEvents: 0,
			},
		);
		const first = await ctx.db
			.query("workspaceAnalyticsDaily")
			.withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId))
			.order("asc")
			.first();
		return {
			days,
			start,
			end: today + DAY_MS - 1,
			collectionStartedAt: first?.dayStart ?? null,
			totals: {
				...totals,
				averageRoomDurationMs:
					totals.rooms > 0
						? Math.round(totals.roomDurationMs / totals.rooms)
						: 0,
				failures:
					totals.invitationFailures +
					totals.roomFailures +
					totals.clientFailures,
			},
			daily,
		};
	},
});

export const listSecurityEvents = query({
	args: {
		workspaceId: v.id("workspaces"),
		days: v.number(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, { workspaceId, days, limit }) => {
		await requireAnalyticsAdmin(ctx, workspaceId);
		if (
			!Number.isSafeInteger(days) ||
			days < 1 ||
			days > SECURITY_EVENT_RETENTION_DAYS
		) {
			throw new ConvexError(
				"Security event range must be between 1 and 30 days",
			);
		}
		const boundedLimit = limit ?? 50;
		if (
			!Number.isSafeInteger(boundedLimit) ||
			boundedLimit < 1 ||
			boundedLimit > MAX_SECURITY_RESULTS
		) {
			throw new ConvexError("Security event limit must be between 1 and 100");
		}
		const start = Date.now() - days * DAY_MS;
		const events = await ctx.db
			.query("workspaceAnalyticsSecurityEvents")
			.withIndex("by_workspace_time", (q) =>
				q.eq("workspaceId", workspaceId).gte("at", start),
			)
			.order("desc")
			.take(boundedLimit);
		return events.map(({ _id, event, reason, outcome, actorKind, at }) => ({
			id: _id,
			event,
			reason,
			outcome,
			actorKind,
			at,
		}));
	},
});

export async function cleanupAnalyticsHandler(
	ctx: MutationCtx,
	now = Date.now(),
) {
	const aggregateCutoff = utcDayStart(now) - ANALYTICS_RETENTION_DAYS * DAY_MS;
	const securityCutoff = now - SECURITY_EVENT_RETENTION_DAYS * DAY_MS;
	const aggregates = await ctx.db
		.query("workspaceAnalyticsDaily")
		.withIndex("by_day", (q) => q.lt("dayStart", aggregateCutoff))
		.take(ANALYTICS_CLEANUP_BATCH);
	const actors = await ctx.db
		.query("workspaceAnalyticsActors")
		.withIndex("by_day", (q) => q.lt("dayStart", aggregateCutoff))
		.take(ANALYTICS_ACTOR_CLEANUP_BATCH);
	const security = await ctx.db
		.query("workspaceAnalyticsSecurityEvents")
		.withIndex("by_time", (q) => q.lt("at", securityCutoff))
		.take(ANALYTICS_CLEANUP_BATCH);
	for (const row of aggregates) await ctx.db.delete(row._id);
	for (const row of actors) await ctx.db.delete(row._id);
	for (const row of security) await ctx.db.delete(row._id);
	return {
		aggregatesDeleted: aggregates.length,
		actorsDeleted: actors.length,
		securityEventsDeleted: security.length,
	};
}

export async function recordInvitationFailure(
	ctx: MutationCtx,
	roomCode: string,
	at = Date.now(),
) {
	const room = await ctx.db
		.query("screenshareRooms")
		.withIndex("by_code", (q) => q.eq("code", roomCode.trim().toUpperCase()))
		.unique();
	if (!room) return false;
	await incrementAnalytics(ctx, room.workspaceId, "invitationFailures", 1, at);
	await recordSecurityEvent(ctx, {
		workspaceId: room.workspaceId,
		event: "invitation_failed",
		reason: "invitation_invalid",
		outcome: "failed",
		actorKind: "guest",
		at,
	});
	return true;
}

export const lookupWorkspaceForRoom = internalQuery({
	args: { roomCode: v.string() },
	handler: async (ctx, { roomCode }) => {
		const room = await ctx.db
			.query("screenshareRooms")
			.withIndex("by_code", (q) => q.eq("code", roomCode.trim().toUpperCase()))
			.unique();
		return room?.workspaceId ?? null;
	},
});

export const recordInvitationFailureForRoom = internalMutation({
	args: { roomCode: v.string() },
	handler: (ctx, { roomCode }) => recordInvitationFailure(ctx, roomCode),
});

export const recordInvitationFailureByWorkspace = internalMutation({
	args: { workspaceId: v.id("workspaces") },
	handler: async (ctx, { workspaceId }) => {
		const at = Date.now();
		await incrementAnalytics(ctx, workspaceId, "invitationFailures", 1, at);
		await recordSecurityEvent(ctx, {
			workspaceId,
			event: "invitation_failed",
			reason: "invitation_invalid",
			outcome: "failed",
			actorKind: "guest",
			at,
		});
		return true;
	},
});

export const cleanupAnalytics = internalMutation({
	args: {},
	handler: (ctx) => cleanupAnalyticsHandler(ctx),
});

export async function backfillEndedRoomDurationsHandler(
	ctx: MutationCtx,
	args: { cursor?: string; now?: number },
) {
	const now = args.now ?? Date.now();
	const cutoff = now - ANALYTICS_RETENTION_DAYS * DAY_MS;
	const page = await ctx.db
		.query("screenshareRooms")
		.withIndex("by_status_analytics_duration", (q) =>
			q
				.eq("status", "ended")
				.eq("analyticsDurationRecordedAt", undefined)
				.gte("endedAt", cutoff),
		)
		.paginate({
			cursor: args.cursor ?? null,
			numItems: ANALYTICS_BACKFILL_BATCH,
		});
	let recorded = 0;
	for (const room of page.page) {
		if (
			room.endedAt === undefined ||
			room.endedAt < cutoff ||
			room.endedAt > now
		)
			continue;
		if (await recordRoomEnded(ctx, room, room.endedAt)) recorded += 1;
	}
	return {
		scanned: page.page.length,
		recorded,
		cursor: page.continueCursor,
		isDone: page.isDone,
	};
}

export const backfillEndedRoomDurations = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: (ctx, args) => backfillEndedRoomDurationsHandler(ctx, args),
});
