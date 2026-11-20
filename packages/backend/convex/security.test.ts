/// <reference types="vite/client" />
import { convexTest } from '../testSessions';
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { requireMember, requireRole } from "./orgs";
import { disableScreenshareSchedulingForTests, sanitizeDisplayText, sanitizeName } from "./screenshare/lib";

disableScreenshareSchedulingForTests();

// Discover function modules for convex-test (includes _generated, excludes *.test.ts).
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

// Identity helper — getAuthUserId reads `subject = userId|sessionId`.
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test", emailVerificationTime: Date.now() });
    const member = await ctx.db.insert("users", { email: "member@t.test", emailVerificationTime: Date.now() });
    const outsider = await ctx.db.insert("users", { email: "outsider@t.test", emailVerificationTime: Date.now() });
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
    const memberRow = await ctx.db.insert("members", {
      workspaceId: ws,
      userId: member,
      role: "member",
      createdAt: Date.now(),
    });
    return { owner, member, outsider, ws, memberRow };
  });
}

describe("anonymous invite security", () => {
  test("new invitations use the admission lifecycle and persist only hashes", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { code } = await t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    const created = await t.withIdentity(as(owner)).action(api.screenshare.createGuestInviteSecure, { code });
    expect(created.token).toMatch(/^[a-f0-9]{64}$/i);
    const admission = await t.action(api.screenshare.createGuestAdmissionRequestSecure, {
      roomCode: code,
      guestInviteToken: created.token,
      displayName: "Guest",
    });
    const invites = await t.run((ctx) => ctx.db.query("screenshareGuestInvites").withIndex("by_room", (q) => q.eq("roomCode", code)).collect());
    expect(invites).toHaveLength(1);
    expect(invites[0]?.tokenHash).not.toBe(created.token);
    expect(invites[0]?.uses).toBe(0);
    expect(admission.requestSecret).toMatch(/^[a-f0-9]{64}$/i);
    await expect(t.action(api.screenshare.createGuestAdmissionRequestSecure, {
      roomCode: code,
      guestInviteToken: "f".repeat(64),
      displayName: "Guest",
    })).rejects.toThrow(/Invitation could not be verified/);
    await t.run(async (ctx) => ctx.db.patch(created.inviteId, { expiresAt: Date.now() - 1 }));
    await expect(t.action(api.screenshare.createGuestAdmissionRequestSecure, {
      roomCode: code,
      guestInviteToken: created.token,
      displayName: "Guest",
    })).rejects.toThrow(/Invitation could not be verified/);
  });

  test("guest invitations are room-bound, single-generation, and revoked on lock or end", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { code } = await t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    const first = await t.withIdentity(as(owner)).mutation(api.screenshare.createGuestInvite, { code });
    const second = await t.withIdentity(as(owner)).mutation(api.screenshare.createGuestInvite, { code });
    expect((await t.mutation(internal.security.authorizeAnonymousInvite, { roomCode: code, guestInviteToken: first.token })).allowed).toBe(false);
    await t.withIdentity(as(owner)).mutation(api.screenshare.setRoomLock, { code, locked: true });
    expect((await t.mutation(internal.security.authorizeAnonymousInvite, { roomCode: code, guestInviteToken: second.token })).allowed).toBe(false);
    await t.withIdentity(as(owner)).mutation(api.screenshare.setRoomLock, { code, locked: false });
    const third = await t.withIdentity(as(owner)).mutation(api.screenshare.createGuestInvite, { code });
    await t.withIdentity(as(owner)).mutation(api.screenshare.endRoom, { code });
    expect((await t.mutation(internal.security.authorizeAnonymousInvite, { roomCode: code, guestInviteToken: third.token })).allowed).toBe(false);
  });

  test("guest invitations have bounded uses", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { code } = await t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    const created = await t.withIdentity(as(owner)).mutation(api.screenshare.createGuestInvite, { code });
    await t.run(async (ctx) => {
      const invite = await ctx.db.query("screenshareGuestInvites").withIndex("by_room", (q) => q.eq("roomCode", code)).unique();
      if (!invite) throw new Error("Expected invite");
      await ctx.db.patch(invite._id, { uses: invite.maxUses });
    });
    expect((await t.mutation(internal.security.authorizeAnonymousInvite, { roomCode: code, guestInviteToken: created.token })).allowed).toBe(false);
  });

  test("guest invitation redemption cap remains authoritative under concurrent final bindings", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seedWorkspace(t);
    const { code } = await t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    const created = await t.withIdentity(as(owner)).action(api.screenshare.createGuestInviteSecure, { code, maxUses: 2 });
    const requests = await Promise.all(["A", "B", "C"].map((displayName) => t.action(api.screenshare.createGuestAdmissionRequestSecure, {
      roomCode: code,
      guestInviteToken: created.token,
      displayName,
    })));
    const users = await t.run(async (ctx) => Promise.all(requests.map(() => ctx.db.insert("users", { isAnonymous: true }))));
    const attempts = await Promise.all(requests.map((request, index) => {
      const userId = users[index];
      if (!userId) throw new Error("Expected guest identity");
      return t.mutation(
        internal.security.finalizeAnonymousAdmissionBinding,
        { userId, roomCode: code, requestSecret: request.requestSecret },
      );
    }));
    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(2);
    expect((await t.run((ctx) => ctx.db.get(created.inviteId)))?.uses).toBe(2);
  });

  test("only authorized hosts can mint or revoke guest invitations", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seedWorkspace(t);
    const { code } = await t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    await expect(t.withIdentity(as(member)).mutation(api.screenshare.createGuestInvite, { code })).rejects.toThrow(/Forbidden/);
    const created = await t.withIdentity(as(owner)).mutation(api.screenshare.createGuestInvite, { code });
    await expect(t.withIdentity(as(member)).mutation(api.screenshare.revokeGuestInvites, { code })).rejects.toThrow(/Forbidden/);
    await t.withIdentity(as(owner)).mutation(api.screenshare.revokeGuestInvites, { code });
    expect((await t.mutation(internal.security.authorizeAnonymousInvite, { roomCode: code, guestInviteToken: created.token })).allowed).toBe(false);
  });
});

