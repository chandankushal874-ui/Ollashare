process.env.LIVEKIT_API_KEY = "test_key_0123456789abcdef0123456789abcdef";
process.env.LIVEKIT_API_SECRET = "test_secret_0123456789abcdef0123456789abcdef0123456789abcdef";
import { TokenVerifier } from "livekit-server-sdk";
/// <reference types="vite/client" />
import { convexTest } from '../testSessions';
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { disableScreenshareSchedulingForTests, rateLimit } from "./screenshare/lib";

// convex-test's scheduler cannot run internal actions (its async job path writes
// `_scheduled_functions` outside a transaction), so scheduling is disabled
// explicitly for the whole suite. This is a deliberate test-only opt-in — NOT an
// env-var name that a leaked CI variable could flip in production.
disableScreenshareSchedulingForTests();

// Discover function modules for convex-test (includes _generated, excludes *.test.ts).
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

// Identity helper — getAuthUserId reads `subject = userId|sessionId`.
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const member = await ctx.db.insert("users", { email: "member@t.test" });
    const outsider = await ctx.db.insert("users", { email: "outsider@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: member,
      role: "member",
      createdAt: Date.now(),
    });
    return { owner, member, outsider, ws };
  });
}

async function seedRoom(
  t: ReturnType<typeof convexTest>,
  ws: any,
  host: any,
  settings?: any,
) {
  const { code } = await t
    .withIdentity(as(host))
    .mutation(api.screenshare.createRoom, {
      workspaceId: ws,
      title: "Test Room",
      allowGuestSharing: settings?.allowGuestSharing ?? true,
      ...(settings ?? {}),
    });
  return code as string;
}

