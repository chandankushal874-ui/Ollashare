process.env.LIVEKIT_API_KEY = "test_key_0123456789abcdef0123456789abcdef";
process.env.LIVEKIT_API_SECRET = "test_secret_0123456789abcdef0123456789abcdef0123456789abcdef";

import { convexTest } from "../../testSessions";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RoomServiceClient } from "livekit-server-sdk";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { disableScreenshareSchedulingForTests } from "./lib";
import { liveKitParticipantOperationKey } from "./livekit_participant";

const modules = import.meta.glob(["../**/*.*s", "!../**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

disableScreenshareSchedulingForTests();

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedParticipant(t: ReturnType<typeof convexTest>) {
  const { owner, viewer, workspaceId } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@participant-outbox.test" });
    const viewer = await ctx.db.insert("users", { email: "viewer@participant-outbox.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Participant Outbox",
      ownerId: owner,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId: viewer,
      role: "member",
      createdAt: Date.now(),
    });
    return { owner, viewer, workspaceId };
  });
  const { code } = await t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, {
    workspaceId,
    allowGuestSharing: true,
  });
  await t.withIdentity(as(viewer)).mutation(api.screenshare.joinRoom, {
    roomCode: code,
    name: "Viewer",
  });
  return { code, owner, viewer };
}

async function operationRow(
  t: ReturnType<typeof convexTest>,
  operationKind: "downgrade" | "evict",
  roomCode: string,
  identity: string,
) {
  const operationKey = liveKitParticipantOperationKey(operationKind, roomCode, identity);
  return t.run((ctx) =>
    ctx.db
      .query("screenshareLiveKitParticipantOperations")
      .withIndex("by_key", (q) => q.eq("operationKey", operationKey))
      .unique(),
  );
}

describe("durable LiveKit participant outbox", () => {
  test("transient downgrade failure succeeds on retry", async () => {
    const t = convexTest(schema, modules);
    const { code, viewer } = await seedParticipant(t);
    await t.withIdentity(as(viewer)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: true,
    });
    await t.withIdentity(as(viewer)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: false,
    });
    const updateParticipant = vi
      .spyOn(RoomServiceClient.prototype, "updateParticipant")
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(undefined as never);
    const operationKey = liveKitParticipantOperationKey("downgrade", code, String(viewer));

    await t.action(internal.screenshare.liveKitParticipantOperationAction, { operationKey });
    const failed = await operationRow(t, "downgrade", code, String(viewer));
    expect(failed).toMatchObject({
      status: "pending",
      attempts: 1,
      failureKind: "transient",
      lastError: "connection reset",
    });

    await t.run((ctx) => ctx.db.patch(failed!._id, { nextAttemptAt: Date.now() - 1 }));
    await t.action(internal.screenshare.liveKitParticipantOperationAction, { operationKey });
    expect(await operationRow(t, "downgrade", code, String(viewer))).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
    expect(updateParticipant).toHaveBeenCalledTimes(2);
  });

  test("permanent authentication failure remains pending and visible", async () => {
    const t = convexTest(schema, modules);
    const { code, viewer } = await seedParticipant(t);
    await t.withIdentity(as(viewer)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: false,
    });
    vi.spyOn(RoomServiceClient.prototype, "updateParticipant").mockRejectedValue(
      new Error("401 unauthorized: invalid API key"),
    );

    await t.action(internal.screenshare.liveKitParticipantOperationAction, {
      operationKey: liveKitParticipantOperationKey("downgrade", code, String(viewer)),
    });
    const pending = await operationRow(t, "downgrade", code, String(viewer));
    expect(pending).toMatchObject({
      status: "pending",
      attempts: 1,
      failureKind: "auth",
      lastError: "401 unauthorized: invalid API key",
    });
    expect(pending!.completedAt).toBeUndefined();
  });

  test("eviction delivery is idempotent", async () => {
    const t = convexTest(schema, modules);
    const { code, owner, viewer } = await seedParticipant(t);
    const removeParticipant = vi
      .spyOn(RoomServiceClient.prototype, "removeParticipant")
      .mockResolvedValue(undefined as never);

    await t.withIdentity(as(owner)).mutation(api.screenshare.kickParticipant, {
      roomCode: code,
      viewerId: viewer,
    });
    const operationKey = liveKitParticipantOperationKey("evict", code, String(viewer));
    await t.action(internal.screenshare.liveKitParticipantOperationAction, { operationKey });
    await t.action(internal.screenshare.liveKitParticipantOperationAction, { operationKey });

    expect(await operationRow(t, "evict", code, String(viewer))).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(removeParticipant).toHaveBeenCalledTimes(1);
  });
});
