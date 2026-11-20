import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { createHmac } from "node:crypto";
import { authenticateSharedBrowserServiceRequest } from "../../../../../../lib/shared-browser-service-auth";

const validateRef = makeFunctionReference<"query", { serviceSecret: string; grantId: string }, { active: boolean; roomCode?: string; sessionId?: string; mode?: string; expiresAt?: number }>("sharedBrowser:validateGatewayGrant");
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ grantId: string }> }) {
  const path = new URL(request.url).pathname;
  const secret = process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET ?? "";
  if (!authenticateSharedBrowserServiceRequest(request, path, secret)) return new Response(null, { status: 401 });
  const { grantId } = await params;
  if (!/^[A-Za-z0-9_;-]{8,160}$/.test(grantId)) return new Response(null, { status: 400 });
  try {
    const result = await fetchQuery(validateRef, { serviceSecret: secret, grantId }, process.env.CONVEX_INTERNAL_URL ? { url: process.env.CONVEX_INTERNAL_URL, skipConvexDeploymentUrlCheck: true } : undefined);
    if (result.active && result.roomCode) {
      await touchWorker(result.roomCode).catch(() => undefined);
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ active: false, unavailable: true }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

async function touchWorker(roomCode: string) {
  const workerSecret = process.env.SHARED_BROWSER_WORKER_SECRET ?? "";
  const base = process.env.SHARED_BROWSER_WORKER_INTERNAL_URL ?? "";
  if (workerSecret.length < 32) return;
  const url = new URL(`/v1/rooms/${encodeURIComponent(roomCode)}/status`, base);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value: string) => Buffer.from(value).toString("base64url");
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ room: roomCode, operation: "status", iss: "mira", aud: "mira-browser-worker", iat: now, exp: now + 60 }));
  const input = `${header}.${body}`;
  const token = `${input}.${createHmac("sha256", workerSecret).update(input).digest("base64url")}`;
  await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000), cache: "no-store" });
}