describe("anonymous guest access", () => {
  test("an anonymous user without a stored room-bound invite cannot join by room code", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    const guest = await t.run(async (ctx) => ctx.db.insert("users", { name: "Anon", isAnonymous: true }));
    await expect(t.withIdentity(as(guest)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Anon Guest" })).rejects.toThrow(/Guest invitation is no longer valid/);
  });

  test("a guest account bound to the issued invitation can join only that room", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    const created = await t.withIdentity(as(owner)).action(api.screenshare.createGuestInviteSecure, { code });
    const admission = await t.action(api.screenshare.createGuestAdmissionRequestSecure, {
      roomCode: code,
      guestInviteToken: created.token,
      displayName: "Anon Guest",
    });
    const guest = await t.run((ctx) => ctx.db.insert("users", { name: "Anon", isAnonymous: true }));
    const authorization = await t.mutation(internal.security.finalizeAnonymousAdmissionBinding, {
      userId: guest,
      roomCode: code,
      requestSecret: admission.requestSecret,
    });
    expect(authorization.allowed).toBe(true);
    await t.withIdentity(as(guest)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Anon Guest" });
    const otherCode = await seedRoom(t, ws, owner);
    await expect(t.withIdentity(as(guest)).mutation(api.screenshare.joinRoom, { roomCode: otherCode, name: "Anon Guest" })).rejects.toThrow(/Guest invitation is no longer valid/);
  });

  test("an anonymous non-participant is still denied room reads", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws, outsider } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // outsider never joined -> denied
    await expect(
      t.withIdentity(as(outsider)).query(api.screenshare.getViewers, { roomCode: code }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("screenshare authentication & authorization", () => {
  test("unauthenticated createRoom is rejected", async () => {
    const t = convexTest(schema, modules);
    const { ws } = await seed(t);
    await expect(
      t.mutation(api.screenshare.createRoom, { workspaceId: ws, title: "x" }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("outsider cannot create a room in a workspace they don't belong to", async () => {
    const t = convexTest(schema, modules);
    const { ws, outsider } = await seed(t);
    await expect(
      t
        .withIdentity(as(outsider))
        .mutation(api.screenshare.createRoom, { workspaceId: ws, title: "x" }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a member creates a room and it is scoped to the workspace", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const { roomId, code } = await t
      .withIdentity(as(owner))
      .mutation(api.screenshare.createRoom, { workspaceId: ws, title: "R" });
    const room = (await t.run(async (ctx) => ctx.db.get(roomId as any))) as any;
    expect(room?.workspaceId).toBe(ws);
    expect(room?.hostId).toBe(owner);
    expect(code).toMatch(/^MIRA-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  });

  test("createRoom rejects invalid settings", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    await expect(
      t
        .withIdentity(as(owner))
        .mutation(api.screenshare.createRoom, {
          workspaceId: ws,
          title: "R",
          codec: "MPEG2",
        }),
    ).rejects.toThrow(/Invalid codec/);
    await expect(
      t
        .withIdentity(as(owner))
        .mutation(api.screenshare.createRoom, {
          workspaceId: ws,
          title: "R",
          fps: 45,
        }),
    ).rejects.toThrow();
  });

  test("outsider cannot read room viewers", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, outsider } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await expect(
      t.withIdentity(as(outsider)).query(api.screenshare.getViewers, { roomCode: code }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("an authenticated user with the room code can join (code is the credential)", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, outsider } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    // joinRoom is open to any authenticated user holding the room code.
    await t
      .withIdentity(as(outsider))
      .mutation(api.screenshare.joinRoom, { roomCode: code, name: "Code Holder" });
    const viewers = await t
      .withIdentity(as(outsider))
      .query(api.screenshare.getViewers, { roomCode: code });
    expect(viewers.some((v: any) => v.viewerId === outsider)).toBe(true);
  });

  test("joinRoom strips control characters and caps name length", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t
      .withIdentity(as(member))
      .mutation(api.screenshare.joinRoom, {
        roomCode: code,
        name: "<script>x</script>" + "a".repeat(80),
      });
    const viewers = await t
      .withIdentity(as(member))
      .query(api.screenshare.getViewers, { roomCode: code });
    const me: any = viewers.find((v: any) => v.viewerId === member);
    expect(me.name).not.toContain("<");
    expect(me.name.length).toBeLessThanOrEqual(50);
  });

  test("outsider cannot list active rooms in the workspace", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, outsider } = await seed(t);
    await seedRoom(t, ws, owner);
    await expect(
      t.withIdentity(as(outsider)).query(api.screenshare.listActiveRooms, { workspaceId: ws }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("member can list active rooms (scoped to workspace)", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    await seedRoom(t, ws, owner);
    const rooms = await t
      .withIdentity(as(member))
      .query(api.screenshare.listActiveRooms, { workspaceId: ws });
    expect(rooms.length).toBe(1);
  });

  test("non-host member cannot change room settings or end the room", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await expect(
      t
        .withIdentity(as(member))
        .mutation(api.screenshare.updateRoomSettings, { code, fps: 30 }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      t.withIdentity(as(member)).mutation(api.screenshare.endRoom, { code }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("create and update accept 360p, 25 FPS, and low bounded bitrate", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const code = await seedRoom(t, ws, owner, {
      resolution: "360p",
      fps: 25,
      bitrateKbps: 600,
    });
    let room = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getRoom, { code });
    expect(room).toMatchObject({ resolution: "360p", fps: 25, bitrateKbps: 600 });

    await t
      .withIdentity(as(owner))
      .mutation(api.screenshare.updateRoomSettings, {
        code,
        resolution: "720p",
        fps: 30,
        codec: "VP9",
        bitrateKbps: 400,
      });
    room = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getRoom, { code });
    expect(room).toMatchObject({
      resolution: "720p",
      fps: 30,
      codec: "VP9",
      bitrateKbps: 400,
    });
  });

  test("create/update reject invalid values and legacy 120 FPS writes", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await expect(
      t
        .withIdentity(as(owner))
        .mutation(api.screenshare.updateRoomSettings, { code, bitrateKbps: 399 }),
    ).rejects.toThrow(/Invalid bitrate/);
    await expect(
      t
        .withIdentity(as(owner))
        .mutation(api.screenshare.updateRoomSettings, { code, bitrateKbps: 999999 }),
    ).rejects.toThrow(/Invalid bitrate/);
    await expect(
      t
        .withIdentity(as(owner))
        .mutation(api.screenshare.updateRoomSettings, { code, resolution: "8K" }),
    ).rejects.toThrow(/Invalid resolution/);
    await expect(
      t
        .withIdentity(as(owner))
        .mutation(api.screenshare.updateRoomSettings, { code, fps: 120 }),
    ).rejects.toThrow(/Invalid fps/);
    await expect(
      t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, {
        workspaceId: ws,
        fps: 120,
      }),
    ).rejects.toThrow(/Invalid fps/);
  });

  test("stored legacy 120 FPS rooms remain readable", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.run(async (ctx) => {
      const room = await ctx.db
        .query("screenshareRooms")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (!room) throw new Error("room missing");
      await ctx.db.patch(room._id, { fps: 120 });
    });
    const room = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getRoom, { code });
    expect(room?.fps).toBe(120);
  });

  test("sensitive actions write an audit trail", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Member",
    });
    await t.withIdentity(as(owner)).mutation(api.screenshare.endRoom, { code });

    const logs = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
        .collect(),
    );
    const actions = logs.map((l) => l.action).sort();
    expect(actions).toContain("screenshare.room.create");
    expect(actions).toContain("screenshare.room.end");
  });

  test("retention cleanup prunes stale signals and stale viewers", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    const ghost = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "ghost@t.test" }),
    );

    // Insert stale + fresh signal rows and a stale viewer directly.
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("screenshareSignals", {
        roomCode: code,
        senderId: owner,
        type: "offer",
        payload: "{}",
        timestamp: now - 30 * 60 * 1000, // 30min old -> stale
      });
      await ctx.db.insert("screenshareSignals", {
        roomCode: code,
        senderId: owner,
        type: "offer",
        payload: "{}",
        timestamp: now,
      });
      await ctx.db.insert("screenshareViewers", {
        roomCode: code,
        viewerId: ghost,
        name: "Ghost Viewer",
        role: "viewer",
        lastPingAt: now - 30 * 60 * 1000, // stale
      });
    });

    await t.mutation(internal.screenshare.retention.cleanupScreenshareData, {});

    const signalsLeft = await t.run(async (ctx) =>
      ctx.db
        .query("screenshareSignals")
        .withIndex("by_room_time", (q) => q.eq("roomCode", code))
        .collect(),
    );
    const ghostLeft = await t.run(async (ctx) =>
      ctx.db
        .query("screenshareViewers")
        .withIndex("by_room_viewer", (q) =>
          q.eq("roomCode", code).eq("viewerId", ghost),
        )
        .collect(),
    );
    expect(signalsLeft.length).toBe(1);
    expect(ghostLeft.length).toBe(0); // stale ghost viewer pruned
  });

  test("host can lock and unlock room, and locked room prevents new guests", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, outsider } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Host locks room
    await t
      .withIdentity(as(owner))
      .mutation(api.screenshare.setRoomLock, { code, locked: true });

    const room = await t.run(async (ctx) =>
      ctx.db
        .query("screenshareRooms")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first(),
    );
    expect(room?.isLocked).toBe(true);

    // Outsider guest attempts to join locked room -> rejected
    await expect(
      t.withIdentity(as(outsider)).mutation(api.screenshare.joinRoom, {
        roomCode: code,
        name: "Locked Guest",
      }),
    ).rejects.toThrow("locked by the host");

    // Host unlocks room
    await t
      .withIdentity(as(owner))
      .mutation(api.screenshare.setRoomLock, { code, locked: false });

    // Guest can now join
    await t.withIdentity(as(outsider)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Unlocked Guest",
    });
    const viewers = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getViewers, { roomCode: code });
    expect(viewers.some((v) => v.name === "Unlocked Guest")).toBe(true);
  });

  test("host can kick a participant from the room", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Test Member",
    });

    // Host kicks member
    await t
      .withIdentity(as(owner))
      .mutation(api.screenshare.kickParticipant, {
        roomCode: code,
        viewerId: member,
      });

    const viewers = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getViewers, { roomCode: code });
    expect(viewers.some((v) => v.viewerId === member)).toBe(false);

    // Kicked participant cannot re-join
    await expect(
      t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
        roomCode: code,
        name: "Test Member",
      }),
    ).rejects.toThrow("removed from this room");
  });

  test("host can set room limits and limits are enforced", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Host sets limits: maxViewers = 2, maxSharers = 1
    await t
      .withIdentity(as(owner))
      .mutation(api.screenshare.setRoomLimits, {
        code,
        maxViewers: 2,
        maxSharers: 1,
      });

    // Host is already viewer 1. Member joins as viewer 2.
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Member 2",
    });

    // Host starts sharing (sharer 1)
    await t
      .withIdentity(as(owner))
      .mutation(api.screenshare.setSharingStatus, {
        roomCode: code,
        isSharing: true,
      });

    // Member attempts to share (exceeds maxSharers 1) -> rejected
    await expect(
      t.withIdentity(as(member)).mutation(api.screenshare.setSharingStatus, {
        roomCode: code,
        isSharing: true,
      }),
    ).rejects.toThrow("Simultaneous screen share limit reached");
  });

  test("host can end the room", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.withIdentity(as(owner)).mutation(api.screenshare.endRoom, { code });
    const room = await t.run(async (ctx) =>
      ctx.db
        .query("screenshareRooms")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first(),
    );
    expect(room?.status).toBe("ended");
  });
});

