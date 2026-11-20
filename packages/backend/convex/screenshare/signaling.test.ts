import { describe, expect, test } from "vitest";
import { validateSignalPayload } from "./signaling";

describe("screenshare signal payload validation", () => {
  test("rejects malformed payloads and bounded identifiers", () => {
    expect(() => validateSignalPayload("offer", "{", "user", false)).toThrow(/Invalid signal payload/);
    expect(() => validateSignalPayload("answer", JSON.stringify({
      deviceId: "x".repeat(161),
      answer: { type: "answer", sdp: "v=0" },
    }), "user", false)).toThrow(/Invalid signal payload/);
  });

  test("derives authenticated ownership and host metadata", () => {
    const payload = validateSignalPayload("offer", JSON.stringify({
      deviceId: "guest-user",
      offer: { type: "offer", sdp: "v=0" },
      device: { id: "guest-user", ownerId: "forged", ownerName: "Forged", isHost: true },
    }), "user", false, { email: "user@example.com" });
    expect(JSON.parse(payload).device).toMatchObject({
      ownerId: "user",
      ownerName: "user@example.com",
      isHost: false,
    });
  });
});
