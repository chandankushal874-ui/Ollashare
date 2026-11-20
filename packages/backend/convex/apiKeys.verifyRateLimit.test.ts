import { describe, expect, test } from "vitest";
/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

describe("API key verification admission", () => {
	test("persists source and global limits across requests", async () => {
		const t = convexTest(schema, modules);
		const sourceHash = "a".repeat(64);

		for (let index = 0; index < 120; index += 1) {
			const nonceHash = index.toString(16).padStart(64, "0");
			expect(
				await t.mutation(internal.apiKeys.admitVerification, {
					sourceHash,
					nonceHash,
				}),
			).toBe(true);
		}
		expect(
			await t.mutation(internal.apiKeys.admitVerification, {
				sourceHash,
				nonceHash: "f".repeat(64),
			}),
		).toBe(false);

		const rows = await t.run((ctx) => ctx.db.query("rateLimits").collect());
		expect(rows.find((row) => row.key === "api_key_verify:global")?.count).toBe(
			121,
		);
		expect(
			rows.find((row) => row.key === `api_key_verify:source:${sourceHash}`)
				?.count,
		).toBe(120);
	});

	test("rejects replayed nonces after charging persistent source and global admission", async () => {
		const t = convexTest(schema, modules);
		const sourceHash = "a".repeat(64);
		const nonceHash = "b".repeat(64);

		expect(
			await t.mutation(internal.apiKeys.admitVerification, {
				sourceHash,
				nonceHash,
			}),
		).toBe(true);
		expect(
			await t.mutation(internal.apiKeys.admitVerification, {
				sourceHash,
				nonceHash,
			}),
		).toBe(false);

		const rows = await t.run((ctx) => ctx.db.query("rateLimits").collect());
		expect(rows.find((row) => row.key === "api_key_verify:global")?.count).toBe(
			2,
		);
		expect(
			rows.find((row) => row.key === `api_key_verify:source:${sourceHash}`)
				?.count,
		).toBe(2);
		expect(
			rows.find((row) => row.key === `api_key_verify:nonce:${nonceHash}`)
				?.count,
		).toBe(1);
	});

	test("rejects malformed admission hashes without allocating limiter rows", async () => {
		const t = convexTest(schema, modules);
		expect(
			await t.mutation(internal.apiKeys.admitVerification, {
				sourceHash: "spoofed",
				nonceHash: "b".repeat(64),
			}),
		).toBe(false);
		expect(
			await t.mutation(internal.apiKeys.admitVerification, {
				sourceHash: "a".repeat(64),
				nonceHash: "spoofed",
			}),
		).toBe(false);
		expect(await t.run((ctx) => ctx.db.query("rateLimits").collect())).toEqual(
			[],
		);
	});
});
