/// <reference types="vite/client" />
import { convexTest } from "../testSessions";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { disableScreenshareSchedulingForTests } from "./screenshare/lib";

disableScreenshareSchedulingForTests();
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const host = await ctx.db.insert("users", { email: "host@test" });
    const guest = await ctx.db.insert("users", { email: "guest@test" });
    const other = await ctx.db.insert("users", { email: "other@test" });
    const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: host, createdAt: Date.now() });
    await ctx.db.insert("members", { workspaceId: ws, userId: host, role: "owner", createdAt: Date.now() });
    await ctx.db.insert("members", { workspaceId: ws, userId: guest, role: "member", createdAt: Date.now() });
    return { host, guest, other, ws };
  });
  const room = await t.withIdentity(as(ids.host)).mutation(api.screenshare.createRoom, { workspaceId: ids.ws, allowGuestSharing: false });
  await t.withIdentity(as(ids.guest)).mutation(api.screenshare.joinRoom, { roomCode: room.code, name: "Guest" });
  return { t, ...ids, code: room.code };
}

describe("authoritative annotation permissions", () => {
  test("guest is denied by default and host can grant/revoke", async () => {
    const { t, host, guest, code } = await setup();
    const denied = await t.withIdentity(as(guest)).query(api.screenshare.getAnnotationPermission, { roomCode: code, targetKind: "screen", targetId: code });
    expect(denied.allowed).toBe(false);
    await expect(t.withIdentity(as(guest)).mutation(api.screenshare.grantAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen", targetId: code })).rejects.toThrow(/Forbidden/);
    await t.withIdentity(as(host)).mutation(api.screenshare.grantAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen", targetId: code });
    expect((await t.withIdentity(as(guest)).query(api.screenshare.getAnnotationPermission, { roomCode: code, targetKind: "screen", targetId: code })).allowed).toBe(true);
    await t.withIdentity(as(host)).mutation(api.screenshare.revokeAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen", targetId: code });
    expect((await t.withIdentity(as(guest)).query(api.screenshare.getAnnotationPermission, { roomCode: code, targetKind: "screen", targetId: code })).allowed).toBe(false);
  });

  test("every active participant receives the target-scoped authoritative ACL", async () => {
    const { t, host, guest, other, code } = await setup();
    await t.withIdentity(as(other)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Other" });
    await t.withIdentity(as(host)).mutation(api.screenshare.grantAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen" });

    const otherSnapshot = await t.withIdentity(as(other)).query(api.screenshare.getAnnotationPermission, { roomCode: code, targetKind: "screen" });
    expect(otherSnapshot.allowed).toBe(false);
    expect(otherSnapshot.participantIds).toEqual([guest]);

    await t.withIdentity(as(host)).mutation(api.screenshare.revokeAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen" });
    expect((await t.withIdentity(as(other)).query(api.screenshare.getAnnotationPermission, { roomCode: code, targetKind: "screen" })).participantIds).toEqual([]);
  });

  test("permissions do not cross rooms and cleanup on kick/end", async () => {
    const { t, host, guest, ws, code } = await setup();
    await t.withIdentity(as(host)).mutation(api.screenshare.grantAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen", targetId: code });
    const second = await t.withIdentity(as(host)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    await t.withIdentity(as(guest)).mutation(api.screenshare.joinRoom, { roomCode: second.code, name: "Guest" });
    expect((await t.withIdentity(as(guest)).query(api.screenshare.getAnnotationPermission, { roomCode: second.code, targetKind: "screen", targetId: second.code })).allowed).toBe(false);
    await t.withIdentity(as(host)).mutation(api.screenshare.kickParticipant, { roomCode: code, viewerId: guest, durationMs: 0 });
    await expect(t.withIdentity(as(guest)).query(api.screenshare.getAnnotationPermission, { roomCode: code, targetKind: "screen", targetId: code })).rejects.toThrow(/removed/);
    await t.withIdentity(as(host)).mutation(api.screenshare.grantAnnotation, { roomCode: second.code, viewerId: guest, targetKind: "screen", targetId: second.code });
    await t.withIdentity(as(host)).mutation(api.screenshare.endRoom, { code: second.code });
    const ended = await t.run(async (ctx) => ctx.db.query("screenshareAnnotationPermissions").withIndex("by_room_user", (q) => q.eq("roomCode", second.code).eq("userId", guest)).collect());
    expect(ended).toHaveLength(0);
  });

  test("host is always allowed for valid targets while invalid shared-browser targets fail closed", async () => {
    const { t, host, code } = await setup();
    await expect(t.withIdentity(as(host)).query(api.screenshare.getAnnotationPermission, { roomCode: code, targetKind: "shared-browser", targetId: "missing" })).rejects.toThrow(/not active/);
    expect((await t.withIdentity(as(host)).query(api.screenshare.getAnnotationPermission, { roomCode: code, targetKind: "screen", targetId: code })).allowed).toBe(true);
  });

  test("authorizes every event at mutation time and rejects stale guest access", async () => {
    const { t, host, guest, code } = await setup();
    await expect(t.withIdentity(as(guest)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "track-1",
      operations: [{ kind: "stroke", strokeId: "guest-1", color: "#2563eb", width: 4, points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }],
    })).rejects.toThrow(/permission/i);

    await t.withIdentity(as(host)).mutation(api.screenshare.grantAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen" });
    const first = await t.withIdentity(as(guest)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "track-1",
      operations: [{ kind: "stroke", strokeId: "guest-1", color: "#2563eb", width: 4, points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }],
    });
    expect(first.firstSequence).toBe(1);

    await t.withIdentity(as(host)).mutation(api.screenshare.revokeAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen" });
    await expect(t.withIdentity(as(guest)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "track-1",
      operations: [{ kind: "clear", scope: "own" }],
    })).rejects.toThrow(/permission/i);
    const events = await t.withIdentity(as(host)).query(api.screenshare.listAnnotationEvents, {
      roomCode: code,
      targets: [{ targetKind: "screen", targetId: "track-1" }],
    });
    expect(events.filter((event) => event.targetKind === "screen" && event.targetId === "track-1")).toHaveLength(1);
  });

  test("enforces ownership, host clear-all, target binding, sequence and cleanup", async () => {
    const { t, host, guest, code } = await setup();
    const started = await t.withIdentity(as(host)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    await t.withIdentity(as(host)).mutation(api.screenshare.grantAnnotation, { roomCode: code, viewerId: guest, targetKind: "shared-browser", targetId: started.sessionId });
    await t.withIdentity(as(host)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "shared-browser",
      targetId: started.sessionId,
      operations: [{ kind: "stroke", strokeId: "host-stroke", color: "#ef4444", width: 2, points: [{ u: 0.1, v: 0.1 }, { u: 0.2, v: 0.2 }] }],
    });
    await expect(t.withIdentity(as(guest)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "shared-browser",
      targetId: started.sessionId,
      operations: [{ kind: "erase", strokeId: "host-stroke" }],
    })).rejects.toThrow(/another participant/i);
    await expect(t.withIdentity(as(guest)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "shared-browser",
      targetId: started.sessionId,
      operations: [{ kind: "clear", scope: "all" }],
    })).rejects.toThrow(/host/i);
    const result = await t.withIdentity(as(host)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "shared-browser",
      targetId: started.sessionId,
      operations: [{ kind: "clear", scope: "all" }],
    });
    expect(result.lastSequence).toBe(2);
    await t.run(async (ctx) => {
      const events = await ctx.db.query("screenshareAnnotationEvents").collect();
      for (const event of events) await ctx.db.patch(event._id, { expiresAt: Date.now() - 1 });
    });
    expect((await t.mutation(internal.screenshare.cleanupAnnotationEvents, {})).deleted).toBeGreaterThan(0);
  });

  test("persists pen and highlighter styles while rejecting malformed style metadata", async () => {
    const { t, host, code } = await setup();
    const result = await t.withIdentity(as(host)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "host-primary",
      operations: [
        { kind: "stroke", strokeId: "legacy-pen", color: "#2563eb", width: 4, points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] },
        { kind: "stroke", strokeId: "highlight-1", color: "#f59e0b", width: 8, tool: "highlighter", opacity: 0.35, points: [{ u: 0.1, v: 0.2 }, { u: 0.8, v: 0.9 }] },
      ],
    });
    expect(result.events).toMatchObject([
      { strokeId: "legacy-pen", tool: "pen", opacity: 1 },
      { strokeId: "highlight-1", tool: "highlighter", opacity: 0.35 },
    ]);
    const replay = await t.withIdentity(as(host)).query(api.screenshare.listAnnotationEvents, {
      roomCode: code,
      targets: [{ targetKind: "screen", targetId: "host-primary" }],
    });
    expect(replay).toMatchObject([
      { strokeId: "legacy-pen", tool: "pen", opacity: 1 },
      { strokeId: "highlight-1", tool: "highlighter", opacity: 0.35 },
    ]);
    await expect(t.withIdentity(as(host)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "host-primary",
      operations: [{ kind: "stroke", strokeId: "bad-highlight", color: "#f59e0b", width: 8, tool: "highlighter", opacity: 0.9, points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }],
    })).rejects.toThrow(/opacity/i);
    await expect(t.withIdentity(as(host)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "host-primary",
      operations: [{ kind: "stroke", strokeId: "bad-pen", color: "#f59e0b", width: 4, tool: "pen", opacity: 0.35, points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }],
    })).rejects.toThrow(/pen opacity/i);
    await expect(t.withIdentity(as(host)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "host-primary",
      operations: [{ kind: "stroke", strokeId: "bad-tool", color: "#f59e0b", width: 4, tool: "marker" as never, points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }],
    })).rejects.toThrow();
  });

  test("returns newest retained events for every requested target beyond 500 aggregate events", async () => {
    const { t, host, code } = await setup();
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 600; index += 1) {
        const targetId = index % 2 === 0 ? "host-primary" : "guest-screen";
        await ctx.db.insert("screenshareAnnotationEvents", {
          roomCode: code,
          targetKind: "screen",
          targetId,
          sequence: index + 1,
          kind: "stroke",
          actorId: String(host),
          actorName: "Host",
          strokeId: `${targetId}-${index}`,
          color: "#2563eb",
          width: 2,
          tool: "pen",
          opacity: 1,
          points: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
          createdAt: now + index,
          expiresAt: now + 60_000,
        });
      }
    });
    const events = await t.withIdentity(as(host)).query(api.screenshare.listAnnotationEvents, {
      roomCode: code,
      targets: [
        { targetKind: "screen", targetId: "host-primary" },
        { targetKind: "screen", targetId: "guest-screen" },
      ],
    });
    expect(events).toHaveLength(600);
    expect(events[0]?.sequence).toBe(1);
    expect(events.at(-1)?.sequence).toBe(600);
    expect(events.filter((event) => event.targetId === "host-primary")).toHaveLength(300);
    expect(events.filter((event) => event.targetId === "guest-screen")).toHaveLength(300);
  });

  test("rejects duplicate, excessive, and malformed active target lists", async () => {
    const { t, host, code } = await setup();
    await expect(t.withIdentity(as(host)).query(api.screenshare.listAnnotationEvents, {
      roomCode: code,
      targets: [
        { targetKind: "screen", targetId: "host-primary" },
        { targetKind: "screen", targetId: "host-primary" },
      ],
    })).rejects.toThrow(/duplicate/i);
    await expect(t.withIdentity(as(host)).query(api.screenshare.listAnnotationEvents, {
      roomCode: code,
      targets: Array.from({ length: 5 }, (_, index) => ({ targetKind: "screen" as const, targetId: `screen-${index}` })),
    })).rejects.toThrow(/target list/i);
    await expect(t.withIdentity(as(host)).query(api.screenshare.listAnnotationEvents, {
      roomCode: code,
      targets: [{ targetKind: "screen", targetId: "invalid target" }],
    })).rejects.toThrow(/invalid annotation target/i);
  });

  test("replays erase and guest-own versus host-all clear authoritatively", async () => {
    const { t, host, guest, code } = await setup();
    await t.withIdentity(as(host)).mutation(api.screenshare.grantAnnotation, { roomCode: code, viewerId: guest, targetKind: "screen" });
    await t.withIdentity(as(host)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "host-primary",
      operations: [{ kind: "stroke", strokeId: "host-1", color: "#ef4444", width: 2, points: [{ u: 0, v: 0 }, { u: 1, v: 1 }] }],
    });
    await t.withIdentity(as(guest)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "host-primary",
      operations: [
        { kind: "stroke", strokeId: "guest-1", color: "#22c55e", width: 4, tool: "highlighter", opacity: 0.35, points: [{ u: 0, v: 1 }, { u: 1, v: 0 }] },
        { kind: "clear", scope: "own" },
      ],
    });
    await t.withIdentity(as(host)).mutation(api.screenshare.appendAnnotationEvents, {
      roomCode: code,
      targetKind: "screen",
      targetId: "host-primary",
      operations: [{ kind: "erase", strokeId: "host-1" }, { kind: "clear", scope: "all" }],
    });
    const events = await t.withIdentity(as(guest)).query(api.screenshare.listAnnotationEvents, {
      roomCode: code,
      targets: [{ targetKind: "screen", targetId: "host-primary" }],
    });
    expect(events.map((event) => event.kind)).toEqual(["stroke", "stroke", "clear", "erase", "clear"]);
  });
});