describe("display text spoofing defenses", () => {
  test("removes bidi controls and zero-width format characters from names and chat", () => {
    expect(sanitizeName("Alice\u202Evil\u200B\u2066")).toBe("Alicevil");
    expect(sanitizeDisplayText("hello\u200Dworld\u2069", 2000)).toBe("helloworld");
  });

  test("normalizes compatibility characters before enforcing length", () => {
    expect(sanitizeName("Ａｌｉｃｅ")).toBe("Alice");
  });
});

describe("authorization helpers", () => {
  test("requireMember throws for a non-member", async () => {
    const t = convexTest(schema, modules);
    const { ws, outsider, member } = await seedWorkspace(t);
    await t.run(async (ctx) => {
      await expect(requireMember(ctx, member, ws)).resolves.toBeTruthy();
      await expect(requireMember(ctx, outsider, ws)).rejects.toThrow(/Forbidden/);
    });
  });

  test("requireRole(owner) rejects a plain member", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seedWorkspace(t);
    await t.run(async (ctx) => {
      await expect(requireRole(ctx, owner, ws, ["owner"])).resolves.toBeTruthy();
      await expect(requireRole(ctx, member, ws, ["owner"])).rejects.toThrow(/Forbidden/);
    });
  });
});

describe("member management (RBAC + integrity)", () => {
  test("removeMember refuses to remove the owner", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seedWorkspace(t);
    const ownerMemberRow = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("members")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
          .collect()
      ).find((m) => m.role === "owner")?._id,
    );
    await expect(
      t
        .withIdentity(as(owner))
        .mutation(api.orgs.removeMember, { workspaceId: ws, memberId: ownerMemberRow! }),
    ).rejects.toThrow(/owner/i);
  });

  test("a plain member cannot remove anyone", async () => {
    const t = convexTest(schema, modules);
    const { ws, member, memberRow } = await seedWorkspace(t);
    await expect(
      t
        .withIdentity(as(member))
        .mutation(api.orgs.removeMember, { workspaceId: ws, memberId: memberRow }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("removing a room host ends their rooms and revokes host authority", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member, memberRow } = await seedWorkspace(t);
    const { code } = await t.withIdentity(as(member)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    const session = await t.withIdentity(as(member)).mutation(api.sharedBrowser.startSession, { roomCode: code });

    await t.withIdentity(as(owner)).mutation(api.orgs.removeMember, { workspaceId: ws, memberId: memberRow });

    expect((await t.run((ctx) => ctx.db.query("screenshareRooms").withIndex("by_code", (q) => q.eq("code", code)).unique()))?.status).toBe("ended");
    expect((await t.run((ctx) => ctx.db.get(session.sessionId)))?.status).toBe("terminated");
    await expect(t.withIdentity(as(member)).mutation(api.screenshare.updateRoomSettings, { code, resolution: "720p" })).rejects.toThrow(/Forbidden/);
    await expect(t.withIdentity(as(member)).mutation(api.screenshare.issueLiveKitToken, { roomCode: code })).rejects.toThrow();
  });

  test('anonymous account cleanup durably enqueues LiveKit eviction before removal', async () => {
    const t = convexTest(schema, modules);
    const { userId, roomCode } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', { email: 'old-guest@test.invalid', isAnonymous: true });
      const ownerId = await ctx.db.insert('users', { email: 'guest-owner@test.invalid' });
      const workspaceId = await ctx.db.insert('workspaces', { ownerId, name: 'Guest cleanup', createdAt: Date.now() });
      const roomCode = 'MIRA-ANO-DEL-001';
      await ctx.db.insert('screenshareRooms', {
        code: roomCode,
        workspaceId,
        title: 'Ended guest room',
        hostId: ownerId,
        hostName: 'Owner',
        status: 'ended',
        resolution: '1080p',
        fps: 60,
        bitrateKbps: 8000,
        codec: 'H.264',
        audioEnabled: true,
        startedAt: Date.now() - 2 * 24 * 60 * 60_000,
        endedAt: Date.now() - 24 * 60 * 60_000,
      });
      await ctx.db.insert('screenshareViewers', { roomCode, viewerId: userId, name: 'Guest', role: 'viewer', lastPingAt: 0 });
      return { userId, roomCode };
    });

    const now = Date.now();
    vi.setSystemTime(now + 2 * 24 * 60 * 60_000);
    let operation: unknown;
    try {
      await t.mutation(internal.security.cleanupAnonymousIdentities, {});
      operation = await t.run((ctx) => ctx.db.query('screenshareLiveKitParticipantOperations').withIndex('by_key', (q) => q.eq('operationKey', `evict:${roomCode}:${userId}`)).unique());
    } finally {
      vi.useRealTimers();
    }
    expect(await t.run((ctx) => ctx.db.get(userId))).toBeNull();
    expect(operation).toMatchObject({
      status: 'pending',
      reason: 'anonymous-account-removal',
    });
  });

  test("removing a room participant revokes browser grants and annotation access", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member, memberRow } = await seedWorkspace(t);
    const { code } = await t.withIdentity(as(owner)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    await t.withIdentity(as(owner)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Owner" });
    await t.withIdentity(as(member)).mutation(api.screenshare.joinRoom, { roomCode: code, name: "Member" });
    const session = await t.withIdentity(as(owner)).mutation(api.sharedBrowser.startSession, { roomCode: code });
    await t.withIdentity(as(owner)).mutation(api.sharedBrowser.grantController, { sessionId: session.sessionId, viewerId: member });
    const grant = await t.withIdentity(as(member)).mutation(api.sharedBrowser.issueViewerGrant, { sessionId: session.sessionId, requestControl: false });
    await t.withIdentity(as(owner)).mutation(api.screenshare.grantAnnotation, {
      roomCode: code,
      viewerId: member,
      targetKind: "shared-browser",
      targetId: String(session.sessionId),
    });

    await t.withIdentity(as(owner)).mutation(api.orgs.removeMember, { workspaceId: ws, memberId: memberRow });

    expect((await t.run((ctx) => ctx.db.get(grant.grantId)))?.status).toBe("revoked");
    expect(await t.run((ctx) => ctx.db.query("sharedBrowserControllers").withIndex("by_session_user", (q) => q.eq("sessionId", session.sessionId).eq("userId", member)).collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("sharedBrowserRevocations").withIndex("by_grant", (q) => q.eq("grantId", grant.grantId)).first()))?.reason).toBe("participant-removed");
    expect(await t.run((ctx) => ctx.db.query("screenshareAnnotationPermissions").withIndex("by_room_user", (q) => q.eq("roomCode", code).eq("userId", member)).collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("screenshareLiveKitParticipantOperations").withIndex("by_key", (q) => q.eq("operationKey", `evict:${code}:${member}`)).unique())).toMatchObject({
      status: "pending",
      reason: "workspace-membership-removed",
    });
  });

  test("changeRole rejects promotion to owner and bad roles", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, memberRow } = await seedWorkspace(t);
    const asOwner = t.withIdentity(as(owner));
    await expect(
      asOwner.mutation(api.orgs.changeRole, { workspaceId: ws, memberId: memberRow, role: "owner" }),
    ).rejects.toThrow(/Invalid role/);
    await expect(
      asOwner.mutation(api.orgs.changeRole, { workspaceId: ws, memberId: memberRow, role: "superuser" }),
    ).rejects.toThrow(/Invalid role/);
    await asOwner.mutation(api.orgs.changeRole, { workspaceId: ws, memberId: memberRow, role: "admin" });
    const role = await t.run(async (ctx) => (await ctx.db.get(memberRow))?.role);
    expect(role).toBe("admin");
  });
});

