import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../testSessions";
import { api, internal } from "./_generated/api";
import { disableJobSchedulingForTests, validateClientJobRequest } from "./jobs";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
disableJobSchedulingForTests();
const as = (userId: string) => ({
	subject: userId,
	issuer: "https://test",
	tokenIdentifier: `https://test|${userId}`,
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
	const userId = await t.run((ctx) =>
		ctx.db.insert("users", { email: "jobs@example.test" }),
	);
	const workspaceId = await t.run(async (ctx) => {
		const id = await ctx.db.insert("workspaces", {
			name: "Jobs",
			ownerId: userId,
			createdAt: Date.now(),
		});
		await ctx.db.insert("members", {
			workspaceId: id,
			userId,
			role: "admin",
			createdAt: Date.now(),
		});
		return id;
	});
	return { userId, workspaceId };
}

async function rejectionState(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => ({
		jobs: await ctx.db.query("jobs").collect(),
		audits: await ctx.db.query("auditLogs").collect(),
		usage: await ctx.db.query("usage").collect(),
		counters: await ctx.db.query("counters").collect(),
		notifications: await ctx.db.query("notifications").collect(),
	}));
}

describe("job creation controls", () => {
	test("rejects unknown kinds before insert, accounting, notification, or scheduling effects", async () => {
		const t = convexTest(schema, modules);
		const { userId, workspaceId } = await seedWorkspace(t);
		const caller = t.withIdentity(as(userId));
		await expect(
			caller.mutation(api.jobs.create, {
				workspaceId,
				kind: "admin.reindex",
				input: {},
			}),
		).rejects.toThrow(/Invalid job request/);
		expect(await rejectionState(t)).toEqual({
			jobs: [],
			audits: [],
			usage: [],
			counters: [],
			notifications: [],
		});
		expect(await t.run((ctx) => ctx.db.query("rateLimits").collect())).toEqual(
			[],
		);
	});

	test("rejects oversized, deep, cyclic, functional, and unsupported-shaped input", async () => {
		const t = convexTest(schema, modules);
		const { userId, workspaceId } = await seedWorkspace(t);
		const caller = t.withIdentity(as(userId));
		await expect(
			caller.mutation(api.jobs.create, {
				workspaceId,
				kind: "demo",
				input: { prompt: "x".repeat(4097) },
			}),
		).rejects.toThrow(/Invalid job request/);
		await expect(
			caller.mutation(api.jobs.create, {
				workspaceId,
				kind: "demo",
				input: { prompt: "ok", extra: true },
			}),
		).rejects.toThrow(/Invalid job request/);
		let deep: unknown = "leaf";
		for (let index = 0; index < 10; index++) deep = { child: deep };
		expect(() => validateClientJobRequest("demo", deep)).toThrow(
			/Invalid job request/,
		);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => validateClientJobRequest("demo", cyclic)).toThrow(
			/Invalid job request/,
		);
		expect(() =>
			validateClientJobRequest("demo", { prompt: () => "no" }),
		).toThrow(/Invalid job request/);
		expect(await rejectionState(t)).toEqual({
			jobs: [],
			audits: [],
			usage: [],
			counters: [],
			notifications: [],
		});
	});

	test("allows a member, rejects an outsider, and accepts the supported demo contract", async () => {
		const t = convexTest(schema, modules);
		const { workspaceId } = await seedWorkspace(t);
		const { memberId, outsiderId } = await t.run(async (ctx) => {
			const memberId = await ctx.db.insert("users", {
				email: "member@example.test",
			});
			const outsiderId = await ctx.db.insert("users", {
				email: "outsider@example.test",
			});
			await ctx.db.insert("members", {
				workspaceId,
				userId: memberId,
				role: "member",
				createdAt: Date.now(),
			});
			return { memberId, outsiderId };
		});
		await expect(
			t.withIdentity(as(outsiderId)).mutation(api.jobs.create, {
				workspaceId,
				kind: "demo",
				input: { prompt: "hello" },
			}),
		).rejects.toThrow(/Forbidden/);
		const jobId = await t.withIdentity(as(memberId)).mutation(api.jobs.create, {
			workspaceId,
			kind: "demo",
			input: { prompt: "hello" },
		});
		const state = await t.run(async (ctx) => ({
			job: await ctx.db.get(jobId),
			audits: await ctx.db.query("auditLogs").collect(),
			usage: await ctx.db.query("usage").collect(),
			counters: await ctx.db.query("counters").collect(),
			notifications: await ctx.db.query("notifications").collect(),
			rates: await ctx.db.query("rateLimits").collect(),
		}));
		expect(state.job).toMatchObject({
			workspaceId,
			userId: memberId,
			kind: "demo",
			status: "pending",
			input: { prompt: "hello" },
		});
		expect(state.audits).toHaveLength(1);
		expect(state.audits[0]?.meta).toEqual({ jobId, kind: "demo" });
		expect(state.usage).toHaveLength(1);
		expect(state.counters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ metric: "jobs", value: 1 }),
				expect.objectContaining({ metric: "openJobs", value: 1 }),
			]),
		);
		expect(state.notifications).toHaveLength(0);
		expect(state.rates).toHaveLength(2);
	});

	test("enforces persistent per-user and per-workspace creation rates without side effects", async () => {
		const t = convexTest(schema, modules);
		const { userId, workspaceId } = await seedWorkspace(t);
		const caller = t.withIdentity(as(userId));
		await t.run((ctx) =>
			ctx.db.insert("rateLimits", {
				key: `job_create:user:${userId}`,
				kind: "job_create",
				count: 30,
				resetAt: Date.now() + 60_000,
			}),
		);
		await expect(
			caller.mutation(api.jobs.create, {
				workspaceId,
				kind: "demo",
				input: {},
			}),
		).rejects.toThrow(/Too many requests/);
		expect(await rejectionState(t)).toEqual({
			jobs: [],
			audits: [],
			usage: [],
			counters: [],
			notifications: [],
		});

		const t2 = convexTest(schema, modules);
		const seeded = await seedWorkspace(t2);
		await t2.run((ctx) =>
			ctx.db.insert("rateLimits", {
				key: `job_create:workspace:${seeded.workspaceId}`,
				kind: "job_create",
				count: 120,
				resetAt: Date.now() + 60_000,
			}),
		);
		await expect(
			t2.withIdentity(as(seeded.userId)).mutation(api.jobs.create, {
				workspaceId: seeded.workspaceId,
				kind: "demo",
				input: {},
			}),
		).rejects.toThrow(/Too many requests/);
		expect(await rejectionState(t2)).toEqual({
			jobs: [],
			audits: [],
			usage: [],
			counters: [],
			notifications: [],
		});
	});

	test("caps active pending/running jobs per user", async () => {
		const t = convexTest(schema, modules);
		const { userId, workspaceId } = await seedWorkspace(t);
		const caller = t.withIdentity(as(userId));
		await t.run(async (ctx) => {
			for (let index = 0; index < 5; index++) {
				await ctx.db.insert("jobs", {
					workspaceId,
					userId,
					kind: "demo",
					status: index % 2 === 0 ? "pending" : "running",
					input: { prompt: `${index}` },
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});
		await expect(
			caller.mutation(api.jobs.create, {
				workspaceId,
				kind: "demo",
				input: {},
			}),
		).rejects.toThrow(/Too many active jobs for this user/);
		expect((await rejectionState(t)).jobs).toHaveLength(5);
	});

	test("caps active pending/running jobs per workspace", async () => {
		const t = convexTest(schema, modules);
		const { workspaceId } = await seedWorkspace(t);
		const targetId = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert("users", {
				email: "target@example.test",
			});
			await ctx.db.insert("members", {
				workspaceId,
				userId: targetId,
				role: "member",
				createdAt: Date.now(),
			});
			for (let userIndex = 0; userIndex < 4; userIndex++) {
				const activeUserId = await ctx.db.insert("users", {
					email: `active-${userIndex}@example.test`,
				});
				for (let jobIndex = 0; jobIndex < 5; jobIndex++) {
					await ctx.db.insert("jobs", {
						workspaceId,
						userId: activeUserId,
						kind: "demo",
						status: jobIndex % 2 === 0 ? "pending" : "running",
						input: {},
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
				}
			}
			return targetId;
		});
		await expect(
			t.withIdentity(as(targetId)).mutation(api.jobs.create, {
				workspaceId,
				kind: "demo",
				input: {},
			}),
		).rejects.toThrow(/Too many active jobs for this workspace/);
		expect((await rejectionState(t)).jobs).toHaveLength(20);
	});
});

describe("job producer contract", () => {
	test("sends signed-webhook ownership fields with the bounded job request", async () => {
		const t = convexTest(schema, modules);
		const { userId, workspaceId } = await seedWorkspace(t);
		const jobId = await t.run((ctx) =>
			ctx.db.insert("jobs", {
				workspaceId,
				userId,
				kind: "demo",
				status: "pending",
				input: { prompt: "contract" },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		vi.stubEnv("BACKEND_BASE_URL", "https://backend.example");
		vi.stubEnv("BACKEND_SERVICE_KEY", "service-key");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 202 }));
		vi.stubGlobal("fetch", fetchMock);
		await t.action(internal.jobs.processJob, { jobId });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://backend.example/jobs/run");
		expect(JSON.parse(String(init.body))).toEqual({
			jobId,
			workspaceId,
			userId,
			kind: "demo",
			input: { prompt: "contract" },
		});
	});
});
