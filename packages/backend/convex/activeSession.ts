import {
	getAuthSessionId,
	getAuthUserId as sdkUserId,
} from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import type { Auth } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server";

const currentRef = makeFunctionReference<
	"query",
	Record<string, never>,
	Id<"users"> | null
>("activeSession:current");
/** Validate database-backed session state, not merely an unexpired JWT subject. */
export async function getActiveUserId(
	ctx: { auth: Auth } & (Pick<QueryCtx, "db"> | Pick<ActionCtx, "runQuery">),
): Promise<Id<"users"> | null> {
	if (!("db" in ctx)) return ctx.runQuery(currentRef, {});
	const userId = await sdkUserId(ctx);
	const sessionId = await getAuthSessionId(ctx);
	if (!userId || !sessionId) return null;
	let session: Doc<"authSessions"> | null;
	try {
		session = await ctx.db.get(sessionId);
	} catch {
		return null;
	}
	if (
		!session ||
		session.userId !== userId ||
		session.expirationTime <= Date.now()
	)
		return null;
	if (!(await ctx.db.get(userId))) return null;
	const deletion = await ctx.db
		.query("accountDeletionStates")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	if (deletion) return null;
	return userId;
}
export const current = internalQuery({
	args: {},
	handler: (ctx) => getActiveUserId(ctx),
});
