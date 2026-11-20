import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		CONVEX_SITE_URL: z.string().url(),
		LOOPS_FORM_ID: z.optional(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)),
		LOOPS_API_KEY: z.optional(z.string().min(32).max(512)),
		LOOPS_NEWSLETTER_GROUP: z.optional(z.literal("v1-newsletter")),
		POLAR_ORGANIZATION_TOKEN: z.string().min(1),
		POLAR_WEBHOOK_SECRET: z.string().min(1),
		RESEND_API_KEY: z.optional(z.string().min(1)),
		RESEND_SENDER_EMAIL_AUTH: z.optional(z.string().email()),
		SITE_URL: z.string().url(),
		AUTH_GOOGLE_ID: z.string().min(1),
		AUTH_GOOGLE_SECRET: z.string().min(1),
		// Dedicated HMAC secret for daily analytics actor pseudonyms. When absent,
		// unique-user marking fails closed while room operations continue.
		ANALYTICS_ACTOR_PEPPER: z.optional(z.string().min(32)),
	},
	runtimeEnv: {
		CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
		LOOPS_FORM_ID: process.env.LOOPS_FORM_ID,
		LOOPS_API_KEY: process.env.LOOPS_API_KEY,
		LOOPS_NEWSLETTER_GROUP: process.env.LOOPS_NEWSLETTER_GROUP,
		POLAR_ORGANIZATION_TOKEN: process.env.POLAR_ORGANIZATION_TOKEN,
		POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET,
		RESEND_API_KEY: process.env.RESEND_API_KEY,
		RESEND_SENDER_EMAIL_AUTH: process.env.RESEND_SENDER_EMAIL_AUTH,
		SITE_URL: process.env.SITE_URL,
		AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
		AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
		ANALYTICS_ACTOR_PEPPER: process.env.ANALYTICS_ACTOR_PEPPER,
	},
	skipValidation: !process.env.VALIDATE_ENV,
});
