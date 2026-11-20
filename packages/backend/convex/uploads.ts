import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation } from "./_generated/server";
import { getActiveUserId as getAuthUserId } from "./activeSession";
import { requireMember } from "./orgs";
import { assertRateLimit } from "./rateLimits";
import { randomSecret, sha256 } from "./security";

export const FILE_LIMIT = 10 * 1024 * 1024;
export const AVATAR_LIMIT = 2 * 1024 * 1024;
export const imageTypes = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);
const types = new Set([
	...imageTypes,
	"application/pdf",
	"text/plain",
	"text/csv",
	"application/json",
	"application/zip",
]);

export function validateUpload(
	bytes: Uint8Array,
	declared: string,
	avatar: boolean,
) {
	const type = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (!bytes.length || bytes.length > (avatar ? AVATAR_LIMIT : FILE_LIMIT))
		throw new Error("Invalid file size");
	if (!(avatar ? imageTypes : types).has(type))
		throw new Error("Unsupported file type");
	const starts = (...prefix: number[]) =>
		prefix.every((b, i) => bytes[i] === b);
	const ascii = (start: number, end: number) =>
		String.fromCharCode(...bytes.subarray(start, end));
	const valid =
		type === "image/png"
			? starts(137, 80, 78, 71, 13, 10, 26, 10)
			: type === "image/jpeg"
				? starts(255, 216, 255)
				: type === "image/gif"
					? ["GIF87a", "GIF89a"].includes(ascii(0, 6))
					: type === "image/webp"
						? ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
						: type === "application/pdf"
							? ascii(0, 5) === "%PDF-"
							: type === "application/zip"
								? starts(80, 75, 3, 4) || starts(80, 75, 5, 6)
								: true;
	if (!valid) throw new Error("File signature does not match its type");
	if (type.startsWith("text/") || type === "application/json") {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const hasUnsupportedControlCharacter = Array.from(text).some(
			(character) => {
				const code = character.charCodeAt(0);
				return code < 32 && code !== 9 && code !== 10 && code !== 13;
			},
		);
		if (
			hasUnsupportedControlCharacter ||
			/^\s*(?:<!doctype|<html|<svg|<script)/i.test(text)
		)
			throw new Error("Unsupported text content");
		if (type === "application/json") JSON.parse(text);
	}
	return type;
}

async function registeredUser(ctx: MutationCtx, userId: Id<"users">) {
	const user = await ctx.db.get(userId);
	if (!user || user.isAnonymous) return null;
	const account = await ctx.db
		.query("authAccounts")
		.withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
		.filter((q) => q.neq(q.field("provider"), "anonymous"))
		.first();
	return account ? user : null;
}

export async function requireRegisteredUser(
	ctx: MutationCtx,
	userId: Id<"users">,
) {
	const user = await registeredUser(ctx, userId);
	if (!user) throw new ConvexError("Not authenticated");
	return user;
}

export async function issueUpload(
	ctx: MutationCtx,
	workspaceId?: Id<"workspaces">,
) {
	const userId = await getAuthUserId(ctx);
	const user = userId ? await ctx.db.get(userId) : null;
	if (!userId || !user) throw new ConvexError("Not authenticated");
	if (workspaceId) await requireMember(ctx, userId, workspaceId);
	else await requireRegisteredUser(ctx, userId);
	await assertRateLimit(ctx, `uploads:${userId}`, 10, 60_000);
	const token = randomSecret();
	await ctx.db.insert("uploadTickets", {
		tokenHash: await sha256(token),
		userId,
		workspaceId,
		expiresAt: Date.now() + 5 * 60_000,
	});
	return { url: "/api/uploads", token };
}

export const consume = internalMutation({
	args: { token: v.string() },
	handler: async (ctx, { token }) => {
		if (!/^[a-f0-9]{64}$/.test(token)) return null;
		const hash = await sha256(token);
		const row = await ctx.db
			.query("uploadTickets")
			.withIndex("by_hash", (q) => q.eq("tokenHash", hash))
			.unique();
		if (!row) return null;
		await ctx.db.delete(row._id);
		const user = await ctx.db.get(row.userId);
		if (row.expiresAt <= Date.now() || !user) return null;
		if (row.workspaceId) {
			try {
				await requireMember(ctx, row.userId, row.workspaceId);
			} catch {
				return null;
			}
		} else if (!(await registeredUser(ctx, row.userId))) return null;
		return { userId: row.userId, workspaceId: row.workspaceId };
	},
});

