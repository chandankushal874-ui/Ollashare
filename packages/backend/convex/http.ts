import { httpRouter } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { readBoundedBody } from "./security";
import { polar } from "./subscriptions";
import { AVATAR_LIMIT, FILE_LIMIT, validateUpload } from "./uploads";
import { VERIFY_KEY_PATH, handleVerifyKeyRequest } from "./verifyKeyHttp";
import { verifyBackendWebhook } from "./webhookSecurity";
const acceptWebhook = makeFunctionReference<
	"mutation",
	{ messageId: string; payload: Record<string, unknown> },
	"accepted" | "duplicate" | "limited"
>("webhookSecurity:accept");
const admitApiKeyVerification = makeFunctionReference<
	"mutation",
	{ sourceHash: string; nonceHash: string },
	boolean
>("apiKeys:admitVerification");
const resolveApiKeyByHash = makeFunctionReference<
	"query",
	{ hash: string },
	unknown
>("apiKeys:resolveByHash");
function browserOrigin(req: Request) {
	const origin = req.headers.get("origin");
	const site = process.env.SITE_URL;
	try {
		return !!site && origin === new URL(site).origin;
	} catch {
		return false;
	}
}
function uploadHeaders(req: Request) {
	return {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"Access-Control-Allow-Origin": req.headers.get("origin") ?? "",
		Vary: "Origin",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
	};
}
const consumeUpload = makeFunctionReference<
	"mutation",
	{ token: string },
	{ userId: Id<"users">; workspaceId?: Id<"workspaces"> } | null
>("uploads:consume");
const registerUpload = makeFunctionReference<
	"mutation",
	{
		storageId: Id<"_storage">;
		userId: Id<"users">;
		workspaceId?: Id<"workspaces">;
		size: number;
		contentType: string;
	},
	null
>("uploads:register");
const downloadFile = makeFunctionReference<
	"query",
	{ fileId: Id<"files"> },
	{ name: string; storageId: Id<"_storage">; contentType: string }
>("files:download");

const http = httpRouter();

auth.addHttpRoutes(http);

// Register the webhook handler at /polar/events
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
polar.registerRoutes(http as any);
http.route({
	pathPrefix: "/files/download/",
	method: "GET",
	handler: httpAction(async (ctx, req) => {
		const headers = {
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox; default-src 'none'",
			Vary: "Authorization",
		};
		try {
			if (!(await ctx.auth.getUserIdentity()))
				return new Response(null, { status: 401, headers });
			const id = new URL(req.url).pathname.slice("/files/download/".length);
			const file = await ctx.runQuery(downloadFile, {
				fileId: id as Id<"files">,
			});
			const blob = await ctx.storage.get(file.storageId);
			if (!blob) return new Response(null, { status: 404, headers });
			const name =
				file.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 200) || "download";
			return new Response(blob, {
				headers: {
					...headers,
					"Content-Type": "application/octet-stream",
					"Content-Disposition": `attachment; filename="${name}"`,
				},
			});
		} catch {
			return new Response(null, { status: 404, headers });
		}
	}),
});

http.route({
	path: "/uploads",
	method: "OPTIONS",
	handler: httpAction(async (_ctx, req) =>
		browserOrigin(req)
			? new Response(null, { status: 204, headers: uploadHeaders(req) })
			: new Response(null, { status: 403 }),
	),
});
http.route({
	path: "/uploads",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		if (!browserOrigin(req)) return new Response(null, { status: 403 });
		const headers = uploadHeaders(req);
		const token = req.headers
			.get("authorization")
			?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
		if (!token)
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers,
			});
		const ticket = await ctx.runMutation(consumeUpload, { token });
		if (!ticket)
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers,
			});
		let storageId: Id<"_storage"> | undefined;
		try {
			const bytes = await readBoundedBody(
				req,
				ticket.workspaceId ? FILE_LIMIT : AVATAR_LIMIT,
			);
			const contentType = validateUpload(
				bytes,
				req.headers.get("content-type") ?? "",
				!ticket.workspaceId,
			);
			storageId = await ctx.storage.store(
				new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }),
			);
			await ctx.runMutation(registerUpload, {
				...ticket,
				storageId,
				size: bytes.length,
				contentType,
			});
			return new Response(JSON.stringify({ storageId }), {
				status: 200,
				headers,
			});
		} catch {
			if (storageId) await ctx.storage.delete(storageId);
			return new Response(JSON.stringify({ error: "Upload rejected" }), {
				status: 400,
				headers,
			});
		}
	}),
});

// --- Hybrid adapter WEBHOOK PATH: external backend posts results/events here ---
http.route({
	path: "/backend/webhook",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		let verified: ReturnType<typeof verifyBackendWebhook>;
		try {
			const body = new TextDecoder("utf-8", { fatal: true }).decode(
				await readBoundedBody(req, 256 * 1024),
			);
			verified = verifyBackendWebhook(body, req.headers);
		} catch {
			return new Response("unauthorized", { status: 401 });
		}
		let accepted: "accepted" | "duplicate" | "limited";
		try {
			accepted = await ctx.runMutation(acceptWebhook, verified);
		} catch {
			return new Response("Invalid event", { status: 400 });
		}
		if (accepted === "limited")
			return new Response("Too many requests", { status: 429 });
		return new Response(null, { status: 204 });
	}),
});

// --- API key verification (programmatic access) ---
http.route({
	path: VERIFY_KEY_PATH,
	method: "POST",
	handler: httpAction(async (ctx, req) =>
		handleVerifyKeyRequest(ctx, req, {
			admit: admitApiKeyVerification,
			resolve: resolveApiKeyByHash,
		}),
	),
});

export default http;
