import { describe, expect, test, vi } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { disableScreenshareSchedulingForTests } from "./screenshare/lib";

disableScreenshareSchedulingForTests();
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const profile = {
	resolution: "1080p",
	fps: 30,
	width: 1920,
	height: 1080,
	videoBitrateKbps: 7_000,
	audioIncluded: true,
};

async function seed() {
	const t = convexTest(schema, modules);
	const data = await t.run(async (ctx) => {
		const owner = await ctx.db.insert("users", {
			email: "owner@recording.test",
		});
		const member = await ctx.db.insert("users", {
			email: "member@recording.test",
		});
		const outsider = await ctx.db.insert("users", {
			email: "outsider@recording.test",
		});
		const workspaceId = await ctx.db.insert("workspaces", {
			name: "Recording WS",
			ownerId: owner,
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
			userId: member,
			role: "member",
			createdAt: Date.now(),
		});
		return { owner, member, outsider, workspaceId };
	});
	const room = await t
		.withIdentity(as(data.owner))
		.mutation(api.screenshare.createRoom, {
			workspaceId: data.workspaceId,
			title: "Recording room",
		});
	return { t, ...data, code: room.code };
}

describe("local recording awareness", () => {
	test("host starts one recording and participants can read only safe indicator fields", async () => {
		const { t, owner, member, code } = await seed();
		await t
			.withIdentity(as(member))
			.mutation(api.screenshare.joinRoom, { roomCode: code, name: "Member" });
		const started = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.startLocalRecording, {
				code,
				target: "grid",
				profile,
			});
		await expect(
			t.withIdentity(as(owner)).mutation(api.screenshare.startLocalRecording, {
				code,
				target: "grid",
				profile,
			}),
		).rejects.toThrow(/already active/);
		const indicator = await t
			.withIdentity(as(member))
			.query(api.screenshare.getActiveLocalRecording, { code });
		expect(started.recordingId).toBeTruthy();
		expect(indicator).toMatchObject({
			state: "recording",
			target: "grid",
			profile: { resolution: "1080p", fps: 30 },
		});
		expect(indicator).not.toHaveProperty("recordingId");
		expect(indicator).not.toHaveProperty("roomCode");
		expect(indicator).not.toHaveProperty("hostId");
		expect(indicator).not.toHaveProperty("heartbeatAt");
		expect(indicator).not.toHaveProperty("leaseExpiresAt");
		expect(indicator).not.toHaveProperty("filename");
		expect(indicator).not.toHaveProperty("pageTitle");
		expect(indicator).not.toHaveProperty("chunks");
	});

	test("accepts Shared Browser awareness as a video-only target", async () => {
		const { t, owner, code } = await seed();
		await expect(
			t.withIdentity(as(owner)).mutation(api.screenshare.startLocalRecording, {
				code,
				target: "shared-browser",
				profile: { ...profile, audioIncluded: true },
			}),
		).rejects.toThrow(/video only/);
		const started = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.startLocalRecording, {
				code,
				target: "shared-browser",
				profile: { ...profile, audioIncluded: false },
			});
		const indicator = await t
			.withIdentity(as(owner))
			.query(api.screenshare.getActiveLocalRecording, { code });
		expect(started.recordingId).toBeTruthy();
		expect(indicator).toMatchObject({
			target: "shared-browser",
			profile: { audioIncluded: false },
		});
	});

	test("non-hosts cannot mutate recording state", async () => {
		const { t, owner, member, code } = await seed();
		const started = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.startLocalRecording, {
				code,
				target: "focused",
				profile,
			});
		await expect(
			t
				.withIdentity(as(member))
				.mutation(api.screenshare.heartbeatLocalRecording, {
					code,
					recordingId: started.recordingId,
				}),
		).rejects.toThrow(/Forbidden/);
	});

	test("validates bounded profiles and pause/resume/stop lifecycle", async () => {
		const { t, owner, code } = await seed();
		await expect(
			t.withIdentity(as(owner)).mutation(api.screenshare.startLocalRecording, {
				code,
				target: "grid",
				profile: { ...profile, fps: 120 },
			}),
		).rejects.toThrow(/Invalid recording fps/);
		await expect(
			t.withIdentity(as(owner)).mutation(api.screenshare.startLocalRecording, {
				code,
				target: "grid",
				profile: { ...profile, fps: 60 },
			}),
		).rejects.toThrow(/only at 360p/);
		const started = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.startLocalRecording, {
				code,
				target: "grid",
				profile,
			});
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.setLocalRecordingPaused, {
				code,
				recordingId: started.recordingId,
				paused: true,
			});
		expect(
			(
				await t
					.withIdentity(as(owner))
					.query(api.screenshare.getActiveLocalRecording, { code })
			)?.state,
		).toBe("paused");
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.setLocalRecordingPaused, {
				code,
				recordingId: started.recordingId,
				paused: false,
			});
		await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.finishLocalRecording, {
				code,
				recordingId: started.recordingId,
			});
		expect(
			await t
				.withIdentity(as(owner))
				.query(api.screenshare.getActiveLocalRecording, { code }),
		).toBeNull();
	});

	test("stale leases fail cleanup and room end clears active indicator", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const { t, owner, code } = await seed();
		const started = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.startLocalRecording, {
				code,
				target: "grid",
				profile,
			});
		vi.advanceTimersByTime(46_000);
		await t.mutation(internal.screenshare.cleanupLocalRecordings, {});
		const stale = await t.run((ctx) => ctx.db.get(started.recordingId));
		expect(stale).toMatchObject({
			state: "failed",
			failureCategory: "heartbeat_timeout",
		});
		const next = await t
			.withIdentity(as(owner))
			.mutation(api.screenshare.startLocalRecording, {
				code,
				target: "grid",
				profile,
			});
		await t.withIdentity(as(owner)).mutation(api.screenshare.endRoom, { code });
		const ended = await t.run((ctx) => ctx.db.get(next.recordingId));
		expect(ended?.state).toBe("stopped");
		expect(
			await t
				.withIdentity(as(owner))
				.query(api.screenshare.getActiveLocalRecording, { code }),
		).toBeNull();
		vi.useRealTimers();
	});
});