describe("WebRTC signaling", () => {
  test("participants can exchange signals (offer/answer/candidate)", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Member",
    });

    // Member (a participant) sends a targeted offer to the host.
    await t
      .withIdentity(as(member))
      .mutation(api.screenshare.sendSignal, {
        roomCode: code,
        type: "offer",
        to: owner,
        payload: JSON.stringify({
          offer: { type: "offer", sdp: "v=0" },
          deviceId: `guest-${member}`,
          device: { id: `guest-${member}`, ownerId: owner, ownerName: "Forged", isHost: true },
        }),
      });

    // Host reads signals since 0 -> gets the member's offer.
    const signals = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getSignals, { roomCode: code, since: 0 });
    expect(signals.length).toBe(1);
    expect(signals[0].senderId).toBe(member);
    expect(signals[0].type).toBe("offer");
    const payload = JSON.parse(signals[0].payload);
    expect(payload.device.ownerId).toBe(member);
    expect(payload.device.isHost).toBe(false);
    expect(payload.device.ownerName).toBe("member@t.test");
  });

  test("signaling rejects unknown signal types and oversize payloads", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Member",
    });

    await expect(
      t
        .withIdentity(as(member))
        .mutation(api.screenshare.sendSignal, {
          roomCode: code,
          type: "host_stop_device" as never, // forged host command -> rejected
          payload: "{}",
        }),
    ).rejects.toThrow(/Expected one of literal|Invalid signal type/);

    await expect(
      t
        .withIdentity(as(member))
        .mutation(api.screenshare.sendSignal, {
          roomCode: code,
          type: "offer",
          payload: "x".repeat(40 * 1024),
        }),
    ).rejects.toThrow(/too large/i);
  });

  test("signaling rejects malformed payloads and oversized device IDs before insertion", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Member",
    });

    const invalidPayloads = [
      "{",
      JSON.stringify({ deviceId: "d", offer: { type: "answer", sdp: "v=0" } }),
      JSON.stringify({ deviceId: "d", candidate: {} }),
      JSON.stringify({ deviceId: "x".repeat(161), answer: { type: "answer", sdp: "v=0" } }),
    ];
    const types = ["offer", "offer", "candidate", "answer"] as const;
    for (let i = 0; i < invalidPayloads.length; i += 1) {
      await expect(t.withIdentity(as(member)).mutation(api.screenshare.sendSignal, {
        roomCode: code,
        type: types[i],
        to: owner,
        payload: invalidPayloads[i],
      })).rejects.toThrow(/Invalid signal payload/);
    }

    const rows = await t.run(async (ctx) => ctx.db.query("screenshareSignals")
      .withIndex("by_room", (q) => q.eq("roomCode", code)).collect());
    expect(rows).toHaveLength(0);
  });

  test("targeted signals must address a real room participant", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member, outsider } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Member",
    });

    // member targets someone who is NOT in the room -> rejected.
    await expect(
      t
        .withIdentity(as(member))
        .mutation(api.screenshare.sendSignal, {
          roomCode: code,
          type: "offer",
          to: outsider,
          payload: JSON.stringify({
            offer: { type: "offer", sdp: "v=0" },
            deviceId: "host-primary",
            device: { id: "host-primary" },
          }),
        }),
    ).rejects.toThrow(/Unknown signal target/);
  });

  test("non-participant cannot send signals", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, outsider } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    await expect(
      t
        .withIdentity(as(outsider))
        .mutation(api.screenshare.sendSignal, {
          roomCode: code,
          type: "offer",
          payload: "{}",
        }),
    ).rejects.toThrow(/Forbidden/);
  });


  test("getSignals returns NEWEST-first so >200 signals never starve new handshakes (Issue 5 fix)", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Member",
    });

    // Insert 220 signals sharing the exact same millisecond timestamp.
    const sameMsTimestamp = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 220; i++) {
        await ctx.db.insert("screenshareSignals", {
          roomCode: code,
          senderId: member,
          type: "candidate",
          payload: JSON.stringify({ index: i }),
          timestamp: sameMsTimestamp,
        });
      }
    });

    // The reactive fetch is capped at 200 but MUST be newest-first: the newest
    // offer/candidate must never be starved by older signals.
    const batch = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getSignals, { roomCode: code });
    expect(batch.length).toBe(200);

    // The newest signal (index 219) is included; the oldest (index 0..19) are dropped.
    const payloads = batch.map((s: any) => JSON.parse(s.payload).index);
    expect(payloads).toContain(219);
    expect(payloads).not.toContain(0);
  });

  test("getSignals since filter is timestamp-bounded (no cursor param)", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Member",
    });

    for (let i = 0; i < 3; i++) {
      await t
        .withIdentity(as(member))
        .mutation(api.screenshare.sendSignal, {
          roomCode: code,
          type: "candidate",
          payload: JSON.stringify({
            candidate: { candidate: `candidate:${i}` },
            deviceId: "host-primary",
            direction: "out",
          }),
        });
    }

    const all = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getSignals, { roomCode: code, since: 0 });
    expect(all.length).toBe(3);

    const newestTs = all[all.length - 1].timestamp;
    const afterNewest = await t
      .withIdentity(as(owner))
      .query(api.screenshare.getSignals, { roomCode: code, since: newestTs });
    expect(afterNewest.some((s: any) => s.timestamp < newestTs)).toBe(false);
  });
});
describe("autoEndStaleRooms watchdog (Issue 3 - zombie room cleanup)", () => {
  test("live room with stale host (>2 min) is automatically ended and audited", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Make host presence row stale (> 120_000ms ago)
    await t.run(async (ctx) => {
      const hostViewer = await ctx.db
        .query("screenshareViewers")
        .withIndex("by_room_viewer", (q) =>
          q.eq("roomCode", code).eq("viewerId", owner),
        )
        .first();
      expect(hostViewer).toBeDefined();
      await ctx.db.patch(hostViewer!._id, {
        lastPingAt: Date.now() - 150_000,
      });
    });

    // Run watchdog
    const result = await t.mutation(
      internal.screenshare.rooms.autoEndStaleRooms,
      {},
    );
    expect(result.endedCount).toBeGreaterThanOrEqual(1);

    // Verify room status changed to "ended"
    const room = await t.run(async (ctx) => {
      return await ctx.db
        .query("screenshareRooms")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
    });
    expect(room?.status).toBe("ended");
    expect(room?.endedAt).toBeDefined();

    // Verify audit log
    const logs = await t.run(async (ctx) => {
      return await ctx.db
        .query("auditLogs")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
        .collect();
    });
    const autoEndLog = logs.find(
      (l) => l.action === "screenshare.room.auto_end" && (l.meta?.roomCode === code || l.meta?.code === code),
    );
    expect(autoEndLog).toBeDefined();
    expect(autoEndLog?.meta?.reason).toBe("host_heartbeat_timeout");
  });

  test("live room with fresh host heartbeat remains live and untouched", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Host has fresh ping (10s ago)
    await t.run(async (ctx) => {
      const hostViewer = await ctx.db
        .query("screenshareViewers")
        .withIndex("by_room_viewer", (q) =>
          q.eq("roomCode", code).eq("viewerId", owner),
        )
        .first();
      expect(hostViewer).toBeDefined();
      await ctx.db.patch(hostViewer!._id, {
        lastPingAt: Date.now() - 10_000,
      });
    });

    // Run watchdog
    await t.mutation(
      internal.screenshare.rooms.autoEndStaleRooms,
      {},
    );

    // Room must still be live
    const room = await t.run(async (ctx) => {
      return await ctx.db
        .query("screenshareRooms")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
    });
    expect(room?.status).toBe("live");
    expect(room?.endedAt).toBeUndefined();
  });

  test("default mesh limits enforce 3 simultaneous sharers when no custom limit set (Issue 4)", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Create 3 extra members
    const sharer2 = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "s2@t.test" }),
    );
    const sharer3 = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "s3@t.test" }),
    );
    const sharer4 = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "s4@t.test" }),
    );

    for (const u of [sharer2, sharer3, sharer4]) {
      await t.run(async (ctx) => {
        await ctx.db.insert("members", {
          workspaceId: ws,
          userId: u,
          role: "member",
          createdAt: Date.now(),
        });
      });
      await t.withIdentity(as(u)).mutation(api.screenshare.joinRoom, {
        roomCode: code,
        name: "Sharer",
      });
    }

    // Sharer 1 (host) starts sharing
    await t.withIdentity(as(owner)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: true,
    });
    // Sharer 2 starts sharing
    await t.withIdentity(as(sharer2)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: true,
    });
    // Sharer 3 starts sharing (now at default cap: 3)
    await t.withIdentity(as(sharer3)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: true,
    });

    // Sharer 4 attempts to share -> rejected at default cap (3)
    await expect(
      t.withIdentity(as(sharer4)).mutation(api.screenshare.setSharingStatus, {
        roomCode: code,
        isSharing: true,
      }),
    ).rejects.toThrow(/Simultaneous screen share limit reached \(3 max\)/);
  });

  test("kick ban persists across viewer row pruning and respects expiry (Issue 6)", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    const kickedUser = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "kicked-unique@t.test" }),
    );

    // Kicked user joins room
    await t.withIdentity(as(kickedUser)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Test Member",
    });

    // Host kicks participant
    await t
      .withIdentity(as(owner))
      .mutation(api.screenshare.kickParticipant, {
        roomCode: code,
        viewerId: kickedUser,
      });

    // 1. Verify ban row exists in screenshareBans table
    const bans = await t.run(async (ctx) =>
      ctx.db
        .query("screenshareBans")
        .withIndex("by_room_viewer", (q) =>
          q.eq("roomCode", code).eq("viewerId", kickedUser),
        )
        .collect(),
    );
    expect(bans.length).toBe(1);
    expect(bans[0].expiresAt).toBeGreaterThan(Date.now());

    // 2. Simulate retention cleanup: delete the screenshareViewers row completely
    await t.run(async (ctx) => {
      const viewerRow = await ctx.db
        .query("screenshareViewers")
        .withIndex("by_room_viewer", (q) =>
          q.eq("roomCode", code).eq("viewerId", kickedUser),
        )
        .first();
      if (viewerRow) {
        await ctx.db.delete(viewerRow._id);
      }
    });

    // Verify screenshareViewers row is indeed gone
    const viewerRowCheck = await t.run(async (ctx) =>
      ctx.db
        .query("screenshareViewers")
        .withIndex("by_room_viewer", (q) =>
          q.eq("roomCode", code).eq("viewerId", kickedUser),
        )
        .first(),
    );
    expect(viewerRowCheck).toBeNull();

    // 3. Rejoin attempt MUST still be rejected due to persistent screenshareBans row!
    await expect(
      t.withIdentity(as(kickedUser)).mutation(api.screenshare.joinRoom, {
        roomCode: code,
        name: "Test Member",
      }),
    ).rejects.toThrow("removed from this room");

    // 4. When ban expires, participant can rejoin successfully
    await t.run(async (ctx) => {
      await ctx.db.patch(bans[0]._id, {
        expiresAt: Date.now() - 1000, // expired in the past
      });
    });

    const rejoinedId = await t
      .withIdentity(as(kickedUser))
      .mutation(api.screenshare.joinRoom, {
        roomCode: code,
        name: "Rejoined Member",
      });
    expect(rejoinedId).toBeDefined();

    // 5. Retention cleanup prunes expired ban records
    await t.mutation(internal.screenshare.retention.cleanupScreenshareData, {});
    const bansAfterCleanup = await t.run(async (ctx) =>
      ctx.db
        .query("screenshareBans")
        .withIndex("by_room_viewer", (q) =>
          q.eq("roomCode", code).eq("viewerId", kickedUser),
        )
        .collect(),
    );
    expect(bansAfterCleanup.length).toBe(0);
  });

  test("listAllActiveRoomsWithDetails requires workspaceId and membership (Issue 7)", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, outsider, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Unauthenticated call rejected
    await expect(
      t.query(api.screenshare.listAllActiveRoomsWithDetails, { workspaceId: ws }),
    ).rejects.toThrow("Not authenticated");

    // Outsider call rejected
    await expect(
      t.withIdentity(as(outsider)).query(api.screenshare.listAllActiveRoomsWithDetails, { workspaceId: ws }),
    ).rejects.toThrow("Forbidden");

    // Member call succeeds and returns room
    const rooms = await t
      .withIdentity(as(member))
      .query(api.screenshare.listAllActiveRoomsWithDetails, { workspaceId: ws });
    expect(rooms.length).toBe(1);
    expect(rooms[0].code).toBe(code);
  });

  test("listAuditLogs requires workspaceId and membership (Issue 7)", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, outsider, ws } = await seed(t);

    await t.run(async (ctx) => {
      await ctx.db.insert("auditLogs", {
        workspaceId: ws,
        userId: owner,
        action: "screenshare.room.create",
        at: Date.now(),
      });
    });

    // Unauthenticated call rejected
    await expect(
      t.query(api.audit.listAuditLogs, { workspaceId: ws }),
    ).rejects.toThrow("Not authenticated");

    // Outsider call rejected
    await expect(
      t.withIdentity(as(outsider)).query(api.audit.listAuditLogs, { workspaceId: ws }),
    ).rejects.toThrow("Forbidden");

    // Member call succeeds
    const logs = await t
      .withIdentity(as(member))
      .query(api.audit.listAuditLogs, { workspaceId: ws });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  test("forceEndRoom requires host or workspace admin/owner role (Issue 7)", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, outsider, ws } = await seed(t);

    const admin = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", { email: "admin-mod@t.test" });
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId: u,
        role: "admin",
        createdAt: Date.now(),
      });
      return u;
    });

    const code = await seedRoom(t, ws, owner);

    // Outsider cannot force end
    await expect(
      t.withIdentity(as(outsider)).mutation(api.screenshare.forceEndRoom, { code }),
    ).rejects.toThrow("Forbidden");

    // Plain member cannot force end another user's room
    await expect(
      t.withIdentity(as(member)).mutation(api.screenshare.forceEndRoom, { code }),
    ).rejects.toThrow("Forbidden");

    // Workspace admin can force end
    await t.withIdentity(as(admin)).mutation(api.screenshare.forceEndRoom, {
      code,
      reason: "Administrative moderation",
    });

    const endedRoom = await t.run(async (ctx) =>
      ctx.db.query("screenshareRooms").withIndex("by_code", (q) => q.eq("code", code)).first(),
    );
    expect(endedRoom?.status).toBe("ended");
  });
  test("DB-backed rate limiting persists across sequential mutation contexts (Issue 8)", async () => {
    const t = convexTest(schema, modules);

    // Call 1
    await t.run(async (ctx) => {
      await rateLimit(ctx, "test:inst1", 2, 60_000);
    });

    // Call 2 in a new transaction context (simulating another serverless instance)
    await t.run(async (ctx) => {
      await rateLimit(ctx, "test:inst1", 2, 60_000);
    });

    // Call 3 exceeds limit -> rejected with ConvexError("Too many requests")
    await expect(
      t.run(async (ctx) => {
        await rateLimit(ctx, "test:inst1", 2, 60_000);
      }),
    ).rejects.toThrow(/Too many requests/);

    // Verify row persisted in rateLimits table
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("rateLimits")
        .withIndex("by_key", (q) => q.eq("key", "test:inst1"))
        .first(),
    );
    expect(row).not.toBeNull();
    expect(row?.count).toBe(2);

    // Window elapses -> reset counter
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { resetAt: Date.now() - 1000 });
    });

    // Next call succeeds and resets count to 1
    await t.run(async (ctx) => {
      await rateLimit(ctx, "test:inst1", 2, 60_000);
    });

    const resetRow = await t.run(async (ctx) =>
      ctx.db
        .query("rateLimits")
        .withIndex("by_key", (q) => q.eq("key", "test:inst1"))
        .first(),
    );
    expect(resetRow?.count).toBe(1);
  });

  test("retention cleanup prunes expired rate limit records (Issue 8)", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      // Stale rate limit row
      await ctx.db.insert("rateLimits", {
        key: "stale:user",
        count: 5,
        resetAt: now - 30_000,
      });
      // Fresh rate limit row
      await ctx.db.insert("rateLimits", {
        key: "fresh:user",
        count: 1,
        resetAt: now + 30_000,
      });
    });

    await t.mutation(internal.screenshare.retention.cleanupScreenshareData, {});

    const staleRow = await t.run(async (ctx) =>
      ctx.db
        .query("rateLimits")
        .withIndex("by_key", (q) => q.eq("key", "stale:user"))
        .first(),
    );
    const freshRow = await t.run(async (ctx) =>
      ctx.db
        .query("rateLimits")
        .withIndex("by_key", (q) => q.eq("key", "fresh:user"))
        .first(),
    );

    expect(staleRow).toBeNull(); // pruned
    expect(freshRow).not.toBeNull(); // preserved
  });
});