describe("cross-tenant isolation (IDOR)", () => {
  test("an outsider cannot read another workspace's jobs", async () => {
    const t = convexTest(schema, modules);
    const { ws, outsider } = await seedWorkspace(t);
    await expect(
      t.withIdentity(as(outsider)).query(api.jobs.list, { workspaceId: ws }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("unauthenticated reads return empty, not an error", async () => {
    const t = convexTest(schema, modules);
    const { ws } = await seedWorkspace(t);
    expect(await t.query(api.jobs.list, { workspaceId: ws })).toEqual([]);
  });
});

describe("jobs.complete idempotency (webhook replay defense)", () => {
  test("completing an already-finished job is a no-op", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seedWorkspace(t);
    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        workspaceId: ws,
        userId: owner,
        kind: "demo",
        status: "done",
        result: { first: true },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.mutation(internal.jobs.complete, { jobId, result: { second: true } });
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.result).toEqual({ first: true });
    expect(job?.status).toBe("done");
  });
});

describe("API key authorization and bounds", () => {
  test("members only list and revoke their own keys while admins can revoke any key", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seedWorkspace(t);
    const admin = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "admin@t.test", emailVerificationTime: Date.now() });
      await ctx.db.insert("members", { workspaceId: ws, userId, role: "admin", createdAt: Date.now() });
      return userId;
    });
    const ownerKey = await t.run((ctx) => ctx.db.insert("apiKeys", {
      workspaceId: ws,
      userId: owner,
      name: "owner key",
      prefix: "sk_owner",
      hash: "owner-hash",
      revoked: false,
      createdAt: Date.now(),
    }));
    await t.run((ctx) => ctx.db.insert("apiKeys", {
      workspaceId: ws,
      userId: member,
      name: "member key",
      prefix: "sk_member",
      hash: "member-hash",
      revoked: false,
      createdAt: Date.now(),
    }));

    const memberKeys = await t.withIdentity(as(member)).query(api.apiKeys.listMine, { workspaceId: ws });
    expect(memberKeys.map((key) => key.name)).toEqual(["member key"]);
    await expect(
      t.withIdentity(as(member)).mutation(api.apiKeys.revoke, { workspaceId: ws, id: ownerKey }),
    ).rejects.toThrow(/API key unavailable/);
    await t.withIdentity(as(admin)).mutation(api.apiKeys.revoke, { workspaceId: ws, id: ownerKey });
    expect((await t.run((ctx) => ctx.db.get(ownerKey)))?.revoked).toBe(true);
  });

  test("API key creation is bounded by active-key count", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seedWorkspace(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i += 1) {
        await ctx.db.insert("apiKeys", {
          workspaceId: ws,
          userId: owner,
          name: `key-${i}`,
          prefix: `sk_${i}`,
          hash: `hash-${i}`,
          revoked: false,
          createdAt: Date.now() + i,
        });
      }
    });
    await expect(t.withIdentity(as(owner)).action(api.apiKeys.create, { workspaceId: ws, name: "overflow" })).rejects.toThrow(/Too many active API keys/);
  });
});

