import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";

export async function takeRateLimit(
	ctx: MutationCtx,
	key: string,
	limit: number,
	windowMs: number,
): Promise<boolean> {
	const now = Date.now();
	const existing = await ctx.db
		.query("rateLimits")
		.withIndex("by_key", (q) => q.eq("key", key))
		.unique();

	if (existing && existing.resetAt > now && existing.count >= limit)
		return false;
	if (!existing || now >= existing.resetAt) {
		const [kind] = key.split(":");
		if (existing) {
			await ctx.db.patch(existing._id, {
				count: 1,
				resetAt: now + windowMs,
				kind,
			});
		} else {
			await ctx.db.insert("rateLimits", {
				key,
				kind,
				count: 1,
				resetAt: now + windowMs,
			});
		}
		return true;
	}

	await ctx.db.patch(existing._id, { count: existing.count + 1 });
	return true;
}

export async function assertRateLimit(
	ctx: MutationCtx,
	key: string,
	limit: number,
	windowMs: number,
): Promise<void> {
	if (!(await takeRateLimit(ctx, key, limit, windowMs)))
		throw new ConvexError("Too many requests");
}
