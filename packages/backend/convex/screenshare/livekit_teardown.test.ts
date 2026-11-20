process.env.LIVEKIT_API_KEY = "test_key_0123456789abcdef0123456789abcdef";
process.env.LIVEKIT_API_SECRET = "test_secret_0123456789abcdef0123456789abcdef0123456789abcdef";

import { convexTest } from "../../testSessions";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RoomServiceClient } from "livekit-server-sdk";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { disableScreenshareSchedulingForTests } from "./lib";

const modules = import.meta.glob(["../**/*.*s", "!../**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

disableScreenshareSchedulingForTests();

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedEndedRoom(t: ReturnType<typeof convexTest>) {
  const { owner, workspaceId } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@teardown.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Teardown",
      ownerId: owner,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });
    return { owner, workspaceId };
  });
  const { code } = await t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, {
    workspaceId,
  });
  await t.withIdentity(as(owner)).mutation(api.screenshare.endRoom, { code });
  return code;
}

async function teardownRow(t: ReturnType<typeof convexTest>, roomCode: string) {
  return t.run((ctx) =>
    ctx.db
      .query("screenshareLiveKitTeardowns")
      .withIndex("by_room", (q) => q.eq("roomCode", roomCode))
      .unique(),
  );
}

describe("durable LiveKit teardown outbox", () => {
  test("records a transient failure and succeeds idempotently on retry", async () => {
    const t = convexTest(schema, modules);
    const roomCode = await seedEndedRoom(t);
    const deleteRoom = vi
      .spyOn(RoomServiceClient.prototype, "deleteRoom")
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(undefined as never);

    await t.action(internal.screenshare.teardownLiveKitRoomAction, { roomCode });
    const failed = await teardownRow(t, roomCode);
    expect(failed).toMatchObject({
      status: "pending",
      attempts: 1,
      failureKind: "transient",
      lastError: "connection reset",
    });
    expect(failed!.nextAttemptAt).toBeGreaterThan(failed!.lastAttemptAt!);

    await t.run((ctx) => ctx.db.patch(failed!._id, { nextAttemptAt: Date.now() - 1 }));
    await t.action(internal.screenshare.teardownLiveKitRoomAction, { roomCode });
    const succeeded = await teardownRow(t, roomCode);
    expect(succeeded).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(succeeded!.completedAt).toBeTypeOf("number");

    await t.action(internal.screenshare.teardownLiveKitRoomAction, { roomCode });
    expect(deleteRoom).toHaveBeenCalledTimes(2);
  });

  test("keeps permanent authentication failures pending and visible", async () => {
    const t = convexTest(schema, modules);
    const roomCode = await seedEndedRoom(t);
    vi.spyOn(RoomServiceClient.prototype, "deleteRoom").mockRejectedValue(
      new Error("401 unauthorized: invalid API key"),
    );

    await t.action(internal.screenshare.teardownLiveKitRoomAction, { roomCode });
    const pending = await teardownRow(t, roomCode);
    expect(pending).toMatchObject({
      status: "pending",
      attempts: 1,
      failureKind: "auth",
      lastError: "401 unauthorized: invalid API key",
    });
    expect(pending!.completedAt).toBeUndefined();
    expect(pending!.nextAttemptAt).toBeGreaterThan(pending!.lastAttemptAt!);
  });
});
