import type { FunctionReference } from "convex/server";
import type { ActionCtx } from "./_generated/server";

export const VERIFY_KEY_PATH = "/api/verify-key";
export const VERIFY_KEY_MAX_HEADER_BYTES = 8 * 1024;
export const VERIFY_KEY_MAX_BODY_BYTES = 0;
export const VERIFY_KEY_MIN_DURATION_MS = 100;
export const VERIFY_KEY_RESPONSE_BODY = JSON.stringify({ valid: false });
export const VERIFY_KEY_VALID_RESPONSE_BODY = '{"valid":true }';

const API_KEY_PATTERN = /^sk_[a-f0-9]{48}$/;
const SOURCE_PATTERN = /^(?:[a-f0-9:.]{1,64}|unknown)$/i;
const PROXY_NONCE_PATTERN = /^[a-f0-9]{32}$/;
const PROXY_SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const PROXY_TIMESTAMP_PATTERN = /^\d{13}$/;
const PROXY_AUTH_MAX_SKEW_MS = 30_000;

export type VerifyKeyContext = Pick<ActionCtx, "runMutation" | "runQuery">;

export type VerifyKeyReferences = {
	admit: FunctionReference<
		"mutation",
		"public" | "internal",
		{ sourceHash: string; nonceHash: string },
		boolean
	>;
	resolve: FunctionReference<
		"query",
		"public" | "internal",
		{ hash: string },
		unknown
	>;
};

function response(status: number): Response {
	return new Response(
		status === 200 ? VERIFY_KEY_VALID_RESPONSE_BODY : VERIFY_KEY_RESPONSE_BODY,
		{
			status,
			headers: {
				"cache-control": "no-store",
				"content-type": "application/json; charset=utf-8",
				"x-content-type-options": "nosniff",
			},
		},
	);
}

function headerBytes(headers: Headers): number {
	const encoder = new TextEncoder();
	let total = 0;
	for (const [name, value] of headers) {
		total +=
			encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
		if (total > VERIFY_KEY_MAX_HEADER_BYTES) return total;
	}
	return total;
}

function validContentLength(request: Request): boolean {
	const value = request.headers.get("content-length");
	return value === null || value === "0";
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

type AuthenticatedProxy = { source: string; nonce: string };

async function sourceFromAuthenticatedProxy(
	request: Request,
): Promise<AuthenticatedProxy | null> {
	const secret = process.env.MIRA_VERIFY_KEY_PROXY_SECRET ?? "";
	const timestamp = request.headers.get("x-mira-proxy-timestamp") ?? "";
	const nonce = request.headers.get("x-mira-proxy-nonce") ?? "";
	const signature = request.headers.get("x-mira-proxy-signature") ?? "";
	const source =
		request.headers.get("x-mira-client-ip")?.trim().toLowerCase() ?? "";
	if (
		new TextEncoder().encode(secret).byteLength < 32 ||
		!PROXY_TIMESTAMP_PATTERN.test(timestamp) ||
		!PROXY_NONCE_PATTERN.test(nonce) ||
		!PROXY_SIGNATURE_PATTERN.test(signature) ||
		!SOURCE_PATTERN.test(source) ||
		Math.abs(Date.now() - Number(timestamp)) > PROXY_AUTH_MAX_SKEW_MS
	)
		return null;
	const keyHash = await sha256Hex(request.headers.get("x-api-key") ?? "");
	const canonical = `${timestamp}.${nonce}.${request.method}.${VERIFY_KEY_PATH}.${source}.${keyHash}`;
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const valid = await crypto.subtle.verify(
		"HMAC",
		hmacKey,
		hexBytes(signature),
		new TextEncoder().encode(canonical),
	);
	return valid ? { source, nonce } : null;
}

async function drainBoundedBody(request: Request): Promise<boolean> {
	if (!request.body) return true;
	const reader = request.body.getReader();
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return size <= VERIFY_KEY_MAX_BODY_BYTES;
			size += value.byteLength;
			if (size > VERIFY_KEY_MAX_BODY_BYTES) return false;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function waitUntil(startedAt: number): Promise<void> {
	const remaining = VERIFY_KEY_MIN_DURATION_MS - (Date.now() - startedAt);
	if (remaining > 0)
		await new Promise((resolve) => setTimeout(resolve, remaining));
}

export async function handleVerifyKeyRequest(
	ctx: VerifyKeyContext,
	request: Request,
	references: VerifyKeyReferences,
): Promise<Response> {
	const startedAt = Date.now();
	let status = 401;
	try {
		if (request.method !== "POST") {
			status = 405;
			return response(status);
		}
		if (headerBytes(request.headers) > VERIFY_KEY_MAX_HEADER_BYTES) {
			status = 431;
			return response(status);
		}
		if (!validContentLength(request) || !(await drainBoundedBody(request))) {
			status = 413;
			return response(status);
		}
		const key = request.headers.get("x-api-key") ?? "";
		if (!API_KEY_PATTERN.test(key)) return response(status);
		const proxy = await sourceFromAuthenticatedProxy(request);
		if (!proxy) return response(status);
		const sourceHash = await sha256Hex(proxy.source);
		const nonceHash = await sha256Hex(proxy.nonce);
		if (!(await ctx.runMutation(references.admit, { sourceHash, nonceHash }))) {
			status = 429;
			return response(status);
		}
		const found = await ctx.runQuery(references.resolve, {
			hash: await sha256Hex(key),
		});
		status = found ? 200 : 401;
		return response(status);
	} catch {
		return response(status);
	} finally {
		await waitUntil(startedAt);
	}
}
