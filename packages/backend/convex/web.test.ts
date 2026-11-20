import { describe, expect, test, vi } from "vitest";
import {
	executeNewsletterSubscription,
	normalizeSubscription,
	validateNewsletterConfig,
} from "./web";

const config = {
	apiKey: "loops-test-key-".repeat(3),
	formId: "newsletter-form",
	userGroup: "v1-newsletter" as const,
};

function context() {
	return { runMutation: vi.fn(async () => true) };
}

describe("newsletter subscription boundary", () => {
	test("normalizes a bounded approved email and exposes no public group input", () => {
		expect(normalizeSubscription(" Person@Example.COM ")).toBe(
			"person@example.com",
		);
	});

	test.each([
		"missing-at.example.com",
		"person@example",
		`${"a".repeat(65)}@example.com`,
		`${"a".repeat(243)}@example.com`,
	])("rejects malformed or oversized email %s", (email) => {
		expect(() => normalizeSubscription(email)).toThrow(
			"Newsletter request unavailable",
		);
	});

	test.each([
		{},
		{
			LOOPS_API_KEY: "short",
			LOOPS_FORM_ID: "form",
			LOOPS_NEWSLETTER_GROUP: "v1-newsletter",
		},
		{
			LOOPS_API_KEY: "x".repeat(32),
			LOOPS_FORM_ID: "bad/form",
			LOOPS_NEWSLETTER_GROUP: "v1-newsletter",
		},
		{
			LOOPS_API_KEY: "x".repeat(32),
			LOOPS_FORM_ID: "form",
			LOOPS_NEWSLETTER_GROUP: "arbitrary-group",
		},
	])("fails closed for missing or invalid Loops configuration", (values) => {
		expect(() => validateNewsletterConfig(values)).toThrow(
			"Newsletter request unavailable",
		);
	});

	test("sends one normalized allowlisted vendor call and returns a bounded response", async () => {
		const ctx = context();
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("authorization")).toBe(
					`Bearer ${config.apiKey}`,
				);
				expect(JSON.parse(String(init?.body))).toEqual({
					email: "person@example.com",
					userGroup: "v1-newsletter",
				});
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				return new Response(
					JSON.stringify({ id: "vendor-secret", data: "ignored" }),
					{
						status: 200,
					},
				);
			},
		);

		await expect(
			executeNewsletterSubscription(ctx, " Person@Example.COM ", {
				config,
				fetch: fetchMock,
			}),
		).resolves.toEqual({ success: true });
		expect(ctx.runMutation).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	test.each([
		[
			"non-2xx",
			vi.fn(async () => new Response("vendor detail", { status: 429 })),
		],
		[
			"timeout",
			vi.fn(async () => {
				throw new DOMException("timed out", "AbortError");
			}),
		],
	])(
		"returns the same generic failure for %s without leaking vendor data",
		async (_name, fetchMock) => {
			await expect(
				executeNewsletterSubscription(context(), "person@example.com", {
					config,
					fetch: fetchMock,
				}),
			).rejects.toThrow("Newsletter request unavailable");
		},
	);

	test("does not call the vendor when persistent admission rejects", async () => {
		const fetchMock = vi.fn();
		const ctx = {
			runMutation: vi.fn(async () => {
				throw new Error("Too many requests");
			}),
		};

		await expect(
			executeNewsletterSubscription(ctx, "person@example.com", {
				config,
				fetch: fetchMock,
			}),
		).rejects.toThrow("Newsletter request unavailable");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
