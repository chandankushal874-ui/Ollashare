import {
	createAccount,
	retrieveAccount,
	signInViaProvider,
} from "@convex-dev/auth/server";
import type {
	ConvexCredentialsConfig,
	EmailConfig,
} from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { normalizeEmail } from "./emailAddress";

// Keep SDK hashing, credential checks, and failed-attempt limits. Never recover
// from an email alone: createAccount/retrieveAccount must first verify the secret.
export function withPasswordAccountRecovery(
	base: ConvexCredentialsConfig,
	profile: (params: Record<string, unknown>) => {
		email: string;
		name: string;
		isAnonymous: false;
	},
	verificationProvider?: EmailConfig,
): ConvexCredentialsConfig {
	return {
		...base,
		authorize: async (params, ctx) => {
			const email = normalizeEmail(params.email);
			const normalizedParams = { ...params, email };
			if (params.flow === "email-verification") {
				if (!verificationProvider)
					throw new Error("Email verification is unavailable.");
				if (!email || params.code === undefined)
					throw new Error("Invalid email verification request.");
				const result = await signInViaProvider(ctx, verificationProvider, {
					params: normalizedParams,
				});
				if (!result) throw new Error("Invalid or expired verification code.");
				return result;
			}
			if (params.flow !== "signUp" && params.flow !== "signIn") {
				return base.authorize(normalizedParams, ctx);
			}
			const password = params.password;
			if (
				!email ||
				email.length > 254 ||
				!/^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/.test(email) ||
				typeof password !== "string" ||
				!password ||
				password.length > 256
			) {
				throw new Error("Invalid email or password.");
			}
			if (params.flow === "signUp" && password.length < 12) {
				throw new Error("Password must be at least 12 characters.");
			}
			try {
				// Existing signup IDs are retrieved first so wrong-password signup attempts
				// use the same SDK failed-attempt rate limit as ordinary login.
				const existing =
					params.flow === "signUp"
						? await ctx.runQuery(
								makeFunctionReference<"query">(
									"passwordRecovery:hasPasswordAccount",
								),
								{ email },
							)
						: true;
				const result = existing
					? await retrieveAccount(ctx, {
							provider: "password",
							account: { id: email, secret: password },
						})
					: await createAccount(ctx, {
							provider: "password",
							account: { id: email, secret: password },
							profile: profile(normalizedParams),
							shouldLinkViaEmail: false,
							shouldLinkViaPhone: false,
						});
				if (!result?.account) throw new Error("Invalid credentials");
				if (verificationProvider && !result.account.emailVerified) {
					await signInViaProvider(ctx, verificationProvider, {
						accountId: result.account._id,
						params: normalizedParams,
					});
					return null;
				}
				const userId =
					result.user?._id ??
					((await ctx.runMutation(
						makeFunctionReference<"mutation">(
							"passwordRecovery:recoverVerifiedAccount",
						),
						{
							accountId: result.account._id,
							expectedUserId: result.account.userId,
							emailVerified: Boolean(result.account.emailVerified),
						},
					)) as Id<"users">);
				return { userId };
			} catch {
				// No address, password, token, or raw backend error in diagnostic logs.
				console.warn("[auth] password request rejected");
				throw new Error(
					"Unable to sign in. Check your email and password and try again.",
				);
			}
		},
	};
}
