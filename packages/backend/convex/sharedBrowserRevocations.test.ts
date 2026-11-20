import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";

const secret = "0123456789abcdef0123456789abcdef";
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  vi.resetModules();
});

describe("shared browser revocation delivery", () => {
  test("uses a fresh nonce-bound management signature", async () => {
    process.env.SHARED_BROWSER_GATEWAY_REGISTRY_SECRET = secret;
    process.env.SHARED_BROWSER_GATEWAY_INTERNAL_URL = "http://127.0.0.1:8787";
    const grantId = "grant123";
    const path = `/internal/grants/${grantId}`;
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const timestamp = headers["x-mira-timestamp"]!;
      const nonce = headers["x-mira-nonce"]!;
      expect(nonce).toMatch(/^[a-f0-9]{32}$/);
      expect(headers["x-mira-signature"]).toBe(createHmac("sha256", secret).update(`${timestamp}.${nonce}.DELETE.${path}.`).digest("hex"));
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { deliverSharedBrowserRevocations } = await import("./sharedBrowserRevocations");
    const ctx = {
      runMutation: vi.fn()
        .mockResolvedValueOnce([{ _id: "rev1", grantId }])
        .mockResolvedValueOnce(true),
    };
    const result = await (deliverSharedBrowserRevocations as any)._handler(ctx, {});
    expect(result).toEqual({ delivered: 1, failed: 0, skipped: false });
  });
});
