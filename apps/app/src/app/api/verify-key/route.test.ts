import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST } from "./route";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const secret = "verify-key-proxy-test-secret-".repeat(2);

function request(headers: Record<string, string> = {}) {
	return new Request("https://app.example/api/verify-key", {
		method: "POST",
		headers: {
			"x-api-key": `sk_${"a".repeat(48)}`,
			"cf-connecting-ip": "2001:DB8::A",
			"x-mira-trusted-proxy": "loopback",
			"x-mira-client-ip": "203.0.113.99",
			...headers,
		},
	});
}

beforeEach(() => {
	process.env.MIRA_VERIFY_KEY_PROXY_SECRET = secret;
	process.env.MIRA_CONVEX_HTTP_ORIGIN = "https://convex.example";
	process.env.MIRA_HOSTING_MODE = "loopback-proxy";
	process.env.MIRA_TRUSTED_PROXY = "loopback";
});

afterEach(() => {
	process.env = { ...originalEnv };
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("verify-key Next.js proxy", () => {
	test("fails closed when proxy authentication is not configured", async () => {
		process.env.MIRA_VERIFY_KEY_PROXY_SECRET = "";
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await POST(request());

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('{"valid":false}');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("signs a normalized trusted source and ignores caller-controlled legacy source headers", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				const timestamp = headers.get("x-mira-proxy-timestamp") ?? "";
				const nonce = headers.get("x-mira-proxy-nonce") ?? "";
				const source = headers.get("x-mira-client-ip") ?? "";
				const key = headers.get("x-api-key") ?? "";
				const expected = createHmac("sha256", secret)
					.update(
						`${timestamp}.${nonce}.POST./api/verify-key.${source}.${createHash("sha256").update(key).digest("hex")}`,
					)
					.digest("hex");
				expect(source).toBe("2001:db8::a");
				expect(headers.get("x-mira-proxy-signature")).toBe(expected);
				expect(headers.has("x-mira-trusted-proxy")).toBe(false);
				return new Response('{"valid":true }', { status: 200 });
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{"valid":true }');
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	test("uses one non-spoofable fallback bucket when direct callers rotate source headers", async () => {
		const sources: string[] = [];
		globalThis.fetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				sources.push(new Headers(init?.headers).get("x-mira-client-ip") ?? "");
				return new Response('{"valid":false}', { status: 401 });
			},
		) as unknown as typeof fetch;

		await Promise.all([
			POST(
				request({ "cf-connecting-ip": "", "x-mira-client-ip": "203.0.113.1" }),
			),
			POST(
				request({ "cf-connecting-ip": "", "x-mira-client-ip": "203.0.113.2" }),
			),
			POST(
				request({ "cf-connecting-ip": "", "x-mira-client-ip": "203.0.113.3" }),
			),
		]);

		expect(sources).toEqual(["unknown", "unknown", "unknown"]);
	});

	test.each([
		["malformed key", { "x-api-key": "not-a-key" }, undefined],
		["oversized key", { "x-api-key": `sk_${"a".repeat(9 * 1024)}` }, undefined],
		["oversized headers", { "x-padding": "x".repeat(9 * 1024) }, undefined],
		["non-empty body", {}, "x"],
	])("rejects %s locally without proxying", async (_name, headers, body) => {
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const input = new Request("https://app.example/api/verify-key", {
			method: "POST",
			headers: {
				"x-api-key": `sk_${"a".repeat(48)}`,
				...headers,
			},
			body,
		});
		const response = await POST(input);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('{"valid":false}');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("maps upstream errors and malformed bodies to one generic response", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response('{"vendor":"detail"}', { status: 500 }),
		) as unknown as typeof fetch;

		const response = await POST(request());

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('{"valid":false}');
	});
});