describe("workspace invitation lifecycle", () => {
  test("suppresses duplicate pending invites and rejects expired or revoked invites", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member } = await seedWorkspace(t);
    const ownerCaller = t.withIdentity(as(owner));
    const inviteId = await ownerCaller.mutation(api.orgs.invite, { workspaceId: ws, email: "member@t.test", role: "member" });
    await expect(ownerCaller.mutation(api.orgs.invite, { workspaceId: ws, email: " MEMBER@T.TEST ", role: "member" })).rejects.toThrow(/already pending/);
    await ownerCaller.mutation(api.orgs.revokeInvite, { inviteId });
    await expect(t.withIdentity(as(member)).mutation(api.orgs.acceptInvite, { inviteId })).rejects.toThrow(/Verified email required/);

    const expired = await t.run((ctx) => ctx.db.insert("invites", {
      workspaceId: ws,
      email: "member@t.test",
      role: "member",
      invitedBy: owner,
      accepted: false,
      expiresAt: Date.now() - 1,
      createdAt: Date.now() - 1000,
    }));
    await expect(t.withIdentity(as(member)).mutation(api.orgs.acceptInvite, { inviteId: expired })).rejects.toThrow(/Verified email required/);
  });

  test("pending invite lists are bounded and exclude expired invitations", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seedWorkspace(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 120; i += 1) {
        await ctx.db.insert("invites", {
          workspaceId: ws,
          email: `invite-${i}@t.test`,
          role: "member",
          invitedBy: owner,
          accepted: false,
          expiresAt: i === 119 ? Date.now() - 1 : Date.now() + 60_000,
          createdAt: Date.now() + i,
        });
      }
    });
    const invites = await t.withIdentity(as(owner)).query(api.orgs.pendingInvites, { workspaceId: ws });
    expect(invites.length).toBeLessThanOrEqual(100);
    expect(invites.every((invite) => (invite.expiresAt ?? 0) > Date.now())).toBe(true);
  });

  test("re-inviting clears membership revocation without reviving old API keys", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner, member, memberRow } = await seedWorkspace(t);
    const oldKey = await t.run((ctx) => ctx.db.insert("apiKeys", {
      workspaceId: ws,
      userId: member,
      name: "old",
      prefix: "sk_old",
      hash: "old-hash",
      revoked: false,
      createdAt: Date.now(),
    }));
    await t.withIdentity(as(owner)).mutation(api.orgs.removeMember, { workspaceId: ws, memberId: memberRow });
    const inviteId = await t.withIdentity(as(owner)).mutation(api.orgs.invite, { workspaceId: ws, email: "member@t.test", role: "member" });
    await t.run((ctx) => ctx.db.insert("authAccounts", { userId: member, provider: "resend-otp", providerAccountId: "member@t.test", emailVerified: "member@t.test" }));
    await t.withIdentity(as(member)).mutation(api.orgs.acceptInvite, { inviteId });
    expect(await t.run((ctx) => ctx.db.query("workspaceRevocations").withIndex("by_workspace_user", (q) => q.eq("workspaceId", ws).eq("userId", member)).unique())).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(oldKey)))?.revoked).toBe(true);
    const room = await t.withIdentity(as(member)).mutation(api.screenshare.createRoom, { workspaceId: ws });
    await expect(t.withIdentity(as(member)).mutation(api.screenshare.updateRoomSettings, { code: room.code, resolution: "720p" })).resolves.toBeDefined();
  });
});