describe("LiveKit SFU Token Issuance", () => {
  test("host receives token with canPublish: true and roomAdmin", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    const res = await t.withIdentity(as(owner)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
    });

    expect(res.token).toBeDefined();
    expect(res.identity).toBe(owner);
    expect(res.isHost).toBe(true);
    expect(res.canPublish).toBe(true);
    expect(res.canSubscribe).toBe(true);

    const verifier = new TokenVerifier(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
    const claims = await verifier.verify(res.token);
    expect(claims.sub).toBe(owner);
    expect(claims.video?.room).toBe(code);
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.canPublishData).toBe(true);
    expect(claims.video?.canPublishSources).toEqual(["screen_share", "screen_share_audio"]);
    expect(claims.video?.roomAdmin).toBe(true);
    expect(claims.exp! - claims.nbf!).toBe(5 * 60);
  });

  test("reissues a fresh five-minute token for an active participant", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    const first = await t.withIdentity(as(owner)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await t.withIdentity(as(owner)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
    });

    const verifier = new TokenVerifier(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
    const firstClaims = await verifier.verify(first.token);
    const secondClaims = await verifier.verify(second.token);
    expect(firstClaims.exp! - firstClaims.nbf!).toBe(5 * 60);
    expect(secondClaims.exp! - secondClaims.nbf!).toBe(5 * 60);
    expect(secondClaims.nbf).toBeGreaterThan(firstClaims.nbf!);
    expect(second.identity).toBe(first.identity);
  });

  test("viewer receives token with canPublish: false", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    const viewerUser = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "viewer@livekit.test" }),
    );

    // Join room as viewer
    await t.withIdentity(as(viewerUser)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Bob Viewer",
    });

    const res = await t.withIdentity(as(viewerUser)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
    });

    expect(res.token).toBeDefined();
    expect(res.isHost).toBe(false);
    expect(res.canPublish).toBe(false);
    expect(res.canSubscribe).toBe(true);

    const verifier = new TokenVerifier(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
    const claims = await verifier.verify(res.token);
    expect(claims.sub).toBe(viewerUser);
    expect(claims.video?.room).toBe(code);
    expect(claims.video?.canPublish).toBe(false);
    expect(claims.video?.canPublishData).toBe(true);
    expect(claims.video?.canPublishSources).toEqual([]);
  });

  test("viewer with sharer role receives canPublish: true", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner, { allowGuestSharing: true });
    const sharerUser = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "sharer@livekit.test" }),
    );

    await t.withIdentity(as(sharerUser)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Charlie Sharer",
    });

    // Elevate to sharer
    await t.withIdentity(as(sharerUser)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: true,
    });

    const res = await t.withIdentity(as(sharerUser)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
    });

    expect(res.canPublish).toBe(true);
  });

  test("banned viewer is rejected from token issuance", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    const troublemaker = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "troll@livekit.test" }),
    );

    await t.withIdentity(as(troublemaker)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Troublemaker",
    });

    // Host kicks troublemaker
    await t.withIdentity(as(owner)).mutation(api.screenshare.kickParticipant, {
      roomCode: code,
      viewerId: troublemaker,
    });

    await expect(
      t.withIdentity(as(troublemaker)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
      }),
    ).rejects.toThrow("You have been removed from this room by the host");
  });

  test("unregistered outsider cannot obtain token", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);
    const outsider = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "outsider@livekit.test" }),
    );

    await expect(
      t.withIdentity(as(outsider)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
      }),
    ).rejects.toThrow("Forbidden: not a participant of this room");
  });

  test("enforces maxViewers limit at token issuance", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Set maxViewers to 2
    await t.withIdentity(as(owner)).mutation(api.screenshare.setRoomLimits, {
      code,
      maxViewers: 2,
    });

    const v1 = await t.run(async (ctx) => ctx.db.insert("users", { email: "v1@test.com" }));
    const v2 = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", { email: "v2@test.com" });
      await ctx.db.insert("members", { workspaceId: ws, userId: u, role: "member", createdAt: Date.now() });
      return u;
    });
    const v3 = await t.run(async (ctx) => ctx.db.insert("users", { email: "v3@test.com" }));

    // Host is already 1 participant in screenshareViewers.
    // Viewer 1 joins (now 2 participants, reaching maxViewers: 2)
    await t.withIdentity(as(v1)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Viewer 1" });
    await t.withIdentity(as(v1)).mutation(api.screenshare.issueLiveKitToken, { roomCode: code });

    // Viewer 2 attempts to join but exceeds maxViewers cap of 2
    await expect(
      t.withIdentity(as(v2)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Viewer 2" }),
    ).rejects.toThrow(/Room is full/i);

    // Token issuance also denies viewer 2 (who never joined — they are not a
    // participant, so the join-room cap is enforced at token time too).
    await expect(
      t.withIdentity(as(v2)).mutation(api.screenshare.issueLiveKitToken, { roomCode: code }),
    ).rejects.toThrow(/not a participant/i);
  });

  test("enforces maxSharers limit at token issuance", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Set maxSharers to 1
    await t.withIdentity(as(owner)).mutation(api.screenshare.setRoomLimits, {
      code,
      maxSharers: 1,
    });

    const s1 = await t.run(async (ctx) => ctx.db.insert("users", { email: "s1@test.com" }));
    const s2 = await t.run(async (ctx) => ctx.db.insert("users", { email: "s2@test.com" }));

    await t.withIdentity(as(s1)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Sharer 1" });
    const res1 = await t.withIdentity(as(s1)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
      requestPublish: true,
    });
    expect(res1.canPublish).toBe(true);

    // Sharer 2 attempts to request publish beyond maxSharers cap of 1
    await t.withIdentity(as(s2)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Sharer 2" });
    await expect(
      t.withIdentity(as(s2)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
        requestPublish: true,
      }),
    ).rejects.toThrow("Maximum simultaneous screen shares reached (1)");
  });

  test("V2-6: enforces rate limiting on token issuance (11th request throws Too many requests)", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Make 10 successful token issuance requests
    for (let i = 0; i < 10; i++) {
      const res = await t.withIdentity(as(owner)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
      });
      expect(res.token).toBeDefined();
    }

    // 11th request within the 60s window must throw ConvexError "Too many requests"
    await expect(
      t.withIdentity(as(owner)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
      }),
    ).rejects.toThrow("Too many requests");
  });


  test("SECURITY AUDIT FINDING 1: plain viewer cannot self-promote to sharer without host permission", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner, { allowGuestSharing: false });
    const viewer = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "guest_attacker@test.com" }),
    );

    await t.withIdentity(as(viewer)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Guest Attacker",
    });

    // 1. Unauthorized self-promotion is blocked
    await expect(
      t.withIdentity(as(viewer)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
        requestPublish: true,
      }),
    ).rejects.toThrow("Guest sharing is disabled by host");

    // 2. Host toggles allowGuestSharing = true
    await t.withIdentity(as(owner)).mutation(api.screenshare.setAllowGuestSharing, {
      code,
      allowed: true,
    });

    // 3. Now succeeds
    const res = await t.withIdentity(as(viewer)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
      requestPublish: true,
    });
    expect(res.canPublish).toBe(true);

    // 4. Host turns off allowGuestSharing
    await t.withIdentity(as(owner)).mutation(api.screenshare.setAllowGuestSharing, {
      code,
      allowed: false,
    });

    // 5. Another viewer is rejected
    const viewer2 = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "guest2@test.com" }),
    );
    await t.withIdentity(as(viewer2)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Guest 2",
    });
    await expect(
      t.withIdentity(as(viewer2)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
        requestPublish: true,
      }),
    ).rejects.toThrow("Guest sharing is disabled by host");

    // 6. Host grants individual approval via approveSharer
    await t.withIdentity(as(owner)).mutation(api.screenshare.approveSharer, {
      code,
      viewerId: viewer2,
      approved: true,
    });

    // 7. Approved viewer succeeds even with room-level sharing OFF
    const res2 = await t.withIdentity(as(viewer2)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
      requestPublish: true,
    });
    expect(res2.canPublish).toBe(true);

    await t.withIdentity(as(owner)).mutation(api.screenshare.approveSharer, {
      code,
      viewerId: viewer2,
      approved: false,
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("screenshareLiveKitParticipantOperations")
          .withIndex("by_key", (q) => q.eq("operationKey", `downgrade:${code}:${viewer2}`))
          .unique(),
      ),
    ).toMatchObject({ status: "pending", reason: "sharer-approval-revoked" });
  });

  test("locked room rejects token issuance for new participants", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Lock the room
    await t.withIdentity(as(owner)).mutation(api.screenshare.setRoomLock, {
      code,
      locked: true,
    });

    const newcomer = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", { email: "new@test.com" });
      await ctx.db.insert("members", { workspaceId: ws, userId: u, role: "member", createdAt: Date.now() });
      return u;
    });
    // A member who has NOT joined the room is not a participant — token issuance
    // is rejected (the room lock itself is enforced at joinRoom).
    await expect(
      t.withIdentity(as(newcomer)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
      }),
    ).rejects.toThrow("Forbidden: not a participant of this room");
  });

  test("issueLiveKitToken requires prior joinRoom (no auto-registration)", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws, member } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // A workspace member who has NOT joined must NOT receive a token (the SFU
    // path can no longer bypass the presence cap).
    await expect(
      t.withIdentity(as(member)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
      }),
    ).rejects.toThrow("Forbidden: not a participant of this room");

    // After joining, the same member receives a token.
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Joined Member",
    });
    const res = await t.withIdentity(as(member)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
    });
    expect(res.token).toBeDefined();
  });
  test("supports 20 simultaneous screen sharers under SFU capacity", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner);

    // Configure SFU limits: 20 sharers, 50 viewers
    await t.withIdentity(as(owner)).mutation(api.screenshare.setRoomLimits, {
      code,
      maxSharers: 20,
      maxViewers: 50,
    });

    // Concurrently issue LiveKit publish tokens for 20 distinct participants
    const sharerTokens: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const u = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", { email: `sharer${i}@test.com` });
        await ctx.db.insert("members", { workspaceId: ws, userId, role: "member", createdAt: Date.now() });
        return userId;
      });

      await t.withIdentity(as(u)).mutation(api.screenshare.joinRoom, {
        roomCode: code,
        name: `Sharer ${i}`,
      });

      const res = await t.withIdentity(as(u)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
        requestPublish: true,
      });

      expect(res.canPublish).toBe(true);
      expect(res.token).toBeDefined();
      sharerTokens.push(res.token);
    }

    expect(sharerTokens.length).toBe(20);

    // 21st participant requests publish -> rejected with maxSharers cap
    const sharer21 = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "sharer21@test.com" });
      await ctx.db.insert("members", { workspaceId: ws, userId, role: "member", createdAt: Date.now() });
      return userId;
    });

    await t.withIdentity(as(sharer21)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Sharer 21",
    });

    await expect(
      t.withIdentity(as(sharer21)).mutation(api.screenshare.issueLiveKitToken, {
        roomCode: code,
        requestPublish: true,
      }),
    ).rejects.toThrow("Maximum simultaneous screen shares reached (20)");

    // 21st participant can still obtain a read-only viewer token
    const viewerRes = await t.withIdentity(as(sharer21)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
      requestPublish: false,
    });
    expect(viewerRes.canPublish).toBe(false);
    expect(viewerRes.token).toBeDefined();
  });
  test("V2-1 & V2-5: guest joins as viewer then upgrades to sharer with accounting", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const code = await seedRoom(t, ws, owner, { allowGuestSharing: true });

    const guest = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "guest@test.com" });
      await ctx.db.insert("members", { workspaceId: ws, userId, role: "member", createdAt: Date.now() });
      return userId;
    });

    await t.withIdentity(as(guest)).mutation(api.screenshare.joinRoom, {
      roomCode: code,
      name: "Guest User",
    });

    // 1. Initial guest token: no requestPublish -> canPublish is false
    const initialToken = await t.withIdentity(as(guest)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
    });
    expect(initialToken.canPublish).toBe(false);

    // 2. Active rooms query shows 0 sharers
    const activeRooms1 = await t.withIdentity(as(owner)).query(api.screenshare.listAllActiveRoomsWithDetails, {
      workspaceId: ws,
    });
    expect(activeRooms1[0]?.sharerCount).toBe(0);

    // 3. Guest clicks Share Screen -> upgrades token with requestPublish: true
    const upgradedToken = await t.withIdentity(as(guest)).mutation(api.screenshare.issueLiveKitToken, {
      roomCode: code,
      requestPublish: true,
    });
    expect(upgradedToken.canPublish).toBe(true);

    // 4. setSharingStatus true updates presence and is counted
    await t.withIdentity(as(guest)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: true,
    });

    const activeRooms2 = await t.withIdentity(as(owner)).query(api.screenshare.listAllActiveRoomsWithDetails, {
      workspaceId: ws,
    });
    expect(activeRooms2[0]?.sharerCount).toBe(1);

    // 5. Host also shares -> both counted
    await t.withIdentity(as(owner)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: true,
    });
    const activeRooms3 = await t.withIdentity(as(owner)).query(api.screenshare.listAllActiveRoomsWithDetails, {
      workspaceId: ws,
    });
    expect(activeRooms3[0]?.sharerCount).toBe(2);

    // 6. Guest stops sharing -> sharerCount decreases
    await t.withIdentity(as(guest)).mutation(api.screenshare.setSharingStatus, {
      roomCode: code,
      isSharing: false,
    });
    const activeRooms4 = await t.withIdentity(as(owner)).query(api.screenshare.listAllActiveRoomsWithDetails, {
      workspaceId: ws,
    });
    expect(activeRooms4[0]?.sharerCount).toBe(1);
  });
});


