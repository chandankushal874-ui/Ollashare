import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { createHmac, randomUUID } from "node:crypto";
import { parsePublicOrigin } from "./public-origin";
import { isSameOriginMutation } from "./request-security";

const currentRef = makeFunctionReference<"query", { roomCode: string }, any>("sharedBrowser:getSession");
const startRef = makeFunctionReference<"mutation", { roomCode: string }, any>("sharedBrowser:startSession");
const grantRef = makeFunctionReference<"mutation", { sessionId: string; requestControl?: boolean }, any>("sharedBrowser:issueViewerGrant");
const grantControllerRef = makeFunctionReference<"mutation", { sessionId: string; viewerId: string }, any>("sharedBrowser:grantController");
const revokeControllerRef = makeFunctionReference<"mutation", { sessionId: string; viewerId?: string }, any>("sharedBrowser:revokeController");
const revokeGrantRef = makeFunctionReference<"mutation", { sessionId: string; grantId: string }, any>("sharedBrowser:revokeViewerGrant");
const terminateRef = makeFunctionReference<"mutation", { sessionId: string }, any>("sharedBrowser:terminateSession");

export const noStoreHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie, Origin", "X-Content-Type-Options": "nosniff" };
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: noStoreHeaders });
export const assertMutationOrigin = (request: Request) => isSameOriginMutation(request);

export async function requireToken() {
  const token = await convexAuthNextjsToken();
  if (!token) throw new Error("UNAUTHENTICATED");
  return token;
}

export async function readJson(request: Request) {
  const text = await request.text();
  if (text.length > 4096) throw new Error("INVALID_JSON");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("INVALID_JSON"); }
}

const convexOptions = (token: string) => ({
  token,
  ...(process.env.CONVEX_INTERNAL_URL
    ? { url: process.env.CONVEX_INTERNAL_URL, skipConvexDeploymentUrlCheck: true }
    : {}),
});

export async function current(roomCode: string, token: string) {
  const value = await fetchQuery(currentRef, { roomCode }, convexOptions(token));
  if (!value || value.status !== "active") return null;
  return { id: value.sessionId, state: "ready", createdAt: new Date().toISOString(), isController: Boolean(value.isController), controllerUserIds: Array.isArray(value.controllerUserIds) ? value.controllerUserIds.map(String) : [] };
}

function workerToken(room: string, operation: "provision" | "status" | "terminate") {
  const secret = requiredSecret("SHARED_BROWSER_WORKER_SECRET");
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ room, operation, iss: "mira", aud: "mira-browser-worker", iat: now, exp: now + 60 }));
  return `${header}.${body}.${createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url")}`;
}

