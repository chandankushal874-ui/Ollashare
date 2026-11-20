import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { normalizeEmail } from "./emailAddress";

export const hasPasswordAccount = internalQuery({
	args: { email: v.string() },
	handler: async (ctx, { email }) =>
		(await ctx.db
			.query("authAccounts")
			.withIndex("providerAndAccountId", (q) =>
				q
					.eq("provider", "password")
					.eq("providerAccountId", normalizeEmail(email)),
			)
			.unique()) !== null,
});

// Internal-only. Caller has just passed SDK secret verification. Retain account
// ID and secret hash; do not restore deleted privileges, memberships, or sessions.
export const recoverVerifiedAccount = internalMutation({
	args: {
		accountId: v.id("authAccounts"),
		expectedUserId: v.id("users"),
		emailVerified: v.boolean(),
	},
	handler: async (ctx, { accountId, expectedUserId, emailVerified }) => {
		const account = await ctx.db.get(accountId);
		if (!account || account.provider !== "password" || !account.secret)
			throw new Error("Invalid account");
		const current = await ctx.db.get(account.userId);
		if (current) return current._id;
		if (account.userId !== expectedUserId)
			throw new Error("Account changed; retry sign in");
		const email = normalizeEmail(account.providerAccountId);
		const userId = await ctx.db.insert("users", {
			email,
			name: email.split("@")[0] || "User",
			isAnonymous: false,
			...(emailVerified ? { emailVerificationTime: Date.now() } : {}),
		});
		await ctx.db.patch(accountId, { userId });
		console.info("[auth] recovered password-proven orphan account");
		return userId;
	},
});
