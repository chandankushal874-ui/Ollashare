import { createHash, createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { verifiedHostingMode } from "../../../lib/public-origin";

const VERIFY_KEY_PATH = "/api/verify-key";
const MIN_DURATION_MS = 100;
const MAX_HEADER_BYTES = 8 * 1024;
const API_KEY_PATTERN = /^sk_[a-f0-9]{48}$/;
const RESPONSE_BODY = JSON.stringify({ valid: false });
const VALID_RESPONSE_BODY = '{"valid":true }';

export const runtime = "nodejs";

function response(status = 401, valid = false) {
	return new Response(valid ? VALID_RESPONSE_BODY : RESPONSE_BODY, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

function verifierOrigin(): string | null {
	const configured = process.env.MIRA_CONVEX_HTTP_ORIGIN?.trim();
	const fallback = process.env.NEXT_PUBLIC_CONVEX_URL?.replace(
		/:\d+$/,
		":3211",
	);
	const value = configured || fallback;
	if (!value) return null;
	try {
		const url = new URL(value);
		const loopback =
			url.hostname === "127.0.0.1" ||
			url.hostname === "localhost" ||
			url.hostname === "[::1]";
		if (
			url.username ||
			url.password ||
			(url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		)
			return null;
		return url.origin;
	} catch {
		return null;
	}
}

function headerBytes(headers: Headers): number {
	const encoder = new TextEncoder();
	let total = 0;
	for (const [name, value] of headers) {
		total +=
			encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
		if (total > MAX_HEADER_BYTES) return total;
	}
	return total;
}

function hasEmptyBody(request: Request): boolean {
	const contentLength = request.headers.get("content-length");
	return (contentLength === null || contentLength === "0") && !request.body;
}

function normalizeIp(value: string | null): string | null {
	const candidate = value?.split(",", 1)[0]?.trim().toLowerCase() ?? "";
	return isIP(candidate) ? candidate : null;
}

function clientSource(request: Request): string {
	const mode = verifiedHostingMode();
	if (mode === "loopback-proxy")
		return normalizeIp(request.headers.get("cf-connecting-ip")) ?? "unknown";
	if (mode === "vercel")
		return (
			normalizeIp(request.headers.get("x-vercel-forwarded-for")) ?? "unknown"
		);
	return "unknown";
}

async function waitUntil(startedAt: number) {
	const remaining = MIN_DURATION_MS - (Date.now() - startedAt);
	if (remaining > 0)
		await new Promise((resolve) => setTimeout(resolve, remaining));
}

export async function POST(request: Request) {
	const startedAt = Date.now();
	try {
		const secret = process.env.MIRA_VERIFY_KEY_PROXY_SECRET ?? "";
		const origin = verifierOrigin();
		if (Buffer.byteLength(secret) < 32 || !origin) return response();
		if (headerBytes(request.headers) > MAX_HEADER_BYTES) return response();
		if (!hasEmptyBody(request)) return response();

		const key = request.headers.get("x-api-key") ?? "";
		if (!API_KEY_PATTERN.test(key)) return response();
		const source = clientSource(request);
		const timestamp = String(Date.now());
		const nonce = randomUUID().replaceAll("-", "");
		const keyHash = createHash("sha256").update(key).digest("hex");
		const signature = createHmac("sha256", secret)
			.update(
				`${timestamp}.${nonce}.POST.${VERIFY_KEY_PATH}.${source}.${keyHash}`,
			)
			.digest("hex");
		const upstream = await fetch(`${origin}${VERIFY_KEY_PATH}`, {
			method: "POST",
			headers: {
				"x-api-key": key,
				"x-mira-client-ip": source,
				"x-mira-proxy-timestamp": timestamp,
				"x-mira-proxy-nonce": nonce,
				"x-mira-proxy-signature": signature,
			},
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.timeout(5_000),
		});
		const body = await upstream.text();
		if (upstream.status === 200 && body === VALID_RESPONSE_BODY)
			return response(200, true);
		return response();
	} catch {
		return response();
	} finally {
		await waitUntil(startedAt);
	}
}