describe("jobs pagination bounds", () => {
  test("clamps oversized and non-positive page sizes", async () => {
    const t = convexTest(schema, modules);
    const { ws, owner } = await seedWorkspace(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 105; i += 1) {
        await ctx.db.insert("jobs", {
          workspaceId: ws,
          userId: owner,
          kind: "test",
          status: "done",
          createdAt: Date.now() + i,
          updatedAt: Date.now() + i,
        });
      }
    });
    const caller = t.withIdentity(as(owner));
    expect((await caller.query(api.jobs.listPaged, { workspaceId: ws, paginationOpts: { numItems: 10000, cursor: null } })).page).toHaveLength(100);
    expect((await caller.query(api.jobs.listPaged, { workspaceId: ws, paginationOpts: { numItems: 0, cursor: null } })).page).toHaveLength(1);
  });
});

describe("client audit event integrity", () => {
  test("rejects server-looking actions, arbitrary metadata, and bursts", async () => {
    const t = convexTest(schema, modules);
    const { ws, member } = await seedWorkspace(t);
    const caller = t.withIdentity(as(member));
    await expect(caller.mutation(api.audit.logEvent, { workspaceId: ws, action: "member.remove", meta: {} })).rejects.toThrow(/Invalid client audit event/);
    await expect(caller.mutation(api.audit.logEvent, { workspaceId: ws, action: "client.auth.failure", meta: { detail: "x".repeat(5000) } })).rejects.toThrow(/Invalid client audit event/);
    for (let i = 0; i < 10; i += 1) {
      await caller.mutation(api.audit.logEvent, {
        workspaceId: ws,
        action: "client.auth.failure",
        meta: { reason: "unknown", attempt: (i % 10) + 1 },
      });
    }
    await expect(caller.mutation(api.audit.logEvent, {
      workspaceId: ws,
      action: "client.auth.failure",
      meta: { reason: "unknown" },
    })).rejects.toThrow(/Too many requests/);
  });
});

