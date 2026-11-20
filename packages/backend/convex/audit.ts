import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getActiveUserId as getAuthUserId } from "./activeSession";
import {
	incrementAnalytics,
	markDailyActiveUser,
	recordSecurityEvent,
} from "./analytics";
import { audit } from "./auditLog";
import { requireDevSeed } from "./devGuard";
import { requireMember } from "./orgs";
import { assertRateLimit } from "./rateLimits";

const CLIENT_EVENT_SCHEMAS = {
	"client.auth.failure": {
		reasons: new Set([
			"credentials_rejected",
			"session_expired",
			"provider_unavailable",
			"rate_limited",
			"unknown",
		]),
		metric: "clientFailures",
		event: "client_failure",
		analyticsReason: "authentication_failed",
	},
	"client.screenshare.failure": {
		reasons: new Set([
			"permission_denied",
			"capture_cancelled",
			"not_supported",
			"connection_failed",
			"timeout",
			"unknown",
		]),
		metric: "clientFailures",
		event: "client_failure",
		analyticsReason: "screenshare_failed",
	},
	"client.shared_browser.failure": {
		reasons: new Set([
			"launch_failed",
			"connection_failed",
			"session_unavailable",
			"timeout",
			"unknown",
		]),
		metric: "clientFailures",
		event: "client_failure",
		analyticsReason: "shared_browser_failed",
	},
	"client.room.failure": {
		reasons: new Set([
			"join_failed",
			"leave_failed",
			"room_unavailable",
			"timeout",
			"unknown",
		]),
		metric: "roomFailures",
		event: "room_failure",
		analyticsReason: "room_end_failed",
	},
} as const;

type ClientAction = keyof typeof CLIENT_EVENT_SCHEMAS;
type SafeClientMeta = {
	reason: string;
	retryable?: boolean;
	attempt?: number;
	elapsedMs?: number;
};

const CLIENT_META_FIELDS = new Set([
	"reason",
	"retryable",
	"attempt",
	"elapsedMs",
]);
const SENSITIVE_META_KEYS = new Set([
	"authorization",
	"annotation",
	"browsercontent",
	"chat",
	"content",
	"cookie",
	"email",
	"exception",
	"ip",
	"message",
	"password",
	"query",
	"rawmessage",
	"sdp",
	"secret",
	"stack",
	"token",
	"url",
	"useragent",
]);
const MAX_CLIENT_META_BYTES = 512;
const MAX_CLIENT_META_DEPTH = 3;
const MAX_CLIENT_META_KEYS = 8;
const MAX_CLIENT_META_ARRAY_LENGTH = 8;
const MAX_CLIENT_META_STRING_LENGTH = 64;
const MAX_CLIENT_ATTEMPT = 10;
const MAX_CLIENT_ELAPSED_MS = 300_000;
const INVALID_CLIENT_EVENT = "Invalid client audit event";

export const CLIENT_AUDIT_RATE_LIMITS = {
	userBurst: { limit: 10, windowMs: 60_000 },
	userHourly: { limit: 120, windowMs: 60 * 60_000 },
	workspaceBurst: { limit: 60, windowMs: 60_000 },
	workspaceHourly: { limit: 600, windowMs: 60 * 60_000 },
} as const;

function invalidClientEvent(): never {
	throw new ConvexError(INVALID_CLIENT_EVENT);
}

function normalizedMetaKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertPlainBoundedJson(
	value: unknown,
	depth = 0,
	ancestors = new Set<object>(),
): void {
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		if (value.length > MAX_CLIENT_META_STRING_LENGTH) invalidClientEvent();
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalidClientEvent();
		return;
	}
	if (typeof value !== "object" || depth > MAX_CLIENT_META_DEPTH) {
		invalidClientEvent();
	}
	if (ancestors.has(value)) invalidClientEvent();

	const isArray = Array.isArray(value);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== (isArray ? Array.prototype : Object.prototype)) {
		invalidClientEvent();
	}

	const descriptors = Object.getOwnPropertyDescriptors(value);
	const names = Object.getOwnPropertyNames(value);
	if (Object.getOwnPropertySymbols(value).length > 0) invalidClientEvent();
	if (isArray) {
		if (value.length > MAX_CLIENT_META_ARRAY_LENGTH) invalidClientEvent();
		const dataKeys = names.filter((name) => name !== "length");
		if (
			dataKeys.length !== value.length ||
			dataKeys.some((name, index) => name !== String(index))
		) {
			invalidClientEvent();
		}
	} else if (names.length > MAX_CLIENT_META_KEYS) {
		invalidClientEvent();
	}

	ancestors.add(value);
	for (const name of names) {
		if (isArray && name === "length") continue;
		const descriptor = descriptors[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
			invalidClientEvent();
		}
		if (name.length > MAX_CLIENT_META_STRING_LENGTH) invalidClientEvent();
		if (SENSITIVE_META_KEYS.has(normalizedMetaKey(name))) invalidClientEvent();
		assertPlainBoundedJson(descriptor.value, depth + 1, ancestors);
	}
	ancestors.delete(value);
}

