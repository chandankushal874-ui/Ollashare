import { describe, expect, test } from "vitest";
import { convexTest } from "../testSessions";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { disableScreenshareSchedulingForTests } from "./screenshare/lib";

disableScreenshareSchedulingForTests();
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seedRoom(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const host = await ctx.db.insert("users", { email: "browser-host@test.local" });
    const viewer = await ctx.db.insert("users", { email: "browser-viewer@test.local" });
    const workspaceId = await ctx.db.insert("workspaces", { name: "Browser", ownerId: host, createdAt: Date.now() });
    for (const [userId, role] of [[host, "owner"], [viewer, "member"]] as const) {
      await ctx.db.insert("members", { workspaceId, userId, role, createdAt: Date.now() });
    }
    return { host, viewer, workspaceId };
  }).then(async ({ host, viewer, workspaceId }) => {
    const { code } = await t.withIdentity(as(host)).mutation(api.screenshare.createRoom, { workspaceId });
    await t.withIdentity(as(viewer)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Viewer" });
    return { host, viewer, workspaceId, code };
  });
}

describe("shared browser room controls", () => {
  test("a participant cannot use another room's browser session", async () => {
    const t = convexTest(schema, modules);
    const first = await seedRoom(t);
    const second = await seedRoom(t);
    const started = await t.withIdentity(as(first.host)).mutation(api.sharedBrowser.startSession, { roomCode: first.code });
    await expect(t.withIdentity(as(second.viewer)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId: started.sessionId })).rejects.toThrow();
  });

  test("host session creation is idempotent and a viewer cannot create it", async () => {
    const t = convexTest(schema, modules);
    const { host, viewer, code } = await seedRoom(t);
    await expect(t.withIdentity(as(viewer)).mutation(api.sharedBrowser.startSession, { roomCode: code })).rejects.toThrow("Forbidden");
    const first = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    const retry = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    expect(first.created).toBe(true);
    expect(retry).toEqual({ sessionId: first.sessionId, created: false });
  });

  test("terminated sessions disappear from current lookup and can be reprovisioned", async () => {
    const t = convexTest(schema, modules);
    const { host, viewer, code } = await seedRoom(t);
    const first = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    await t.withIdentity(as(host)).mutation(api.sharedBrowser.terminateSession, { sessionId: first.sessionId });

    expect(await t.withIdentity(as(host)).query(api.sharedBrowser.getSession, { roomCode: code })).toBeNull();
    expect(await t.withIdentity(as(viewer)).query(api.sharedBrowser.getSession, { roomCode: code })).toBeNull();
    await expect(t.withIdentity(as(viewer)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId: first.sessionId })).rejects.toThrow("Shared browser session is not active");

    const second = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    expect(second.created).toBe(true);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await t.run((ctx) => ctx.db.get(first.sessionId)))?.status).toBe("terminated");
    expect((await t.run((ctx) => ctx.db.get(second.sessionId)))?.status).toBe("active");
    expect((await t.run((ctx) => ctx.db.query("sharedBrowserSessions").withIndex("by_room_status", (q) => q.eq("roomCode", code).eq("status", "active")).collect()))).toHaveLength(1);
    expect((await t.withIdentity(as(host)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId: second.sessionId })).mode).toBe("control");
    expect((await t.withIdentity(as(viewer)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId: second.sessionId })).mode).toBe("view");
  });

  test("startSession repairs duplicate active rows deterministically", async () => {
    const t = convexTest(schema, modules);
    const { host, workspaceId, code } = await seedRoom(t);
    const first = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    const duplicate = await t.run((ctx) => ctx.db.insert("sharedBrowserSessions", {
      roomCode: code,
      workspaceId,
      createdBy: host,
      status: "active",
      createdAt: Date.now() + 1,
    }));

    const repaired = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    expect(repaired).toEqual({ sessionId: first.sessionId, created: false });
    expect((await t.run((ctx) => ctx.db.get(duplicate)))?.status).toBe("terminated");
    expect((await t.run((ctx) => ctx.db.query("sharedBrowserSessions").withIndex("by_room_status", (q) => q.eq("roomCode", code).eq("status", "active")).collect()))).toHaveLength(1);
  });

  test("controller acquisition is request-idempotent and host can revoke or grant", async () => {
    const t = convexTest(schema, modules);
    const { host, viewer, code } = await seedRoom(t);
    const { sessionId } = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    await expect(t.withIdentity(as(viewer)).mutation(api.sharedBrowser.acquireController, { sessionId, requestId: "request_1" })).rejects.toThrow("Forbidden");
    const lease = await t.withIdentity(as(host)).mutation(api.sharedBrowser.acquireController, { sessionId, requestId: "request_1" });
    const retry = await t.withIdentity(as(host)).mutation(api.sharedBrowser.acquireController, { sessionId, requestId: "request_1" });
    expect(retry).toEqual(lease);
    await t.withIdentity(as(host)).mutation(api.sharedBrowser.revokeController, { sessionId });
    const granted = await t.withIdentity(as(host)).mutation(api.sharedBrowser.grantController, { sessionId, viewerId: viewer });
    expect(granted.controllerUserId).toBe(viewer);
  });

  test("viewer grants expose metadata only and worker grants cannot survive a kick", async () => {
    const t = convexTest(schema, modules);
    const { host, viewer, code } = await seedRoom(t);
    const { sessionId } = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    const viewerGrant = await t.withIdentity(as(viewer)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId });
    expect(viewerGrant).toMatchObject({ sessionId, roomCode: code, userId: viewer, mode: "view" });
    expect(Object.keys(viewerGrant)).not.toContain("workerToken");
    await t.withIdentity(as(host)).mutation(api.sharedBrowser.grantController, { sessionId, viewerId: viewer });
    const workerGrant = await t.mutation(internal.sharedBrowser.issueWorkerGrant, { sessionId, viewerId: viewer });
    await t.withIdentity(as(host)).mutation(api.screenshare.kickParticipant, { roomCode: code, viewerId: viewer });
    await expect(t.mutation(internal.sharedBrowser.redeemWorkerGrant, { workerToken: workerGrant.workerToken })).rejects.toThrow("Invalid worker grant");
    const revoked = await t.run((ctx) => ctx.db.get(viewerGrant.grantId));
    expect(revoked?.status).toBe("revoked");
    const outbox = await t.run((ctx) => ctx.db.query("sharedBrowserRevocations").collect());
    expect(outbox.some((event) => event.grantId === viewerGrant.grantId && event.reason === "participant-removed")).toBe(true);
  });

  test("room end prevents controller and worker grant issuance", async () => {
    const t = convexTest(schema, modules);
    const { host, viewer, code } = await seedRoom(t);
    const { sessionId } = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    await t.withIdentity(as(host)).mutation(api.screenshare.endRoom, { code });
    await expect(t.withIdentity(as(viewer)).mutation(api.sharedBrowser.acquireController, { sessionId, requestId: "after_end" })).rejects.toThrow("Shared browser session is not active");
    await expect(t.mutation(internal.sharedBrowser.issueWorkerGrant, { sessionId, viewerId: viewer })).rejects.toThrow("Shared browser session is not active");
    const terminated = await t.run((ctx) => ctx.db.get(sessionId));
    expect(terminated?.status).toBe("terminated");
  });

  test("service lookup requires the configured service secret", async () => {
    const previousSecret = process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET;
    const serviceSecret = "A7_jQ2mZ9-xLp4Vr8Nc6Tk3Ws1Hy5Df0";
    process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET = serviceSecret;
    try {
      const t = convexTest(schema, modules);
      const { host, code } = await seedRoom(t);
      await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
      expect(await t.query(api.sharedBrowser.getSessionForServiceWithSecret, { roomCode: code, serviceSecret })).toEqual({ status: "active" });
      await expect(t.query(api.sharedBrowser.getSessionForServiceWithSecret, { roomCode: code, serviceSecret: "B7_jQ2mZ9-xLp4Vr8Nc6Tk3Ws1Hy5Df0" })).rejects.toThrow(/Unauthorized service/);
      await t.withIdentity(as(host)).mutation(api.screenshare.endRoom, { code });
      expect(await t.query(api.sharedBrowser.getSessionForServiceWithSecret, { roomCode: code, serviceSecret })).toBeNull();
    } finally {
      if (previousSecret === undefined) delete process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET;
      else process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET = previousSecret;
    }
  });

  test("revocation outbox claims and delivery acknowledgements are idempotent", async () => {
    const t = convexTest(schema, modules);
    const { host, viewer, code } = await seedRoom(t);
    const { sessionId } = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    const grant = await t.withIdentity(as(viewer)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId });
    await t.withIdentity(as(host)).mutation(api.sharedBrowser.revokeViewerGrant, { sessionId, grantId: grant.grantId });
    await t.withIdentity(as(host)).mutation(api.sharedBrowser.revokeViewerGrant, { sessionId, grantId: grant.grantId });
    expect(await t.run((ctx) => ctx.db.query("sharedBrowserRevocations").collect())).toHaveLength(1);
    const claimed = await t.mutation(internal.sharedBrowser.listPendingRevocations, { claimId: "worker_a" });
    expect(claimed).toHaveLength(1);
    expect(await t.mutation(internal.sharedBrowser.listPendingRevocations, { claimId: "worker_b" })).toHaveLength(0);
    await expect(t.mutation(internal.sharedBrowser.markRevocationDelivered, { revocationId: claimed[0]!._id, claimId: "worker_b" })).rejects.toThrow("claim mismatch");
    expect(await t.mutation(internal.sharedBrowser.markRevocationDelivered, { revocationId: claimed[0]!._id, claimId: "worker_a" })).toBe(true);
    expect(await t.mutation(internal.sharedBrowser.markRevocationDelivered, { revocationId: claimed[0]!._id, claimId: "worker_a" })).toBe(false);
  });

  test("cleanup revokes expired issued grants", async () => {
    const t = convexTest(schema, modules);
    const { host, viewer, code } = await seedRoom(t);
    const { sessionId } = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    const grant = await t.withIdentity(as(viewer)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId });
    await t.run((ctx) => ctx.db.patch(grant.grantId, { expiresAt: Date.now() - 1 }));
    await t.mutation(internal.sharedBrowser.cleanupSharedBrowserData, {});
    expect((await t.run((ctx) => ctx.db.get(grant.grantId)))?.status).toBe("revoked");
    expect((await t.run((ctx) => ctx.db.query("sharedBrowserRevocations").collect()))).toHaveLength(1);
  });

  test("cleanup removes stale delivered grants and expired controllers", async () => {
    const t = convexTest(schema, modules);
    const { host, viewer, code } = await seedRoom(t);
    const { sessionId } = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    const grant = await t.withIdentity(as(viewer)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId });
    await t.withIdentity(as(host)).mutation(api.sharedBrowser.revokeViewerGrant, { sessionId, grantId: grant.grantId });
    const revocation = (await t.run((ctx) => ctx.db.query("sharedBrowserRevocations").collect()))[0]!;
    const controllerId = await t.run((ctx) => ctx.db.insert("sharedBrowserControllers", { sessionId, roomCode: code, userId: viewer, leaseId: "expired", grantedBy: host, createdAt: 1, updatedAt: 1, expiresAt: Date.now() - 1 }));
    await t.run(async (ctx) => {
      await ctx.db.patch(grant.grantId, { expiresAt: Date.now() - 8 * 24 * 60 * 60_000 });
      await ctx.db.patch(revocation._id, { deliveredAt: Date.now() - 8 * 24 * 60 * 60_000 });
    });
    await t.mutation(internal.sharedBrowser.cleanupSharedBrowserData, {});
    expect(await t.run((ctx) => ctx.db.get(grant.grantId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(revocation._id))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(controllerId))).toBeNull();
  });
});
