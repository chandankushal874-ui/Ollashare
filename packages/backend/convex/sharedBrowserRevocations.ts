"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { createHmac, randomUUID } from "node:crypto";

const gatewayOrigin = () => process.env.SHARED_BROWSER_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:8787";
const gatewaySecret = () => process.env.SHARED_BROWSER_GATEWAY_REGISTRY_SECRET ?? "";

export const deliverSharedBrowserRevocations = internalAction({
  args: {},
  handler: async (ctx) => {
    const secret = gatewaySecret();
    if (secret.length < 32) return { delivered: 0, failed: 0, skipped: true };
    const claimId = `dispatcher_${randomUUID().replace(/-/g, "")}`;
    const pending = await ctx.runMutation(internal.sharedBrowser.listPendingRevocations, { limit: 100, claimId });
    let delivered = 0;
    let failed = 0;
    for (const revocation of pending) {
      const path = `/internal/grants/${encodeURIComponent(String(revocation.grantId))}`;
      const timestamp = Date.now().toString();
      const nonce = randomUUID().replace(/-/g, "");
      const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.DELETE.${path}.`).digest("hex");
      try {
        const response = await fetch(new URL(path, gatewayOrigin()), {
          method: "DELETE",
          headers: { "x-mira-timestamp": timestamp, "x-mira-nonce": nonce, "x-mira-signature": signature },
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok && response.status !== 404) throw new Error(`Gateway revoke failed: ${response.status}`);
        await ctx.runMutation(internal.sharedBrowser.markRevocationDelivered, { revocationId: revocation._id, claimId });
        delivered += 1;
      } catch {
        failed += 1;
      }
    }
    return { delivered, failed, skipped: false };
  },
});