function isClientAction(action: string): action is ClientAction {
	return Object.prototype.hasOwnProperty.call(CLIENT_EVENT_SCHEMAS, action);
}

export function sanitizeClientEventMetadata(
	action: string,
	meta: unknown,
): SafeClientMeta {
	if (!isClientAction(action)) invalidClientEvent();
	const normalizedMeta = meta ?? {};
	assertPlainBoundedJson(normalizedMeta);
	if (Array.isArray(normalizedMeta) || typeof normalizedMeta !== "object") {
		invalidClientEvent();
	}

	const input = normalizedMeta as Record<string, unknown>;
	if (Object.keys(input).some((key) => !CLIENT_META_FIELDS.has(key))) {
		invalidClientEvent();
	}

	const schema = CLIENT_EVENT_SCHEMAS[action];
	const reason = input.reason ?? "unknown";
	if (
		typeof reason !== "string" ||
		!(schema.reasons as ReadonlySet<string>).has(reason)
	) {
		invalidClientEvent();
	}
	const retryable = input.retryable;
	if (retryable !== undefined && typeof retryable !== "boolean") {
		invalidClientEvent();
	}
	const attempt = input.attempt;
	if (
		attempt !== undefined &&
		(typeof attempt !== "number" ||
			!Number.isInteger(attempt) ||
			attempt < 1 ||
			attempt > MAX_CLIENT_ATTEMPT)
	) {
		invalidClientEvent();
	}
	const elapsedMs = input.elapsedMs;
	if (
		elapsedMs !== undefined &&
		(typeof elapsedMs !== "number" ||
			!Number.isInteger(elapsedMs) ||
			elapsedMs < 0 ||
			elapsedMs > MAX_CLIENT_ELAPSED_MS)
	) {
		invalidClientEvent();
	}

	const sanitized: SafeClientMeta = { reason };
	if (retryable !== undefined) sanitized.retryable = retryable;
	if (attempt !== undefined) sanitized.attempt = attempt;
	if (elapsedMs !== undefined) sanitized.elapsedMs = elapsedMs;
	if (
		new TextEncoder().encode(JSON.stringify(sanitized)).byteLength >
		MAX_CLIENT_META_BYTES
	) {
		invalidClientEvent();
	}
	return sanitized;
}

export function clientAuditRateLimitKey(
	scope: "user" | "workspace",
	id: string,
	window: "burst" | "hourly",
): string {
	return `client_audit:${scope}:${id}:${window}`;
}

async function assertClientAuditRateLimits(
	ctx: Parameters<typeof assertRateLimit>[0],
	userId: string,
	workspaceId?: string,
): Promise<void> {
	await assertRateLimit(
		ctx,
		clientAuditRateLimitKey("user", userId, "burst"),
		CLIENT_AUDIT_RATE_LIMITS.userBurst.limit,
		CLIENT_AUDIT_RATE_LIMITS.userBurst.windowMs,
	);
	await assertRateLimit(
		ctx,
		clientAuditRateLimitKey("user", userId, "hourly"),
		CLIENT_AUDIT_RATE_LIMITS.userHourly.limit,
		CLIENT_AUDIT_RATE_LIMITS.userHourly.windowMs,
	);
	if (!workspaceId) return;
	await assertRateLimit(
		ctx,
		clientAuditRateLimitKey("workspace", workspaceId, "burst"),
		CLIENT_AUDIT_RATE_LIMITS.workspaceBurst.limit,
		CLIENT_AUDIT_RATE_LIMITS.workspaceBurst.windowMs,
	);
	await assertRateLimit(
		ctx,
		clientAuditRateLimitKey("workspace", workspaceId, "hourly"),
		CLIENT_AUDIT_RATE_LIMITS.workspaceHourly.limit,
		CLIENT_AUDIT_RATE_LIMITS.workspaceHourly.windowMs,
	);
}

