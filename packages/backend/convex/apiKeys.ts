import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { getActiveUserId as getAuthUserId } from "./activeSession";
import { audit } from "./auditLog";
import { requireDevSeed } from "./devGuard";
import { requireMember } from "./orgs";
import { assertRateLimit, takeRateLimit } from "./rateLimits";

const MAX_ACTIVE_KEYS_PER_USER = 20;
const MAX_KEY_LIST_SIZE = 100;
const MAX_KEY_NAME_LENGTH = 80;
const VERIFY_GLOBAL_LIMIT = 2_000;
const VERIFY_SOURCE_LIMIT = 120;
const VERIFY_WINDOW_MS = 60_000;

function normalizeKeyName(name: string): string {
	const normalized = name.trim();
	if (!normalized || normalized.length > MAX_KEY_NAME_LENGTH) {
		throw new ConvexError("Invalid API key name");
	}
	return normalized;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(s),
	);
	return toHex(new Uint8Array(buf));
}
function genKey(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return `sk_${toHex(bytes)}`;
}

export const store = internalMutation({
	args: {
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		name: v.string(),
		prefix: v.string(),
		hash: v.string(),
	},
	handler: async (ctx, a) => {
		await requireMember(ctx, a.userId, a.workspaceId);
		await assertRateLimit(
			ctx,
			`api_key_create:${a.userId}:${a.workspaceId}`,
			10,
			3600_000,
		);
		const activeKeys = await ctx.db
			.query("apiKeys")
			.withIndex("by_user_workspace", (q) =>
				q.eq("userId", a.userId).eq("workspaceId", a.workspaceId),
			)
			.filter((q) => q.eq(q.field("revoked"), false))
			.take(MAX_ACTIVE_KEYS_PER_USER);
		if (activeKeys.length >= MAX_ACTIVE_KEYS_PER_USER) {
			throw new ConvexError("Too many active API keys");
		}
		const name = normalizeKeyName(a.name);
		const id = await ctx.db.insert("apiKeys", {
			workspaceId: a.workspaceId,
			userId: a.userId,
			name,
			prefix: a.prefix,
			hash: a.hash,
			revoked: false,
			createdAt: Date.now(),
		});
		await audit(ctx, a.workspaceId, a.userId, "apikey.create", { name });
		return id;
	},
});

/** Public: issue a workspace key for the authed user. Plaintext is returned ONCE. */
export const create = action({
	args: { workspaceId: v.id("workspaces"), name: v.string() },
	handler: async (ctx, { workspaceId, name }) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new Error("Not authenticated");
		const key = genKey();
		const normalizedName = normalizeKeyName(name);
		await ctx.runMutation(internal.apiKeys.store, {
			workspaceId,
			userId,
			name: normalizedName,
			prefix: key.slice(0, 11),
			hash: await sha256Hex(key),
		});
		return { key, prefix: key.slice(0, 11) };
	},
});

export const createForUser = internalAction({
	args: {
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		name: v.string(),
	},
	handler: async (ctx, { workspaceId, userId, name }) => {
		requireDevSeed();
		const key = genKey();
		await ctx.runMutation(internal.apiKeys.store, {
			workspaceId,
			userId,
			name,
			prefix: key.slice(0, 11),
			hash: await sha256Hex(key),
		});
		return { key };
	},
});

export const listMine = query({
	args: { workspaceId: v.id("workspaces") },
	handler: async (ctx, { workspaceId }) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) return [];
		await requireMember(ctx, userId, workspaceId);
		const keys = await ctx.db
			.query("apiKeys")
			.withIndex("by_user_workspace", (q) =>
				q.eq("userId", userId).eq("workspaceId", workspaceId),
			)
			.order("desc")
			.take(MAX_KEY_LIST_SIZE);
		return keys.map((k) => ({
			_id: k._id,
			name: k.name,
			prefix: k.prefix,
			revoked: k.revoked,
			createdAt: k.createdAt,
		}));
	},
});

export const revoke = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		id: v.id("apiKeys"),
	},
	handler: async (ctx, { workspaceId, id }) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new Error("Not authenticated");

		// Authorize against the caller-supplied workspace before looking up the key so
		// cross-tenant IDs cannot be used as an existence oracle.
		const membership = await requireMember(ctx, userId, workspaceId);
		const key = await ctx.db.get(id);
		if (!key || key.workspaceId !== workspaceId) {
			throw new ConvexError("API key unavailable");
		}
		if (
			key.userId !== userId &&
			membership.role !== "owner" &&
			membership.role !== "admin"
		) {
			throw new ConvexError("API key unavailable");
		}

		if (!key.revoked) await ctx.db.patch(id, { revoked: true });
		await audit(ctx, workspaceId, userId, "apikey.revoke", { name: key.name });
	},
});

export const admitVerification = internalMutation({
	args: { sourceHash: v.string(), nonceHash: v.string() },
	handler: async (ctx, { sourceHash, nonceHash }) => {
		if (
			!/^[a-f0-9]{64}$/.test(sourceHash) ||
			!/^[a-f0-9]{64}$/.test(nonceHash)
		) {
			return false;
		}
		if (
			!(await takeRateLimit(
				ctx,
				"api_key_verify:global",
				VERIFY_GLOBAL_LIMIT,
				VERIFY_WINDOW_MS,
			))
		) {
			return false;
		}
		if (
			!(await takeRateLimit(
				ctx,
				`api_key_verify:source:${sourceHash}`,
				VERIFY_SOURCE_LIMIT,
				VERIFY_WINDOW_MS,
			))
		) {
			return false;
		}
		return takeRateLimit(
			ctx,
			`api_key_verify:nonce:${nonceHash}`,
			1,
			VERIFY_WINDOW_MS,
		);
	},
});

/** Used by /api/verify-key — resolves a presented key to its user + workspace. */
export const resolveByHash = internalQuery({
	args: { hash: v.string() },
	handler: async (ctx, { hash }) => {
		const k = await ctx.db
			.query("apiKeys")
			.withIndex("by_hash", (q) => q.eq("hash", hash))
			.unique();
		if (!k || k.revoked || !(await ctx.db.get(k.userId))) return null;
		const workspaceId = k.workspaceId;
		if (workspaceId) {
			// Validate current authorization, not only the authorization at issuance.
			const member = await ctx.db
				.query("members")
				.withIndex("by_user_workspace", (q) =>
					q.eq("userId", k.userId).eq("workspaceId", workspaceId),
				)
				.unique();
			if (
				!member ||
				!["owner", "admin", "member"].includes(member.role) ||
				!(await ctx.db.get(workspaceId))
			)
				return null;
		}
		return {
			userId: k.userId,
			workspaceId: k.workspaceId ?? null,
			keyId: k._id,
			name: k.name,
		};
	},
});
