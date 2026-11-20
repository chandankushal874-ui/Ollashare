import Google from "@auth/core/providers/google";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, createAccount } from "@convex-dev/auth/server";
import type { EmailConfig } from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { ResendOTP } from "./ResendOTP";
import { normalizeEmail } from "./emailAddress";
import { withPasswordAccountRecovery } from "./passwordAccountRecovery";
import { ResendOTPReset, ResendOTPVerify } from "./passwordProviders";

const emailDeliveryConfigured = Boolean(process.env.SMTP_HOST);
const passwordEmailVerification = emailDeliveryConfigured
	? (ResendOTPVerify as EmailConfig)
	: undefined;

const passwordProfile = (
	params: Record<string, unknown>,
): { email: string; name: string; isAnonymous: false } => {
	const email = normalizeEmail(params.email);
	const parts = email.split("@");
	const fallbackName = parts.length > 0 && parts[0] ? parts[0] : "User";
	const name: string =
		typeof params.name === "string" && params.name.trim().length > 0
			? params.name
			: fallbackName;
	return {
		email,
		name,
		isAnonymous: false,
	};
};

const PasswordProvider = Password({
	profile: passwordProfile,
	reset: emailDeliveryConfigured ? ResendOTPReset : undefined,
	verify: passwordEmailVerification,
	validatePasswordRequirements: (password: string) => {
		if (password.length < 12) {
			throw new ConvexError("Password must be at least 12 characters.");
		}
	},
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
	providers: [
		withPasswordAccountRecovery(
			PasswordProvider,
			passwordProfile,
			passwordEmailVerification,
		),
		...(emailDeliveryConfigured ? [ResendOTP] : []),
		Google,
		ConvexCredentials({
			id: "anonymous",
			authorize: async (params, ctx) => {
				const roomCode =
					typeof params?.roomCode === "string"
						? params.roomCode.trim().toUpperCase()
						: "";
				const requestSecret =
					typeof params?.requestSecret === "string" ? params.requestSecret : "";
				const guestInviteToken =
					typeof params?.guestInviteToken === "string"
						? params.guestInviteToken
						: "";
				if (!/^MIRA-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(roomCode)) {
					throw new ConvexError("Unable to create guest session");
				}
				const isV2Admission = /^[a-f0-9]{64}$/i.test(requestSecret);
				const isLegacyInvite = /^[a-f0-9]{64}$/i.test(guestInviteToken);
				if (!isV2Admission && !isLegacyInvite)
					throw new ConvexError("Unable to create guest session");
				const { user } = await createAccount(ctx, {
					provider: "anonymous",
					account: { id: crypto.randomUUID() },
					profile: {
						name: "Guest",
						isAnonymous: true,
					},
				});
				const result = isV2Admission
					? await ctx.runMutation(
							makeFunctionReference<"mutation">(
								"security:finalizeAnonymousAdmissionBinding",
							),
							{
								userId: user._id,
								roomCode,
								requestSecret,
							},
						)
					: await ctx.runMutation(
							makeFunctionReference<"mutation">(
								"security:finalizeLegacyAnonymousInviteBinding",
							),
							{
								userId: user._id,
								roomCode,
								guestInviteToken,
							},
						);
				if (!result?.allowed)
					throw new ConvexError("Unable to create guest session");
				return { userId: user._id };
			},
		}),
	],
	signIn: { maxFailedAttempsPerHour: 20 },
	jwt: { durationMs: 5 * 60_000 },
});
