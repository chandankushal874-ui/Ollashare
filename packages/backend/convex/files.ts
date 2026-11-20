import { getActiveUserId as getAuthUserId } from './activeSession';
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { audit } from "./auditLog";
import { bump } from "./counters";
import { requireMember } from "./orgs";
import { requireRole } from './orgs';
import { attachUpload, issueUpload } from './uploads';
import { assertRateLimit } from './rateLimits';

/** Files module — workspace-scoped uploads backed by Convex file storage. */

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
]);

export const generateUploadUrl = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await requireMember(ctx, userId, workspaceId);
    return issueUpload(ctx, workspaceId);
  },
});

export const saveFile = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
  },
  handler: async (ctx, a) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await requireMember(ctx, userId, a.workspaceId);
    const upload = await attachUpload(ctx, a.storageId, userId, a.workspaceId);
    if (!Number.isSafeInteger(a.size) || a.size !== upload.size || a.contentType !== upload.contentType || a.size <= 0 || a.size > MAX_FILE_SIZE) {
      throw new Error("Invalid file size");
    }
    if (!ALLOWED_CONTENT_TYPES.has(a.contentType)) {
      throw new Error("Unsupported file type");
    }
    const name = a.name
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 200);
    if (!name) throw new Error("Invalid file name");
    const id = await ctx.db.insert("files", {
      workspaceId: a.workspaceId,
      userId,
      name,
      storageId: a.storageId,
      size: a.size,
      contentType: a.contentType,
      createdAt: Date.now(),
    });
    await assertRateLimit(ctx, `files:${userId}`, 20, 60_000);
    await audit(ctx, a.workspaceId, userId, "file.upload", { fileId: id });
    await bump(ctx, a.workspaceId, "files", 1);
    return id;
  },
});

export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    await requireMember(ctx, userId, workspaceId);
    const rows = await ctx.db
      .query("files")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(100);
    return Promise.all(
      rows.map(async (f) => ({
        _id: f._id,
        name: f.name,
        size: f.size,
        contentType: f.contentType,
        createdAt: f.createdAt,
        url: `/api/files/${f._id}`,
      })),
    );
  },
});

export const listPaged = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { workspaceId, paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    await requireMember(ctx, userId, workspaceId);
    const res = await ctx.db
      .query("files")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .paginate({ ...paginationOpts, numItems: Math.max(1, Math.min(100, paginationOpts.numItems)) });
    return {
      ...res,
      page: await Promise.all(
        res.page.map(async (f) => ({
          _id: f._id,
          name: f.name,
          size: f.size,
          contentType: f.contentType,
          createdAt: f.createdAt,
          url: `/api/files/${f._id}`,
        })),
      ),
    };
  },
});

export const remove = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const f = await ctx.db.get(fileId);
    if (!f) throw new Error("Not found");
    await requireMember(ctx, userId, f.workspaceId);
    if (f.userId !== userId) await requireRole(ctx, userId, f.workspaceId, ['owner', 'admin']);
    await ctx.storage.delete(f.storageId);
    await ctx.db.delete(fileId);
    await audit(ctx, f.workspaceId, userId, "file.delete", { name: f.name });
    await bump(ctx, f.workspaceId, "files", -1);
  },
});

export const download = internalQuery({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error('Not authenticated');
    const file = await ctx.db.get(fileId);
    if (!file) throw new Error('Not found');
    await requireMember(ctx, userId, file.workspaceId);
    return { name: file.name, contentType: file.contentType, storageId: file.storageId };
  },
});
