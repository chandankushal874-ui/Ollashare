import type { FunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
import { env } from "./env";
import { takeRateLimit } from "./rateLimits";

const EMAIL_PATTERN =
	/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const LOOPS_FORM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NEWSLETTER_GROUP = "v1-newsletter";
const MAX_EMAIL_BYTES = 254;
const MAX_SUBSCRIPTIONS_PER_EMAIL_PER_DAY = 1;
const MAX_SUBSCRIPTIONS_GLOBAL_PER_HOUR = 5_000;
const NEWSLETTER_TIMEOUT_MS = 5_000;
const GENERIC_NEWSLETTER_ERROR = "Newsletter request unavailable";

export function normalizeSubscription(emailValue: string) {
	if (emailValue.length > MAX_EMAIL_BYTES + 2)
		throw new ConvexError(GENERIC_NEWSLETTER_ERROR);
	const email = emailValue.trim().toLowerCase();
	if (
		new TextEncoder().encode(email).byteLength > MAX_EMAIL_BYTES ||
		!EMAIL_PATTERN.test(email)
	) {
		throw new ConvexError(GENERIC_NEWSLETTER_ERROR);
	}
	return email;
}

export type NewsletterConfig = {
	apiKey: string;
	formId: string;
	userGroup: typeof NEWSLETTER_GROUP;
};

export function validateNewsletterConfig(values: {
	LOOPS_API_KEY?: string;
	LOOPS_FORM_ID?: string;
	LOOPS_NEWSLETTER_GROUP?: string;
}): NewsletterConfig {
	const apiKey = values.LOOPS_API_KEY ?? "";
	const formId = values.LOOPS_FORM_ID ?? "";
	const userGroup = values.LOOPS_NEWSLETTER_GROUP ?? "";
	if (
		apiKey.length < 32 ||
		apiKey.length > 512 ||
		/[\r\n]/.test(apiKey) ||
		!LOOPS_FORM_ID_PATTERN.test(formId) ||
		userGroup !== NEWSLETTER_GROUP
	) {
		throw new ConvexError(GENERIC_NEWSLETTER_ERROR);
	}
	return { apiKey, formId, userGroup };
}

async function emailRateKey(email: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(email),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export const reserveSubscription = internalMutation({
	args: { emailHash: v.string() },
	handler: async (ctx, { emailHash }) => {
		if (!/^[a-f0-9]{64}$/.test(emailHash))
			throw new ConvexError(GENERIC_NEWSLETTER_ERROR);
		if (
			!(await takeRateLimit(
				ctx,
				"newsletter:global",
				MAX_SUBSCRIPTIONS_GLOBAL_PER_HOUR,
				60 * 60_000,
			))
		) {
			return false;
		}
		return takeRateLimit(
			ctx,
			`newsletter:email:${emailHash}`,
			MAX_SUBSCRIPTIONS_PER_EMAIL_PER_DAY,
			24 * 60 * 60_000,
		);
	},
});

type NewsletterReservation = FunctionReference<
	"mutation",
	"internal",
	{ emailHash: string },
	boolean
>;

type NewsletterContext = {
	runMutation: (
		reference: NewsletterReservation,
		args: { emailHash: string },
	) => Promise<boolean>;
};

type NewsletterFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export async function executeNewsletterSubscription(
	ctx: NewsletterContext,
	emailValue: string,
	options: {
		config?: NewsletterConfig;
		fetch?: NewsletterFetch;
	} = {},
): Promise<{ success: true }> {
	try {
		const email = normalizeSubscription(emailValue);
		const config = options.config ?? validateNewsletterConfig(env);
		const admitted = await ctx.runMutation(internal.web.reserveSubscription, {
			emailHash: await emailRateKey(email),
		});
		if (!admitted) throw new Error("newsletter admission denied");
		const request = options.fetch ?? fetch;
		const response = await request(
			`https://app.loops.so/api/newsletter-form/${encodeURIComponent(config.formId)}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ email, userGroup: config.userGroup }),
				redirect: "error",
				signal: AbortSignal.timeout(NEWSLETTER_TIMEOUT_MS),
			},
		);
		if (!response.ok) throw new Error("vendor rejected request");
		return { success: true };
	} catch {
		throw new ConvexError(GENERIC_NEWSLETTER_ERROR);
	}
}

export const subscribe = action({
	args: { email: v.string() },
	handler: async (ctx, { email }): Promise<{ success: true }> =>
		executeNewsletterSubscription(ctx, email),
});
