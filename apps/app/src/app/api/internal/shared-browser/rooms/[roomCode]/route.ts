import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { authenticateSharedBrowserServiceRequest } from "../../../../../../lib/shared-browser-service-auth";

const getRef = makeFunctionReference<"query", { roomCode: string; serviceSecret: string }, { status?: string } | null>("sharedBrowser:getSessionForServiceWithSecret");
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ roomCode: string }> }) {
  const path = new URL(request.url).pathname;
  const secret = process.env.SHARED_BROWSER_GATEWAY_INTROSPECTION_SECRET ?? "";
  if (!authenticateSharedBrowserServiceRequest(request, path, secret)) return new Response(null, { status: 401 });
  const { roomCode } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomCode)) return new Response(null, { status: 400 });
  const session = await fetchQuery(getRef, { roomCode, serviceSecret: secret }, process.env.CONVEX_INTERNAL_URL ? { url: process.env.CONVEX_INTERNAL_URL, skipConvexDeploymentUrlCheck: true } : undefined);
  return Response.json({ active: session?.status === "active" }, { headers: { "cache-control": "no-store" } });
}
