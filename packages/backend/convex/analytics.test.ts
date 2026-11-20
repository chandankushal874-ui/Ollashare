process.env.ANALYTICS_ACTOR_PEPPER =
	"analytics-test-pepper-0123456789abcdef0123456789abcdef";
import { afterEach, describe, expect, test } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { api, internal } from "./_generated/api";
import {
	backfillEndedRoomDurationsHandler,
	cleanupAnalyticsHandler,
	incrementAnalytics,
	markDailyActiveUser,
	recordRoomEnded,
	recordScreenShareTransition,
	recordSecurityEvent,
	utcDayStart,
} from "./analytics";
import schema from "./schema";
import { disableScreenshareSchedulingForTests } from "./screenshare/lib";

disableScreenshareSchedulingForTests();
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const DAY_MS = 24 * 60 * 60_000;

async function seed(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => {
		const owner = await ctx.db.insert("users", { email: "owner@test.invalid" });
		const admin = await ctx.db.insert("users", { email: "admin@test.invalid" });
		const member = await ctx.db.insert("users", {
			email: "member@test.invalid",
		});
		const outsider = await ctx.db.insert("users", {
			email: "outsider@test.invalid",
		});
		const workspaceId = await ctx.db.insert("workspaces", {
			name: "Analytics",
			ownerId: owner,
			createdAt: Date.now(),
		});
		for (const [userId, role] of [
			[owner, "owner"],
			[admin, "admin"],
			[member, "member"],
		] as const) {
			await ctx.db.insert("members", {
				workspaceId,
				userId,
				role,
				createdAt: Date.now(),
			});
		}
		return { owner, admin, member, outsider, workspaceId };
	});
}

afterEach(() => {
	process.env.ANALYTICS_ACTOR_PEPPER =
		"analytics-test-pepper-0123456789abcdef0123456789abcdef";
});