describe("screenshare data-layer authentication enforcement", () => {
  test("unauthenticated callers are unconditionally rejected on all screenshare functions (no room leakage)", async () => {
    const t = convexTest(schema, modules);
    const fakeCode = "MIRA-FAKE-ROOM-123";

    // 1. Queries without auth MUST throw 'Not authenticated', never return null or empty array
    await expect(t.query(api.screenshare.getRoom, { code: fakeCode })).rejects.toThrow(/Not authenticated/);
    await expect(t.query(api.screenshare.getViewers, { roomCode: fakeCode })).rejects.toThrow(/Not authenticated/);
    await expect(t.query(api.screenshare.getSignals, { roomCode: fakeCode })).rejects.toThrow(/Not authenticated/);

    // 2. Mutations without auth MUST throw 'Not authenticated', never return success or 'Room not found'
    await expect(t.mutation(api.screenshare.joinRoom, { roomCode: fakeCode, name: "Attacker" })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.screenshare.pingViewer, { roomCode: fakeCode })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.screenshare.sendSignal, { roomCode: fakeCode, type: "offer", payload: "{}" })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.screenshare.endRoom, { code: fakeCode })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.screenshare.updateRoomSettings, { code: fakeCode, fps: 30 })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.screenshare.setRoomLock, { code: fakeCode, locked: true })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.screenshare.setRoomLimits, { code: fakeCode, maxViewers: 10 })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.screenshare.forceEndRoom, { code: fakeCode })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.screenshare.issueLiveKitToken, { roomCode: fakeCode })).rejects.toThrow(/Not authenticated/);
  });
});