// Full IDOR matrix: an authenticated outsider must be denied on EVERY workspace-scoped
// surface. This is the in-process, CI-runnable equivalent of the live p2-idor suite.
describe("cross-tenant isolation matrix (outsider vs workspace)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous fn table for a test matrix
  const cases: Array<[string, (b: any, ws: any) => Promise<unknown>]> = [
    ["jobs.list", (b, ws) => b.query(api.jobs.list, { workspaceId: ws })],
    [
      "jobs.listPaged",
      (b, ws) =>
        b.query(api.jobs.listPaged, {
          workspaceId: ws,
          paginationOpts: { numItems: 5, cursor: null },
        }),
    ],
    ["jobs.create", (b, ws) => b.mutation(api.jobs.create, { workspaceId: ws, kind: "demo", input: {} })],
    ["apiKeys.listMine", (b, ws) => b.query(api.apiKeys.listMine, { workspaceId: ws })],
    ["apiKeys.create", (b, ws) => b.action(api.apiKeys.create, { workspaceId: ws, name: "x" })],
    ["orgs.members", (b, ws) => b.query(api.orgs.members, { workspaceId: ws })],
    ["orgs.invite", (b, ws) => b.mutation(api.orgs.invite, { workspaceId: ws, email: "x@x.test", role: "member" })],
    ["orgs.pendingInvites", (b, ws) => b.query(api.orgs.pendingInvites, { workspaceId: ws })],
    ["usage.mine", (b, ws) => b.query(api.usage.mine, { workspaceId: ws })],
    ["audit.recent", (b, ws) => b.query(api.audit.recent, { workspaceId: ws })],
    ["files.list", (b, ws) => b.query(api.files.list, { workspaceId: ws })],
    ["files.listPaged", (b, ws) => b.query(api.files.listPaged, { workspaceId: ws, paginationOpts: { numItems: 5, cursor: null } })],
    ["files.generateUploadUrl", (b, ws) => b.mutation(api.files.generateUploadUrl, { workspaceId: ws })],
  ];
  for (const [name, call] of cases) {
    test(`outsider is denied: ${name}`, async () => {
      const t = convexTest(schema, modules);
      const { ws, outsider } = await seedWorkspace(t);
      await expect(call(t.withIdentity(as(outsider)), ws)).rejects.toThrow();
    });
  }
});

describe("maintained counters (dashboard.stats stays O(1) + correct)", () => {
  test("create workspace/job + complete keeps counters accurate", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "c@t.test" }));
    const u = t.withIdentity(as(userId));

    const ws = await u.mutation(api.orgs.createWorkspace, { name: "Core" });
    let s = await u.query(api.dashboard.stats, { workspaceId: ws });
    expect(s?.members).toBe(1); // owner
    expect(s?.jobs).toBe(0);

    await u.mutation(api.jobs.create, { workspaceId: ws, kind: "demo", input: {} });
    s = await u.query(api.dashboard.stats, { workspaceId: ws });
    expect(s?.jobs).toBe(1);
    expect(s?.openJobs).toBe(1);

    const jobId = await t.run(async (ctx) => {
      const j = await ctx.db
        .query("jobs")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
        .first();
      if (!j) throw new Error("job not found");
      return j._id;
    });
    await t.mutation(internal.jobs.complete, { jobId, result: { ok: true } });
    s = await u.query(api.dashboard.stats, { workspaceId: ws });
    expect(s?.openJobs).toBe(0); // left the open set
    expect(s?.jobs).toBe(1); // total unchanged
  });
});
