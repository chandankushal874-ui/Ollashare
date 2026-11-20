import { createHmac, timingSafeEqual } from "node:crypto";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{13}$/;
const TTL_MS = 30_000;
const MAX_NONCES = 4096;
const usedNonces = new Map<string, number>();

export function authenticateSharedBrowserServiceRequest(request: Request, path: string, secret: string, now = Date.now()): boolean {
  const timestamp = request.headers.get("x-mira-timestamp") ?? "";
  const nonce = request.headers.get("x-mira-nonce") ?? "";
  const signature = request.headers.get("x-mira-signature") ?? "";
  if (Buffer.byteLength(secret) < 32 || !TIMESTAMP_PATTERN.test(timestamp) || !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature)) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > TTL_MS) return false;
  for (const [value, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(value);
  }
  if (usedNonces.has(nonce)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${request.method}.${path}`).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return false;
  usedNonces.set(nonce, now + TTL_MS);
  while (usedNonces.size > MAX_NONCES) {
    const oldest = usedNonces.keys().next().value as string | undefined;
    if (!oldest) break;
    usedNonces.delete(oldest);
  }
  return true;
}
