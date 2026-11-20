import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	VERIFY_KEY_MIN_DURATION_MS,
	VERIFY_KEY_RESPONSE_BODY,
	VERIFY_KEY_VALID_RESPONSE_BODY,
	type VerifyKeyContext,
	type VerifyKeyReferences,
	handleVerifyKeyRequest,
} from "./verifyKeyHttp";

const proxySecret = "verify-key-proxy-test-secret-".repeat(2);
const originalEnv = { ...process.env };

const references = {
	admit: "admit" as never,
	resolve: "resolve" as never,
} satisfies VerifyKeyReferences;

function context(options: { admitted?: boolean; found?: unknown } = {}) {
	return {
		runMutation: vi.fn(async () => options.admitted ?? true),
		runQuery: vi.fn(async () => options.found ?? null),
	} as unknown as VerifyKeyContext;
}

function request(
	headers: Record<string, string> = {},
	init: RequestInit = {},
	signatureOverrides: {
		key?: string;
		source?: string;
		timestamp?: string;
		nonce?: string;
		method?: string;
		path?: string;
	} = {},
) {
	const key = headers["x-api-key"] ?? `sk_${"a".repeat(48)}`;
	const source = headers["x-mira-client-ip"] ?? "198.51.100.7";
	const timestamp = headers["x-mira-proxy-timestamp"] ?? String(Date.now());
	const nonce = headers["x-mira-proxy-nonce"] ?? "a".repeat(32);
	const signedKey = signatureOverrides.key ?? key;
	const signedSource = signatureOverrides.source ?? source;
	const signedTimestamp = signatureOverrides.timestamp ?? timestamp;
	const signedNonce = signatureOverrides.nonce ?? nonce;
	const signedMethod = signatureOverrides.method ?? init.method ?? "POST";
	const signedPath = signatureOverrides.path ?? "/api/verify-key";
	const signature = createHmac("sha256", proxySecret)
		.update(
			`${signedTimestamp}.${signedNonce}.${signedMethod}.${signedPath}.${signedSource.trim().toLowerCase()}.${createHash("sha256").update(signedKey).digest("hex")}`,
		)
		.digest("hex");
	return new Request("https://app.example/api/verify-key", {
		method: "POST",
		headers: {
			"x-api-key": key,
			"x-mira-client-ip": source,
			"x-mira-proxy-timestamp": timestamp,
			"x-mira-proxy-nonce": nonce,
			"x-mira-proxy-signature": signature,
			...headers,
		},
		...init,
	});
}

beforeEach(() => {
	process.env.MIRA_VERIFY_KEY_PROXY_SECRET = proxySecret;
});

afterEach(() => {
	process.env = { ...originalEnv };
	vi.useRealTimers();
});

