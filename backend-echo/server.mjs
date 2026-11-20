// Reference "real" backend for the hybrid template — proves the attach paths:
//   DIRECT : browser -> here with a Convex JWT, verified via JWKS (no shared secret).
//   PROXY  : Convex action -> here with a shared service key + x-user-id.
//   JOBS   : Convex -> /jobs/run (proxy); we process async then webhook the result back.
//   WEBHOOK: here -> Convex /backend/webhook (push results/events back).
// Run with Node from inside /opt/myos so `jose` resolves from node_modules.
import http from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Webhook } from 'standardwebhooks';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { validateJobRunRequest } from './job-contract.mjs';

const PORT = process.env.PORT || 4000;
const SERVICE_KEY = process.env.SERVICE_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL || '';
const ALLOWED_ORIGIN = process.env.SITE_URL ? new URL(process.env.SITE_URL).origin : '';
const AUDIENCE = process.env.CONVEX_AUDIENCE || "convex";
function validServiceKey(value) {
  const supplied = Buffer.from(typeof value === 'string' ? value : '');
  const expected = Buffer.from(SERVICE_KEY);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

if (SERVICE_KEY.length < 32 || WEBHOOK_SECRET.length < 32 || !CONVEX_SITE_URL ||
  (new URL(CONVEX_SITE_URL).protocol !== 'https:' && process.env.NODE_ENV === 'production')) {
  console.error("Refusing to start: SERVICE_KEY and WEBHOOK_SECRET must be set.");
  process.exit(1);
}

// Public-key verification only — this is the whole "attach to any backend" trick.
const JWKS = createRemoteJWKSet(
  new URL(`${CONVEX_SITE_URL}/.well-known/jwks.json`),
);

function send(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(res.allowedOrigin ? { 'access-control-allow-origin': res.allowedOrigin, vary: 'Origin' } : {}),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req, options = {}) {
  const chunks = [];
  let size = 0;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) {
      const error = new Error('Body too large');
      error.code = options.invalidCode;
      throw error;
    }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    const error = new Error('Invalid JSON');
    error.code = options.invalidCode;
    throw error;
  }
}

async function postWebhook(body, delivery) {
  const payload = JSON.stringify(body);
  const id = delivery?.id ?? randomUUID();
  const timestamp = delivery?.timestamp ?? new Date();
  return fetch(`${CONVEX_SITE_URL}/backend/webhook`, {
    method: "POST",
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json",
      'webhook-id': id,
      'webhook-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
      'webhook-signature': new Webhook(WEBHOOK_SECRET, { format: 'raw' }).sign(id, timestamp, payload),
    },
    body: payload,
  });
}

async function postWebhookWithRetry(body) {
  const delivery = { id: randomUUID(), timestamp: new Date() };
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await postWebhook(body, delivery);
    if (response.ok) return response;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  return response;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.origin) {
      if (req.headers.origin !== ALLOWED_ORIGIN) return send(res, 403, { error: 'Origin rejected' });
      res.allowedOrigin = ALLOWED_ORIGIN;
    }
    if (req.method === "OPTIONS") return send(res, 204, {});

    // DIRECT PATH — verify the Convex-issued JWT against the public JWKS.
    if (req.method === "GET" && req.url === "/whoami") {
      const header = req.headers["authorization"] || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token) return send(res, 401, { error: "missing bearer token" });
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: CONVEX_SITE_URL,
          audience: AUDIENCE,
          algorithms: ['RS256'],
        });
        return send(res, 200, {
          verified: true,
          sub: payload.sub,
          iss: payload.iss,
          aud: payload.aud,
        });
      } catch (e) {
        return send(res, 401, { verified: false, error: 'Invalid token' });
      }
    }

    // PROXY PATH — trust the shared service key, echo the forwarded user id.
    if (req.method === "POST" && req.url === "/proxy-echo") {
      if (!validServiceKey(req.headers['x-service-key'])) {
        return send(res, 401, { error: "bad service key" });
      }
      const body = await readBody(req);
      return send(res, 200, {
        viaProxy: true,
        echoedUserId: req.headers["x-user-id"] || null,
        received: body,
      });
    }

    // JOBS — accept a job, simulate async work, then webhook the result back to Convex.
    if (req.method === "POST" && req.url === "/jobs/run") {
      if (!validServiceKey(req.headers['x-service-key'])) {
        return send(res, 401, { error: "bad service key" });
      }
      const body = validateJobRunRequest(
        await readBody(req, {
          maxBytes: 40 * 1024,
          invalidCode: 'INVALID_JOB_REQUEST',
        }),
        req.headers['x-user-id'],
      );
      const jobId = body.jobId;
      setTimeout(async () => {
        try {
          const result = await postWebhookWithRetry({
            type: "job.result",
            jobId,
            workspaceId: body.workspaceId,
            userId: body.userId,
            kind: body.kind,
            result: {
              kind: body.kind,
              echoedInput: body.input,
              finishedBy: "echo-backend",
              at: new Date().toISOString(),
            },
          });
          if (!result.ok) throw new Error('Webhook rejected');
        } catch (e) {
          console.error('job webhook failed');
        }
      }, 1500);
      return send(res, 202, { accepted: true, jobId });
    }

    // WEBHOOK EMIT — push a generic event back into Convex (demo of backend -> Convex).
    if (req.method === "POST" && req.url === "/emit-webhook") {
      if (!validServiceKey(req.headers['x-service-key'])) {
        return send(res, 401, { error: "bad service key" });
      }
      const body = await readBody(req);
      const r = await postWebhook({ type: "demo.echo", ...body });
      return send(res, 200, { posted: true, convexStatus: r.status });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, e?.code === 'INVALID_JOB_REQUEST' ? 400 : 500, { error: 'Request failed' });
  }
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`echo backend listening on 127.0.0.1:${PORT}`),
);
