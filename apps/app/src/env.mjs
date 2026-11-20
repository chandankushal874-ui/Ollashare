import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const parsePublicOriginForEnvironment = (value) => {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || origin.port) {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, fragment, or port");
  }
  const hostname = origin.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname) || hostname.startsWith("127.")) {
    throw new Error("PUBLIC_ORIGIN must not use a loopback host");
  }
  if (process.env.MIRA_ENFORCE_NAMED_TUNNEL === "1" && (hostname === "trycloudflare.com" || hostname.endsWith(".trycloudflare.com"))) {
    throw new Error("PUBLIC_ORIGIN must not use a trycloudflare.com quick tunnel when named-tunnel enforcement is enabled");
  }
  return origin;
};

const publicOriginSchema = z.string().superRefine((value, context) => {
  try {
    parsePublicOriginForEnvironment(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid PUBLIC_ORIGIN",
    });
  }
});

export const env = createEnv({
  shared: {
    PUBLIC_ORIGIN: publicOriginSchema,
    MIRA_HOSTING_MODE: z.enum(["loopback-proxy", "vercel"]),
    MIRA_TRUSTED_PROXY: z.literal("loopback").optional(),
    MIRA_ENFORCE_NAMED_TUNNEL: z.enum(["0", "1"]).default("0"),
    VERCEL_URL: z
      .string()
      .optional()
      .transform((v) => (v ? `https://${v}` : undefined)),
  },
  client: {
    NEXT_PUBLIC_CONVEX_URL: z.string(),
    NEXT_PUBLIC_OPENPANEL_CLIENT_ID: z.optional(z.string()),
    NEXT_PUBLIC_SENTRY_DSN: z.optional(z.string()),
  },
  runtimeEnv: {
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NEXT_PUBLIC_OPENPANEL_CLIENT_ID:
      process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
    MIRA_HOSTING_MODE: process.env.MIRA_HOSTING_MODE,
    MIRA_TRUSTED_PROXY: process.env.MIRA_TRUSTED_PROXY,
    MIRA_ENFORCE_NAMED_TUNNEL: process.env.MIRA_ENFORCE_NAMED_TUNNEL,
    VERCEL_URL: process.env.VERCEL_URL,
  },
  skipValidation: !!process.env.CI || !!process.env.SKIP_ENV_VALIDATION,
});
