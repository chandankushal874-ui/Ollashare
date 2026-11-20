import { Email } from "@convex-dev/auth/providers/Email";
import { internal } from "./_generated/api";
import { generateNumericOtp } from "./otp";

/**
 * Magic email OTP provider (passwordless). Codes are delivered through the configured
 * SMTP action and are never logged or exposed as a development fallback.
 */
export const ResendOTP = Email({
	id: "resend-otp",
	apiKey: process.env.RESEND_API_KEY,
	maxAge: 60 * 15, // code valid for 15 minutes
	async generateVerificationToken() {
		return generateNumericOtp();
	},
	async sendVerificationRequest(
		{ identifier: email, token }: { identifier: string; token: string },
		ctx?: { runAction: (ref: unknown, args: unknown) => Promise<unknown> },
	) {
		try {
			if (!ctx) throw new Error("Missing action context");
			await ctx.runAction(internal.email.sendEmail, {
				to: email,
				subject: "Your sign-in code",
				text: `Your sign-in code is ${token}`,
			});
		} catch {
			throw new Error("Unable to send authentication email");
		}
	},
});