async function workerRequest(roomCode: string, operation: "provision" | "status" | "terminate") {
  const base = loopbackUrl("SHARED_BROWSER_WORKER_INTERNAL_URL");
  const response = await fetch(new URL(`/v1/rooms/${encodeURIComponent(roomCode)}/${operation}`, base), {
    method: operation === "status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${workerToken(roomCode, operation)}` },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok && !(operation === "terminate" && response.status === 204)) {
    if (response.status === 409) throw new Error("BROWSER_CAPACITY");
    if (response.status === 429) throw new Error("BROWSER_RATE_LIMIT");
    throw new Error("WORKER_UNAVAILABLE");
  }
  return response.status === 204 ? null : await response.json() as any;
}

async function registryRequest(method: "PUT" | "DELETE", sessionId: string, body = "") {
  const base = loopbackUrl("SHARED_BROWSER_GATEWAY_INTERNAL_URL");
  const path = `/internal/sessions/${encodeURIComponent(sessionId)}`;
  const timestamp = String(Date.now());
  const nonce = randomUUID().replaceAll("-", "");
  const signature = createHmac("sha256", requiredSecret("SHARED_BROWSER_GATEWAY_REGISTRY_SECRET"))
    .update(`${timestamp}.${nonce}.${method}.${path}.${body}`).digest("hex");
  const response = await fetch(new URL(path, base), {
    method,
    headers: { "content-type": "application/json", "x-mira-timestamp": timestamp, "x-mira-nonce": nonce, "x-mira-signature": signature },
    body: method === "PUT" ? body : undefined,
    signal: AbortSignal.timeout(5000), cache: "no-store",
  });
  if (!response.ok && response.status !== 204) throw new Error("GATEWAY_UNAVAILABLE");
}

export async function provision(roomCode: string, token: string) {
  const value = await fetchMutation(startRef, { roomCode }, convexOptions(token));
  try {
    const result = await workerRequest(roomCode, "provision");
    const endpoints = result?.session?.endpoints as Array<{ kind: string; url: string }> | undefined;
    const view = endpoints?.find((entry) => entry.kind === "ws-view")?.url;
    const control = endpoints?.find((entry) => entry.kind === "ws-control")?.url;
    if (!view || !control) throw new Error("WORKER_UNAVAILABLE");
    await registryRequest("PUT", value.sessionId, JSON.stringify({ roomId: roomCode, viewUpstreamUrl: toWs(view), controlUpstreamUrl: toWs(control) }));
    return { id: value.sessionId, state: "ready", createdAt: new Date().toISOString() };
  } catch (error) {
    await fetchMutation(terminateRef, { sessionId: value.sessionId }, convexOptions(token)).catch(() => undefined);
    await workerRequest(roomCode, "terminate").catch(() => undefined);
    throw error;
  }
}

export async function issueGrant(sessionId: string, requestControl: boolean, token: string) {
  const grant = await fetchMutation(grantRef, { sessionId, requestControl }, convexOptions(token));
  try {
    const status = await workerRequest(grant.roomCode, "status");
    const endpoints = status?.session?.endpoints as Array<{ kind: string; url: string }> | undefined;
    const view = endpoints?.find((entry) => entry.kind === "ws-view")?.url;
    const control = endpoints?.find((entry) => entry.kind === "ws-control")?.url;
    if (!view || !control) throw new Error("WORKER_UNAVAILABLE");
    await registryRequest("PUT", sessionId, JSON.stringify({ roomId: grant.roomCode, viewUpstreamUrl: toWs(view), controlUpstreamUrl: toWs(control) }));
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.floor(grant.expiresAt / 1000);
    const jwt = signGatewayJwt({ sub: String(grant.userId), room: grant.roomCode, session: String(sessionId), mode: grant.mode, lease: grant.controllerLeaseId, jti: String(grant.grantId), iat: now, exp, iss: "mira", aud: "mira-viewer-gateway" });
    return { id: grant.grantId, sessionId, access: grant.mode === "control" ? "controller" : "view-only", viewerUrl: viewerUrl(sessionId, jwt), expiresAt: new Date(grant.expiresAt).toISOString() };
  } catch (error) {
    if (error instanceof Error && error.message === "WORKER_UNAVAILABLE") {
      await fetchMutation(terminateRef, { sessionId }, convexOptions(token)).catch(() => undefined);
      await registryRequest("DELETE", sessionId).catch(() => undefined);
      throw new Error("SESSION_RUNTIME_ENDED");
    }
    throw error;
  }
}

export async function grantController(sessionId: string, viewerId: string, token: string) {
  if (!viewerId || viewerId.length > 160 || /[\u0000-\u001f\u007f]/.test(viewerId)) throw new Error("INVALID_VIEWER");
  return fetchMutation(grantControllerRef, { sessionId, viewerId }, convexOptions(token));
}

export async function revokeController(sessionId: string, viewerId: string, token: string) {
  if (!viewerId || viewerId.length > 160 || /[\u0000-\u001f\u007f]/.test(viewerId)) throw new Error("INVALID_VIEWER");
  return fetchMutation(revokeControllerRef, { sessionId, viewerId }, convexOptions(token));
}

export async function revoke(sessionId: string, grantId: string, token: string) {
  await fetchMutation(revokeGrantRef, { sessionId, grantId }, convexOptions(token));
  await revokeGatewayGrant(grantId);
  return true;
}

export async function terminate(sessionId: string, token: string) {
  const result = await fetchMutation(terminateRef, { sessionId }, convexOptions(token));
  await workerRequest(result.roomCode, "terminate");
  await registryRequest("DELETE", sessionId);
  return true;
}

async function revokeGatewayGrant(grantId: string) {
  const base = loopbackUrl("SHARED_BROWSER_GATEWAY_INTERNAL_URL");
  const path = `/internal/grants/${encodeURIComponent(grantId)}`;
  const timestamp = String(Date.now());
  const nonce = randomUUID().replaceAll("-", "");
  const signature = createHmac("sha256", requiredSecret("SHARED_BROWSER_GATEWAY_REGISTRY_SECRET")).update(`${timestamp}.${nonce}.DELETE.${path}.`).digest("hex");
  const response = await fetch(new URL(path, base), { method: "DELETE", headers: { "x-mira-timestamp": timestamp, "x-mira-nonce": nonce, "x-mira-signature": signature }, signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!response.ok && response.status !== 204) throw new Error("GATEWAY_UNAVAILABLE");
}

const b64 = (value: string) => Buffer.from(value).toString("base64url");
const requiredSecret = (name: string) => { const value = process.env[name] ?? ""; if (Buffer.byteLength(value) < 32) throw new Error("SERVICE_CONFIGURATION"); return value; };
const loopbackUrl = (name: string) => { const value = process.env[name]; if (!value) throw new Error("SERVICE_CONFIGURATION"); const url = new URL(value); if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new Error("SERVICE_CONFIGURATION"); return url; };
const toWs = (value: string) => { const url = new URL(value); if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new Error("WORKER_UNAVAILABLE"); url.protocol = "ws:"; return url.toString(); };
const signGatewayJwt = (claims: Record<string, unknown>) => { const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })); const body = b64(JSON.stringify(claims)); const input = `${header}.${body}`; return `${input}.${createHmac("sha256", requiredSecret("SHARED_BROWSER_GATEWAY_JWT_SECRET")).update(input).digest("base64url")}`; };
const viewerUrl = (sessionId: string, jwt: string) => { const value = process.env.PUBLIC_ORIGIN; if (!value) throw new Error("SERVICE_CONFIGURATION"); let origin: URL; try { origin = parsePublicOrigin(value); } catch { throw new Error("SERVICE_CONFIGURATION"); } const url = new URL(`/shared-browser-viewer/${encodeURIComponent(sessionId)}`, origin); url.hash = `token=${encodeURIComponent(jwt)}`; return url.toString(); };
