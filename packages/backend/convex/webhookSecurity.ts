import { v } from "convex/values";
import { Webhook } from "standardwebhooks";
import { internalMutation } from "./_generated/server";
import { completeJob } from "./jobs";
import { takeRateLimit } from "./rateLimits";

export function verifyBackendWebhook(body: string, headers: Headers) {
	const secret = process.env.BACKEND_WEBHOOK_SECRET;
	if (!secret || secret.length < 32)
		throw new Error("Webhook is not configured");
	const messageId = headers.get("webhook-id") ?? "";
	if (!/^[a-zA-Z0-9_-]{16,128}$/.test(messageId))
		throw new Error("Invalid webhook");
	const payload = new Webhook(secret, { format: "raw" }).verify(body, {
		"webhook-id": messageId,
		"webhook-timestamp": headers.get("webhook-timestamp") ?? "",
		"webhook-signature": headers.get("webhook-signature") ?? "",
	});
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		throw new Error("Invalid webhook");
	return { payload: payload as Record<string, unknown>, messageId };
}

export const accept = internalMutation({
	args: { messageId: v.string(), payload: v.any() },
	handler: async (ctx, { messageId, payload }) => {
		const previous = await ctx.db
			.query("webhookReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.unique();
		if (previous) return "duplicate" as const;
		if (!(await takeRateLimit(ctx, "webhook:global", 300, 60_000)))
			return "limited" as const;
		if (
			typeof payload.type !== "string" ||
			!/^[a-zA-Z0-9_.-]{1,100}$/.test(payload.type)
		)
			throw new Error("Invalid event type");
		if (payload.type === "job.result") {
			const jobId =
				typeof payload.jobId === "string"
					? ctx.db.normalizeId("jobs", payload.jobId)
					: null;
			const workspaceId =
				typeof payload.workspaceId === "string"
					? ctx.db.normalizeId("workspaces", payload.workspaceId)
					: null;
			const userId =
				typeof payload.userId === "string"
					? ctx.db.normalizeId("users", payload.userId)
					: null;
			if (!jobId || !workspaceId || !userId || typeof payload.kind !== "string")
				throw new Error("Invalid job");
			const job = await ctx.db.get(jobId);
			if (
				!job ||
				job.workspaceId !== workspaceId ||
				job.userId !== userId ||
				job.kind !== payload.kind
			)
				throw new Error("Invalid job");
			if (
				payload.error !== undefined &&
				(typeof payload.error !== "string" || payload.error.length > 1000)
			)
				throw new Error("Invalid error");
			await completeJob(ctx, {
				jobId,
				result: payload.result,
				error: payload.error,
			});
		} else {
			const workspaceId =
				typeof payload.workspaceId === "string"
					? ctx.db.normalizeId("workspaces", payload.workspaceId)
					: null;
			if (!workspaceId || !(await ctx.db.get(workspaceId)))
				throw new Error("Invalid workspace");
			await ctx.db.insert("events", {
				workspaceId,
				source: "backend",
				type: payload.type,
				payload,
				receivedAt: Date.now(),
			});
		}
		await ctx.db.insert("webhookReceipts", {
			messageId,
			expiresAt: Date.now() + 24 * 60 * 60_000,
		});
		const stale = await ctx.db
			.query("webhookReceipts")
			.withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
			.take(50);
		for (const row of stale) await ctx.db.delete(row._id);
		return "accepted" as const;
	},
});
