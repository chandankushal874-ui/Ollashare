process.env.LIVEKIT_API_KEY = "test_key_0123456789abcdef0123456789abcdef";
process.env.LIVEKIT_API_SECRET = "test_secret_0123456789abcdef0123456789abcdef0123456789abcdef";
import { describe, expect, it, vi } from "vitest";
import { RoomServiceClient, TrackSource } from "livekit-server-sdk";
import {
  downgradePublishPermission,
  evictParticipant,
  grantPublishPermission,
  teardownLiveKitRoom,
  getRoomServiceClient,
} from "./livekit_admin";

describe("Issue V2-3 + runtime publish grants: LiveKit SFU admin operations", () => {
  it("initializes RoomServiceClient with default or configured credentials", () => {
    const client = getRoomServiceClient();
    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(RoomServiceClient);
  });

  it("safely handles evictParticipant even if server is offline or participant not in SFU", async () => {
    const result = await evictParticipant("TEST-ROOM", "non-existent-user");
    expect(typeof result.ok).toBe("boolean");
  });

  it("safely handles teardownLiveKitRoom even if server is offline or room not active", async () => {
    // Should never throw, returns boolean (idempotent in LiveKit)
    const result = await teardownLiveKitRoom("TEST-ROOM");
    expect(typeof result.ok).toBe("boolean");
  });

  it("calls removeParticipant with exact roomCode and identity on eviction success", async () => {
    const spy = vi
      .spyOn(RoomServiceClient.prototype, "removeParticipant")
      .mockResolvedValueOnce(undefined as any);

    const success = await evictParticipant("MIRA-ROOM-999", "participant_123");
    expect(success).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("MIRA-ROOM-999", "participant_123");
    spy.mockRestore();
  });

  it("treats an already-absent participant as an idempotent eviction success", async () => {
    const spy = vi
      .spyOn(RoomServiceClient.prototype, "removeParticipant")
      .mockRejectedValueOnce(new Error("participant not found"));

    expect(await evictParticipant("MIRA-ROOM-999", "participant_123")).toEqual({ ok: true });
    spy.mockRestore();
  });

  it("calls deleteRoom with exact roomCode on room teardown success", async () => {
    const spy = vi
      .spyOn(RoomServiceClient.prototype, "deleteRoom")
      .mockResolvedValueOnce(undefined as any);

    const success = await teardownLiveKitRoom("MIRA-ROOM-999");
    expect(success).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("MIRA-ROOM-999");
    spy.mockRestore();
  });

  it("grants publish permission in place via updateParticipant with atomic permission object", async () => {
    const spy = vi
      .spyOn(RoomServiceClient.prototype, "updateParticipant")
      .mockResolvedValueOnce(undefined as any);

    const success = await grantPublishPermission("MIRA-ROOM-999", "guest-1");
    expect(success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("MIRA-ROOM-999", "guest-1", {
      permission: {
        canPublish: true,
        canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
        canSubscribe: true,
        canPublishData: true,
      },
    });
    spy.mockRestore();
  });

  it("downgrades publish permission in place with canPublish false", async () => {
    const spy = vi
      .spyOn(RoomServiceClient.prototype, "updateParticipant")
      .mockResolvedValueOnce(undefined as any);

    const success = await downgradePublishPermission("MIRA-ROOM-999", "guest-1");
    expect(success).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith("MIRA-ROOM-999", "guest-1", {
      permission: {
        canPublish: false,
        canPublishSources: [],
        canSubscribe: true,
        canPublishData: true,
      },
    });
    spy.mockRestore();
  });

  it("returns false without throwing when the publish grant fails (SFU offline or participant absent)", async () => {
    const spy = vi
      .spyOn(RoomServiceClient.prototype, "updateParticipant")
      .mockRejectedValueOnce(new Error("participant not found"));

    const success = await grantPublishPermission("TEST-ROOM", "non-existent-user");
    expect(success).toBe(false);
    spy.mockRestore();
  });
});