export const register = internalMutation({
	args: {
		storageId: v.id("_storage"),
		userId: v.id("users"),
		workspaceId: v.optional(v.id("workspaces")),
		size: v.number(),
		contentType: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await ctx.db.get(args.userId);
		if (!user) throw new ConvexError("Not authenticated");
		if (args.workspaceId)
			await requireMember(ctx, args.userId, args.workspaceId);
		else await requireRegisteredUser(ctx, args.userId);
		await ctx.db.insert("uploadObjects", {
			...args,
			attached: false,
			createdAt: Date.now(),
		});
	},
});

export async function attachUpload(
	ctx: MutationCtx,
	storageId: Id<"_storage">,
	userId: Id<"users">,
	workspaceId?: Id<"workspaces">,
) {
	const user = await ctx.db.get(userId);
	if (!user) throw new ConvexError("Upload not available");
	if (!workspaceId) await requireRegisteredUser(ctx, userId);
	const upload = await ctx.db
		.query("uploadObjects")
		.withIndex("by_storage", (q) => q.eq("storageId", storageId))
		.unique();
	if (
		!upload ||
		upload.userId !== userId ||
		upload.workspaceId !== workspaceId ||
		upload.attached ||
		upload.createdAt < Date.now() - 60 * 60_000 ||
		(!workspaceId && !imageTypes.has(upload.contentType))
	) {
		throw new ConvexError("Upload not available");
	}
	const metadata = await ctx.db.system.get(storageId);
	if (
		!metadata ||
		metadata.size !== upload.size ||
		(metadata.contentType !== undefined &&
			metadata.contentType !== upload.contentType)
	)
		throw new ConvexError("Upload metadata mismatch");
	await ctx.db.patch(upload._id, { attached: true });
	return upload;
}

export async function validateAttachedAvatar(
	ctx: MutationCtx,
	storageId: Id<"_storage">,
	userId: Id<"users">,
) {
	await requireRegisteredUser(ctx, userId);
	const upload = await ctx.db
		.query("uploadObjects")
		.withIndex("by_storage", (q) => q.eq("storageId", storageId))
		.unique();
	if (
		!upload ||
		upload.userId !== userId ||
		upload.workspaceId !== undefined ||
		!upload.attached ||
		!imageTypes.has(upload.contentType)
	) {
		throw new ConvexError("Upload not available");
	}
	const metadata = await ctx.db.system.get(storageId);
	if (
		!metadata ||
		metadata.size !== upload.size ||
		(metadata.contentType !== undefined &&
			metadata.contentType !== upload.contentType)
	) {
		throw new ConvexError("Upload metadata mismatch");
	}
	return upload;
}

export async function reclaimAvatarUpload(
	ctx: MutationCtx,
	storageId: Id<"_storage">,
	userId: Id<"users">,
) {
	const upload = await ctx.db
		.query("uploadObjects")
		.withIndex("by_storage", (q) => q.eq("storageId", storageId))
		.unique();
	if (
		!upload ||
		upload.userId !== userId ||
		upload.workspaceId !== undefined ||
		!upload.attached ||
		!imageTypes.has(upload.contentType)
	)
		return false;
	const activeReference = await ctx.db
		.query("users")
		.withIndex("by_image_id", (q) => q.eq("imageId", storageId))
		.first();
	if (activeReference) return false;
	const metadata = await ctx.db.system.get(storageId);
	if (
		metadata &&
		(metadata.size !== upload.size ||
			(metadata.contentType !== undefined &&
				metadata.contentType !== upload.contentType))
	) {
		throw new ConvexError("Upload metadata mismatch");
	}
	if (metadata) await ctx.storage.delete(storageId);
	await ctx.db.delete(upload._id);
	return true;
}

export const cleanup = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query("uploadTickets")
			.withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
			.take(100);
		for (const row of expired) await ctx.db.delete(row._id);
		const stale = await ctx.db
			.query("uploadObjects")
			.withIndex("by_attached_created", (q) =>
				q.eq("attached", false).lt("createdAt", Date.now() - 60 * 60_000),
			)
			.take(50);
		for (const row of stale) {
			await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
	},
});
