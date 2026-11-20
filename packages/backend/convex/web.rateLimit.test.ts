import { describe, expect, test } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

describe("newsletter persistent admission", () => {
	test("persists the per-email limit before any outbound action work", async () => {
		const t = convexTest(schema, modules);
		const emailHash = "a".repeat(64);

		expect(
			await t.mutation(internal.web.reserveSubscription, { emailHash }),
		).toBe(true);
		expect(
			await t.mutation(internal.web.reserveSubscription, { emailHash }),
		).toBe(false);

		const rows = await t.run((ctx) => ctx.db.query("rateLimits").collect());
		expect(
			rows.find((row) => row.key === `newsletter:email:${emailHash}`)?.count,
		).toBe(1);
		expect(rows.find((row) => row.key === "newsletter:global")?.count).toBe(2);
	});

	test("enforces a persisted global limit across distinct email hashes", async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert("rateLimits", {
				key: "newsletter:global",
				kind: "newsletter",
				count: 5_000,
				resetAt: Date.now() + 60_000,
			}),
		);

		expect(
			await t.mutation(internal.web.reserveSubscription, {
				emailHash: "f".repeat(64),
			}),
		).toBe(false);

		const rows = await t.run((ctx) => ctx.db.query("rateLimits").collect());
		expect(rows.find((row) => row.key === "newsletter:global")?.count).toBe(
			5_000,
		);
		expect(
			rows.some((row) => row.key === `newsletter:email:${"f".repeat(64)}`),
		).toBe(false);
	});

	test("rejects malformed email hashes without allocating limiter rows", async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(internal.web.reserveSubscription, { emailHash: "spoofed" }),
		).rejects.toThrow(/Newsletter request unavailable/);
		expect(await t.run((ctx) => ctx.db.query("rateLimits").collect())).toEqual(
			[],
		);
	});
});
