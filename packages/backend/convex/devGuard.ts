import { ConvexError } from "convex/values";

/**
 * Gate for seed/test-only internal functions. They are never callable from
 * clients (internal*), but this also blocks accidental admin/CLI use in real
 * deployments.
 *
 * Two-factor, fail-closed:
 *   1. DEV_SEED must be explicitly set to "1".
 *   2. NODE_ENV must NOT be "production" — so even if DEV_SEED=1 leaks into a
 *      self-hosted production Node runtime (the deployment target), dev-only
 *      functions remain disabled.
 *
 * Enable in development with: convex env set DEV_SEED 1
 */
export function requireDevSeed() {
  const enabled = process.env.DEV_SEED === "1";
  const inProduction = process.env.NODE_ENV === "production";
  if (!enabled || inProduction) {
    throw new ConvexError(
      "Dev/seed functions are disabled (DEV_SEED=1 is required and production is blocked)",
    );
  }
}