async function auditClientEvent(
	ctx: Parameters<typeof audit>[0],
	workspaceId: Parameters<typeof audit>[1],
	userId: Parameters<typeof audit>[2],
	action: ClientAction,
	meta: SafeClientMeta,
): Promise<void> {
	await ctx.db.insert("auditLogs", {
		workspaceId,
		userId,
		action,
		meta,
		at: Date.now(),
	});
}

export { audit } from "./auditLog";

/** Internal entry point (explicit userId) — for automation/testing. */
export const record = internalMutation({
	args: {
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		action: v.string(),
		meta: v.optional(v.any()),
	},
	handler: async (ctx, a) => {
		requireDevSeed();
		await audit(ctx, a.workspaceId, a.userId, a.action, a.meta);
	},
});

/** Reactive: the current user's recent audit entries (for the dashboard). */
export const recent = query({
	args: { workspaceId: v.id("workspaces") },
	handler: async (ctx, { workspaceId }) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) return [];
		await requireMember(ctx, userId, workspaceId);
		return ctx.db
			.query("auditLogs")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
			.order("desc")
			.take(50);
	},
});

/** Query full audit trail with category and text filters. */
export const listAuditLogs = query({
	args: {
		workspaceId: v.id("workspaces"),
		category: v.optional(v.string()), // "all" | "auth" | "screenshare" | "rooms" | "security" | "roles"
		search: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not authenticated");
		await requireMember(ctx, userId, args.workspaceId);

		const limit = Math.min(100, Math.max(10, args.limit ?? 50));
		let logs = await ctx.db
			.query("auditLogs")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
			.order("desc")
			.take(150);

		if (args.category && args.category !== "all") {
			logs = logs.filter((l) => {
				if (args.category === "auth") return l.action.startsWith("auth.");
				if (args.category === "screenshare")
					return (
						l.action.startsWith("screenshare.") ||
						l.action.startsWith("participant.")
					);
				if (args.category === "rooms") return l.action.startsWith("room.");
				if (args.category === "security")
					return (
						l.action.includes("denied") ||
						l.action.includes("failed") ||
						l.action.includes("kick") ||
						l.action.includes("lock")
					);
				if (args.category === "roles")
					return (
						l.action.startsWith("role.") ||
						l.action.startsWith("member.") ||
						l.action.startsWith("permission.")
					);
				return true;
			});
		}

		if (args.search) {
			const q = args.search.toLowerCase();
			logs = logs.filter(
				(l) =>
					l.action.toLowerCase().includes(q) ||
					l.actorName?.toLowerCase().includes(q) ||
					l.actorEmail?.toLowerCase().includes(q) ||
					(l.meta && JSON.stringify(l.meta).toLowerCase().includes(q)),
			);
		}

		return logs.slice(0, limit);
	},
});

/** Allows logging a small, fixed set of sanitized client-observable events. */
export const logEvent = mutation({
	args: {
		workspaceId: v.optional(v.id("workspaces")),
		action: v.string(),
		meta: v.optional(v.any()),
	},
	handler: async (ctx, args) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) return false;
		if (args.workspaceId) await requireMember(ctx, userId, args.workspaceId);
		const sanitizedMeta = sanitizeClientEventMetadata(args.action, args.meta);
		await assertClientAuditRateLimits(ctx, userId, args.workspaceId);
		const action = args.action as ClientAction;
		await auditClientEvent(
			ctx,
			args.workspaceId,
			userId,
			action,
			sanitizedMeta,
		);
		if (args.workspaceId) {
			const at = Date.now();
			const analytics = CLIENT_EVENT_SCHEMAS[action];
			await incrementAnalytics(ctx, args.workspaceId, analytics.metric, 1, at);
			await markDailyActiveUser(ctx, args.workspaceId, userId, at);
			await recordSecurityEvent(ctx, {
				workspaceId: args.workspaceId,
				event: analytics.event,
				reason: analytics.analyticsReason,
				outcome: "failed",
				actorKind: "member",
				at,
			});
		}
		return true;
	},
});
