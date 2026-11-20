import { Email } from "@convex-dev/auth/providers/Email";
import { internal } from "./_generated/api";
import { generateNumericOtp } from "./otp";

// Email providers for password-reset and email-verification codes.
// Codes are delivered only through the configured mail action and are never logged.

type Ctx = { runAction: (ref: unknown, args: unknown) => Promise<unknown> };

async function send(
	ctx: Ctx | undefined,
	label: string,
	email: string,
	token: string,
) {
	if (!ctx) throw new Error("Email delivery unavailable");
	try {
		await ctx.runAction(internal.email.sendEmail, {
			to: email,
			subject: `Your ${label} code`,
			text: `Your ${label} code is ${token}`,
		});
	} catch {
		console.warn(`[email] ${label} delivery failed`);
		throw new Error("Email delivery unavailable");
	}
}

export const ResendOTPVerify = Email({
	id: "verify-otp",
	apiKey: process.env.RESEND_API_KEY,
	maxAge: 60 * 15,
	generateVerificationToken: async () => generateNumericOtp(),
	sendVerificationRequest: async (
		{ identifier, token }: { identifier: string; token: string },
		ctx?: Ctx,
	) => send(ctx, "email verification", identifier, token),
});

export const ResendOTPReset = Email({
	id: "password-reset",
	apiKey: process.env.RESEND_API_KEY,
	maxAge: 60 * 15,
	generateVerificationToken: async () => generateNumericOtp(),
	sendVerificationRequest: async (
		{ identifier, token }: { identifier: string; token: string },
		ctx?: Ctx,
	) => send(ctx, "password reset", identifier, token),
});
