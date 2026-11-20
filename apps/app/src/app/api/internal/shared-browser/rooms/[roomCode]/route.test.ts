import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchQuery = vi.fn();
vi.mock("convex/nextjs", () => ({ fetchQuery }));
vi.mock("convex/server", () => ({ makeFunctionReference: () => "sharedBrowser:getSessionForServiceWithSecret" }));

const secret = "room-authority-route-secret-that-is-long-enough";

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

describe("shared browser room authority route", () => {
  it("accepts a fresh nonce-bound reconciliation request", async () => {
    process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET = secret;
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    fetchQuery.mockResolvedValue({ status: "active" });
    const { GET } = await import("./route");
    const path = "/api/internal/shared-browser/rooms/room-1";
    const response = await GET(request("1700000000000", "roomnonce0000001", path), { params: Promise.resolve({ roomCode: "room-1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: true });
  });

  it("rejects a replayed reconciliation nonce", async () => {
    process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET = secret;
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    fetchQuery.mockResolvedValue({ status: "active" });
    const { GET } = await import("./route");
    const path = "/api/internal/shared-browser/rooms/room-replay";
    const incoming = request("1700000000000", "roomreplaynonce1", path);
    expect((await GET(incoming, { params: Promise.resolve({ roomCode: "room-replay" }) })).status).toBe(200);
    expect((await GET(incoming, { params: Promise.resolve({ roomCode: "room-replay" }) })).status).toBe(401);
  });
});