describe("workspace screenshare analytics", () => {
	test("owner/admin are allowed while member/outsider are denied", async () => {
		const t = convexTest(schema, modules);
		const { owner, admin, member, outsider, workspaceId } = await seed(t);
		await t
			.withIdentity(as(owner))
			.query(api.analytics.getWorkspaceAnalytics, { workspaceId, days: 7 });
		await t
			.withIdentity(as(admin))
			.query(api.analytics.getWorkspaceAnalytics, { workspaceId, days: 7 });
		await expect(
			t
				.withIdentity(as(member))
				.query(api.analytics.getWorkspaceAnalytics, { workspaceId, days: 7 }),
		).rejects.toThrow(/Forbidden/);
		await expect(
			t
				.withIdentity(as(outsider))
				.query(api.analytics.getWorkspaceAnalytics, { workspaceId, days: 7 }),
		).rejects.toThrow(/Forbidden/);
	});

	test("date ranges and security detail results are bounded and sanitized", async () => {
		const t = convexTest(schema, modules);
		const { owner, workspaceId } = await seed(t);
		await expect(
			t
				.withIdentity(as(owner))
				.query(api.analytics.getWorkspaceAnalytics, { workspaceId, days: 91 }),
		).rejects.toThrow(/1 and 90/);
		await expect(
			t.withIdentity(as(owner)).query(api.analytics.listSecurityEvents, {
				workspaceId,
				days: 31,
				limit: 100,
			}),
		).rejects.toThrow(/1 and 30/);
		await expect(
			t.withIdentity(as(owner)).query(api.analytics.listSecurityEvents, {
				workspaceId,
				days: 30,
				limit: 101,
			}),
		).rejects.toThrow(/1 and 100/);
		await t.run((ctx) =>
			recordSecurityEvent(ctx, {
				workspaceId,
				event: "access_denied",
				reason: "room_locked",
				outcome: "denied",
				actorKind: "guest",
			}),
		);
		const events = await t
			.withIdentity(as(owner))
			.query(api.analytics.listSecurityEvents, {
				workspaceId,
				days: 30,
				limit: 100,
			});
		expect(events).toHaveLength(1);
		expect(Object.keys(events[0]).sort()).toEqual([
			"actorKind",
			"at",
			"event",
			"id",
			"outcome",
			"reason",
		]);
		expect(JSON.stringify(events[0])).not.toMatch(
			/email|name|ip|agent|url|token|password|sdp|exception/i,
		);
	});

	test("daily aggregates, false-to-true sharing, and actor dedupe are idempotent", async () => {
		const t = convexTest(schema, modules);
		const { owner, workspaceId } = await seed(t);
		const at = Date.UTC(2026, 10, 10, 12);
		await t.run(async (ctx) => {
			await incrementAnalytics(ctx, workspaceId, "participantJoins", 2, at);
			await recordScreenShareTransition(ctx, {
				workspaceId,
				actorId: owner,
				wasSharing: false,
				isSharing: true,
				at,
			});
			await recordScreenShareTransition(ctx, {
				workspaceId,
				actorId: owner,
				wasSharing: true,
				isSharing: true,
				at,
			});
			expect(await markDailyActiveUser(ctx, workspaceId, owner, at)).toBe(
				false,
			);
		});
		const row = await t.run((ctx) =>
			ctx.db
				.query("workspaceAnalyticsDaily")
				.withIndex("by_workspace_day", (q) =>
					q.eq("workspaceId", workspaceId).eq("dayStart", utcDayStart(at)),
				)
				.unique(),
		);
		expect(row?.participantJoins).toBe(2);
		expect(row?.screenShareStarts).toBe(1);
		expect(row?.activeUsers).toBe(1);
	});

	test("missing analytics pepper fails closed for unique users without blocking counters", async () => {
		const t = convexTest(schema, modules);
		const { owner, workspaceId } = await seed(t);
		process.env.ANALYTICS_ACTOR_PEPPER = undefined;
		await t.run(async (ctx) => {
			expect(await markDailyActiveUser(ctx, workspaceId, owner)).toBe(false);
			await incrementAnalytics(ctx, workspaceId, "rooms", 1);
		});
		const rows = await t.run((ctx) =>
			ctx.db
				.query("workspaceAnalyticsDaily")
				.withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId))
				.collect(),
		);
		expect(rows[0]?.rooms).toBe(1);
		expect(rows[0]?.activeUsers).toBe(0);
		expect(
			await t.run((ctx) => ctx.db.query("workspaceAnalyticsActors").collect()),
		).toHaveLength(0);
	});

	test("room duration records exactly once under repeated end calls", async () => {
		const t = convexTest(schema, modules);
		const { owner, workspaceId } = await seed(t);
		const startedAt = Date.now() - 30_000;
		const roomId = await t.run((ctx) =>
			ctx.db.insert("screenshareRooms", {
				code: "MIRA-AAAAA-BBBBB-CCCCC",
				workspaceId,
				title: "Room",
				hostId: owner,
				hostName: "Host",
				status: "live",
				resolution: "1080p",
				fps: 60,
				bitrateKbps: 8000,
				codec: "H.264",
				audioEnabled: true,
				startedAt,
			}),
		);
		await t.run(async (ctx) => {
			const room = await ctx.db.get(roomId);
			if (!room) throw new Error("missing room");
			expect(await recordRoomEnded(ctx, room, startedAt + 10_000)).toBe(true);
			const updated = await ctx.db.get(roomId);
			if (!updated) throw new Error("missing room");
			expect(await recordRoomEnded(ctx, updated, startedAt + 20_000)).toBe(
				false,
			);
		});
		const rows = await t.run((ctx) =>
			ctx.db.query("workspaceAnalyticsDaily").collect(),
		);
		expect(rows.reduce((sum, row) => sum + row.roomDurationMs, 0)).toBe(10_000);
	});

	test("normal, repeated, force, and stale room ends count duration once", async () => {
		const t = convexTest(schema, modules);
		const { owner, workspaceId } = await seed(t);
		const first = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.createRoom, {
				workspaceId,
				title: "Repeated end",
			});
		const firstStartedAt = Date.now() - 20_000;
		await t.run(async (ctx) => {
			const room = await ctx.db.get(first.roomId);
			if (!room) throw new Error("missing room");
			await ctx.db.patch(room._id, { startedAt: firstStartedAt });
		});
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.endRoom, { code: first.code });
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.endRoom, { code: first.code });
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.forceEndRoom, { code: first.code });

		const second = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.createRoom, {
				workspaceId,
				title: "Stale end",
			});
		const secondStartedAt = Date.now() - 30_000;
		await t.run(async (ctx) => {
			const room = await ctx.db.get(second.roomId);
			if (!room) throw new Error("missing room");
			await ctx.db.patch(room._id, { startedAt: secondStartedAt });
			const viewer = await ctx.db
				.query("screenshareViewers")
				.withIndex("by_room_viewer", (q) =>
					q.eq("roomCode", second.code).eq("viewerId", owner),
				)
				.unique();
			if (!viewer) throw new Error("missing host viewer");
			await ctx.db.patch(viewer._id, { lastPingAt: Date.now() - 180_000 });
		});
		await t.mutation(internal.screenshare.rooms.autoEndStaleRooms, {});
		await t.mutation(internal.screenshare.rooms.autoEndStaleRooms, {});

		const endedRooms = await t.run((ctx) =>
			ctx.db
				.query("screenshareRooms")
				.withIndex("by_workspace_status", (q) =>
					q.eq("workspaceId", workspaceId).eq("status", "ended"),
				)
				.collect(),
		);
		expect(endedRooms).toHaveLength(2);
		expect(
			endedRooms.every(
				(room) => room.analyticsDurationRecordedAt !== undefined,
			),
		).toBe(true);
		const daily = await t.run((ctx) =>
			ctx.db.query("workspaceAnalyticsDaily").collect(),
		);
		const expected = endedRooms.reduce(
			(sum, room) =>
				sum + Math.max(0, (room.endedAt ?? room.startedAt) - room.startedAt),
			0,
		);
		expect(daily.reduce((sum, row) => sum + row.roomDurationMs, 0)).toBe(
			expected,
		);
	});

	test("retention deletes only expired bounded analytics data", async () => {
		const t = convexTest(schema, modules);
		const { workspaceId } = await seed(t);
		const now = Date.now();
		await t.run(async (ctx) => {
			for (const age of [91, 1]) {
				const dayStart = utcDayStart(now - age * DAY_MS);
				await ctx.db.insert("workspaceAnalyticsDaily", {
					workspaceId,
					dayStart,
					rooms: 1,
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
				});
				await ctx.db.insert("workspaceAnalyticsActors", {
					workspaceId,
					dayStart,
					actorKey: `actor-${age}`,
					createdAt: now,
				});
			}
			await ctx.db.insert("workspaceAnalyticsSecurityEvents", {
				workspaceId,
				event: "access_denied",
				reason: "room_locked",
				outcome: "denied",
				actorKind: "guest",
				at: now - 31 * DAY_MS,
			});
			await ctx.db.insert("workspaceAnalyticsSecurityEvents", {
				workspaceId,
				event: "access_denied",
				reason: "room_locked",
				outcome: "denied",
				actorKind: "guest",
				at: now,
			});
			await cleanupAnalyticsHandler(ctx, now);
		});
		expect(
			await t.run((ctx) => ctx.db.query("workspaceAnalyticsDaily").collect()),
		).toHaveLength(1);
		expect(
			await t.run((ctx) => ctx.db.query("workspaceAnalyticsActors").collect()),
		).toHaveLength(1);
		expect(
			await t.run((ctx) =>
				ctx.db.query("workspaceAnalyticsSecurityEvents").collect(),
			),
		).toHaveLength(1);
	});

	test("backfill records ended-room duration within 90 days and does not invent active users", async () => {
		const t = convexTest(schema, modules);
		const { owner, workspaceId } = await seed(t);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("screenshareRooms", {
				code: "MIRA-DDDDD-EEEEE-FFFFF",
				workspaceId,
				title: "Recent",
				hostId: owner,
				hostName: "Host",
				status: "ended",
				resolution: "1080p",
				fps: 60,
				bitrateKbps: 8000,
				codec: "H.264",
				audioEnabled: true,
				startedAt: now - DAY_MS - 60_000,
				endedAt: now - DAY_MS,
			});
			await ctx.db.insert("screenshareRooms", {
				code: "MIRA-GGGGG-HHHHH-JJJJJ",
				workspaceId,
				title: "Old",
				hostId: owner,
				hostName: "Host",
				status: "ended",
				resolution: "1080p",
				fps: 60,
				bitrateKbps: 8000,
				codec: "H.264",
				audioEnabled: true,
				startedAt: now - 100 * DAY_MS - 60_000,
				endedAt: now - 100 * DAY_MS,
			});
			const result = await backfillEndedRoomDurationsHandler(ctx, { now });
			expect(result.recorded).toBe(1);
		});
		const daily = await t.run((ctx) =>
			ctx.db.query("workspaceAnalyticsDaily").collect(),
		);
		expect(daily.reduce((sum, row) => sum + row.roomDurationMs, 0)).toBe(
			60_000,
		);
		expect(daily.reduce((sum, row) => sum + row.activeUsers, 0)).toBe(0);
		expect(
			await t.run((ctx) => ctx.db.query("workspaceAnalyticsActors").collect()),
		).toHaveLength(0);
	});
});
