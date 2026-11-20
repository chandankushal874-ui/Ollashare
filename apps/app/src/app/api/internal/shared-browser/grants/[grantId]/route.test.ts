import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchQuery = vi.fn();
vi.mock("convex/nextjs", () => ({ fetchQuery }));
vi.mock("convex/server", () => ({ makeFunctionReference: () => "sharedBrowser:validateGatewayGrant" }));

const secret = "authority-route-secret-that-is-long-enough";

const request = (timestamp: string, nonce: string, path: string) => {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.GET.${path}`).digest("hex");
  return new Request(`http://localhost${path}`, { headers: { "x-mira-timestamp": timestamp, "x-mira-nonce": nonce, "x-mira-signature": signature } });
};

afterEach(() => {
  fetchQuery.mockReset();
  vi.restoreAllMocks();
  process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET = undefined;
  process.env.CONVEX_INTERNAL_URL = undefined;
});

describe("shared browser grant authority route", () => {
  it("returns the canonical sessionId contract", async () => {
    process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET = secret;
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    fetchQuery.mockResolvedValue({ active: true, roomCode: "room-1", sessionId: "session-1", mode: "view", expiresAt: 1700000300000 });
    const { GET } = await import("./route");
    const path = "/api/internal/shared-browser/grants/grant-12345678";
    const response = await GET(request("1700000000000", "canonicalnonce0001", path), { params: Promise.resolve({ grantId: "grant-12345678" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: true, roomCode: "room-1", sessionId: "session-1", mode: "view", expiresAt: 1700000300000 });
  });

  it("rejects replayed authority nonces", async () => {
    process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET = secret;
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    fetchQuery.mockResolvedValue({ active: false });
    const { GET } = await import("./route");
    const path = "/api/internal/shared-browser/grants/grant-replay1";
    const first = await GET(request("1700000000000", "replaynonce000001", path), { params: Promise.resolve({ grantId: "grant-replay1" }) });
    const second = await GET(request("1700000000000", "replaynonce000001", path), { params: Promise.resolve({ grantId: "grant-replay1" }) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });
});