describe("verify-key HTTP boundary", () => {
	test("keeps valid API-key verification compatible while returning a constant body", async () => {
		vi.useFakeTimers();
		const ctx = context({ found: { keyId: "key" } });
		const pending = handleVerifyKeyRequest(ctx, request(), references);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);
		const response = await pending;

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(VERIFY_KEY_VALID_RESPONSE_BODY);
		expect(VERIFY_KEY_VALID_RESPONSE_BODY.length).toBe(
			VERIFY_KEY_RESPONSE_BODY.length,
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(ctx.runMutation).toHaveBeenCalledOnce();
		expect(ctx.runQuery).toHaveBeenCalledOnce();
	});

	test("pads valid and invalid key paths to the same minimum duration", async () => {
		vi.useFakeTimers();
		const valid = context({ found: { keyId: "key" } });
		const invalid = context();
		const validPending = handleVerifyKeyRequest(valid, request(), references);
		const invalidPending = handleVerifyKeyRequest(
			invalid,
			request({ "x-api-key": `sk_${"b".repeat(48)}` }),
			references,
		);
		let validSettled = false;
		let invalidSettled = false;
		validPending.then(() => {
			validSettled = true;
		});
		invalidPending.then(() => {
			invalidSettled = true;
		});

		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS - 1);
		expect(validSettled).toBe(false);
		expect(invalidSettled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect((await validPending).status).toBe(200);
		expect((await invalidPending).status).toBe(401);
	});

	test("rejects missing and malformed keys before admission and DB lookup", async () => {
		vi.useFakeTimers();
		const missing = context();
		const malformed = context();
		const missingPending = handleVerifyKeyRequest(
			missing,
			request({ "x-api-key": "" }),
			references,
		);
		const malformedPending = handleVerifyKeyRequest(
			malformed,
			request({ "x-api-key": "not-a-key" }),
			references,
		);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);
		const [missingResponse, malformedResponse] = await Promise.all([
			missingPending,
			malformedPending,
		]);

		expect(missingResponse.status).toBe(401);
		expect(malformedResponse.status).toBe(401);
		expect(await missingResponse.text()).toBe(VERIFY_KEY_RESPONSE_BODY);
		expect(await malformedResponse.text()).toBe(VERIFY_KEY_RESPONSE_BODY);
		expect(missing.runMutation).not.toHaveBeenCalled();
		expect(malformed.runMutation).not.toHaveBeenCalled();
		expect(missing.runQuery).not.toHaveBeenCalled();
		expect(malformed.runQuery).not.toHaveBeenCalled();
	});

	test("fails closed when proxy authentication is missing", async () => {
		vi.useFakeTimers();
		const ctx = context();
		const pending = handleVerifyKeyRequest(
			ctx,
			request({
				"x-mira-proxy-timestamp": "",
				"x-mira-proxy-nonce": "",
				"x-mira-proxy-signature": "",
			}),
			references,
		);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);

		expect((await pending).status).toBe(401);
		expect(ctx.runMutation).not.toHaveBeenCalled();
		expect(ctx.runQuery).not.toHaveBeenCalled();
	});

	test("rejects the forged legacy marker and client IP without signed proxy auth", async () => {
		vi.useFakeTimers();
		const ctx = context();
		const pending = handleVerifyKeyRequest(
			ctx,
			request({
				"x-mira-trusted-proxy": "loopback",
				"x-mira-client-ip": "203.0.113.9",
				"x-mira-proxy-timestamp": "",
				"x-mira-proxy-nonce": "",
				"x-mira-proxy-signature": "",
			}),
			references,
		);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);

		expect((await pending).status).toBe(401);
		expect(ctx.runMutation).not.toHaveBeenCalled();
		expect(ctx.runQuery).not.toHaveBeenCalled();
	});

	test("rejects invalid proxy authentication", async () => {
		vi.useFakeTimers();
		const ctx = context();
		const pending = handleVerifyKeyRequest(
			ctx,
			request({
				"x-mira-proxy-signature": "0".repeat(64),
			}),
			references,
		);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);

		expect((await pending).status).toBe(401);
		expect(ctx.runMutation).not.toHaveBeenCalled();
		expect(ctx.runQuery).not.toHaveBeenCalled();
	});

	test("accepts authenticated proxy requests and normalizes the signed client source", async () => {
		vi.useFakeTimers();
		const ctx = context();
		const pending = handleVerifyKeyRequest(
			ctx,
			request({
				"x-mira-client-ip": "2001:DB8::A",
			}),
			references,
		);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);

		expect((await pending).status).toBe(401);
		expect(ctx.runMutation).toHaveBeenCalledWith(references.admit, {
			sourceHash: createHash("sha256").update("2001:db8::a").digest("hex"),
			nonceHash: createHash("sha256").update("a".repeat(32)).digest("hex"),
		});
		expect(ctx.runQuery).toHaveBeenCalledOnce();
	});

	test("does not let rotating forged IPs select independent source buckets", async () => {
		vi.useFakeTimers();
		const contexts = [context(), context(), context()];
		const pending = contexts.map((ctx, index) =>
			handleVerifyKeyRequest(
				ctx,
				request({
					"x-mira-trusted-proxy": "loopback",
					"x-mira-client-ip": `203.0.113.${index + 1}`,
					"x-mira-proxy-timestamp": "",
					"x-mira-proxy-nonce": "",
					"x-mira-proxy-signature": "",
				}),
				references,
			),
		);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);

		expect(
			(await Promise.all(pending)).map((response) => response.status),
		).toEqual([401, 401, 401]);
		for (const ctx of contexts) {
			expect(ctx.runMutation).not.toHaveBeenCalled();
			expect(ctx.runQuery).not.toHaveBeenCalled();
		}
	});

	test.each([
		["expired", { "x-mira-proxy-timestamp": String(Date.now() - 31_000) }, {}],
		["tampered key", {}, { key: `sk_${"b".repeat(48)}` }],
		["tampered source", {}, { source: "203.0.113.4" }],
		["tampered method", {}, { method: "PUT" }],
		["tampered path", {}, { path: "/api/other" }],
	])(
		"rejects %s signed requests before persistent admission or DB lookup",
		async (_name, headers, signatureOverrides) => {
			vi.useFakeTimers();
			const ctx = context();
			const pending = handleVerifyKeyRequest(
				ctx,
				request(headers, {}, signatureOverrides),
				references,
			);
			await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);

			expect((await pending).status).toBe(401);
			expect(ctx.runMutation).not.toHaveBeenCalled();
			expect(ctx.runQuery).not.toHaveBeenCalled();
		},
	);

	test("stops before the key lookup when persistent admission denies the source or replay", async () => {
		vi.useFakeTimers();
		const ctx = context({ admitted: false });
		const pending = handleVerifyKeyRequest(ctx, request(), references);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);
		const response = await pending;

		expect(response.status).toBe(429);
		expect(await response.text()).toBe(VERIFY_KEY_RESPONSE_BODY);
		expect(ctx.runQuery).not.toHaveBeenCalled();
	});

	test("bounds method, body, key and aggregate header size before admission or DB work", async () => {
		vi.useFakeTimers();
		const methodCtx = context();
		const bodyCtx = context();
		const keyCtx = context();
		const headerCtx = context();
		const methodPending = handleVerifyKeyRequest(
			methodCtx,
			request({}, { method: "PUT" }),
			references,
		);
		const bodyPending = handleVerifyKeyRequest(
			bodyCtx,
			request({ "content-length": "1" }, { body: "x" }),
			references,
		);
		const keyPending = handleVerifyKeyRequest(
			keyCtx,
			request({ "x-api-key": `sk_${"a".repeat(9 * 1024)}` }),
			references,
		);
		const headerPending = handleVerifyKeyRequest(
			headerCtx,
			request({ "x-padding": "x".repeat(9 * 1024) }),
			references,
		);
		await vi.advanceTimersByTimeAsync(VERIFY_KEY_MIN_DURATION_MS);
		const [methodResponse, bodyResponse, keyResponse, headerResponse] =
			await Promise.all([
				methodPending,
				bodyPending,
				keyPending,
				headerPending,
			]);

		expect(methodResponse.status).toBe(405);
		expect(bodyResponse.status).toBe(413);
		expect(keyResponse.status).toBe(431);
		expect(headerResponse.status).toBe(431);
		for (const ctx of [methodCtx, bodyCtx, keyCtx, headerCtx]) {
			expect(ctx.runMutation).not.toHaveBeenCalled();
			expect(ctx.runQuery).not.toHaveBeenCalled();
		}
	});
});
