// Shared by edge middleware, the client-only migration and offline regression tests.

/** @param {string | undefined} value */
function configuredOrigin(value) {
    if (!value) return null;
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
        url.username || url.password || !/^(?:[a-zA-Z0-9.-]+|\[::1\])$/.test(url.hostname) ||
        !["https:", "wss:"].includes(url.protocol) &&
        !(loopback && ["http:", "ws:"].includes(url.protocol))
    ) {
        throw new Error("CSP endpoints must use HTTPS/WSS (HTTP/WS is loopback-only)");
    }
    return url;
}

/**
 * Only explicitly configured services are trusted. No cloud-provider wildcards,
 * inferred Convex site domains, arbitrary LAN hosts or port ranges.
 * @param {{ nonce: string, development?: boolean, convexUrl?: string, livekitUrl?: string, sentryDsn?: string, frameAncestors?: string }} options
 */
export function buildContentSecurityPolicy({ nonce, development = false, convexUrl, livekitUrl, sentryDsn, frameAncestors = "'none'" }) {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(nonce)) throw new Error("Invalid CSP nonce");
    const connect = new Set(["'self'"]);
    for (const value of [convexUrl, livekitUrl]) {
        const url = configuredOrigin(value);
        if (!url) continue;
        connect.add(url.origin);
        const counterpart = new URL(url);
        counterpart.protocol = { "https:": "wss:", "wss:": "https:", "http:": "ws:", "ws:": "http:" }[url.protocol];
        connect.add(counterpart.origin);
    }
    if (sentryDsn) {
        // Sentry DSNs carry a public project key in the username, not a secret.
        const dsn = new URL(sentryDsn);
        dsn.username = "";
        const sentry = configuredOrigin(dsn.href);
        if (sentry) connect.add(sentry.origin);
    }
    return [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
        // React styles, Radix positioning and next-themes still need inline styles.
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: mediastream:",
        "worker-src 'self' blob:",
        `connect-src ${[...connect].join(" ")}`,
        `frame-ancestors ${frameAncestors}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join("; ");
}

/** @param {Pick<Crypto, 'getRandomValues'>} [random] */
export function createCspNonce(random = globalThis.crypto) {
    const bytes = random.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes));
}

/**
 * Merge, rather than replace, Next's request-header overrides: i18n locale headers
 * and SDK refreshed cookies must survive. Also covers auth/redirect/404 returns.
 * @template {Response} T
 * @param {T} response
 * @param {string} nonce
 * @param {string} policy
 * @param {Headers} requestHeaders
 * @returns {T}
 */
export function applySecurityHeaders(response, nonce, policy, requestHeaders) {
    // With no existing override list (e.g. i18n rewrite), forward the WHOLE request:
    // Next deletes request headers absent from its override list. When the SDK
    // already supplied overrides, preserve that list including intentional deletes.
    const existing = response.headers.get("x-middleware-override-headers");
    const overrides = new Set(
        (existing ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    );
    if (existing === null) {
        requestHeaders.forEach((value, name) => {
            overrides.add(name);
            response.headers.set(`x-middleware-request-${name}`, value);
        });
    }
    for (const [name, value] of [["x-nonce", nonce], ["content-security-policy", policy]]) {
        overrides.add(name);
        response.headers.set(`x-middleware-request-${name}`, value);
    }
    response.headers.set("x-middleware-override-headers", [...overrides].join(","));
    response.headers.set("Content-Security-Policy", policy);
    // A cached document must never be paired with a fresh response nonce.
    response.headers.set("Cache-Control", "private, no-store");
    return response;
}

/**
 * SDK 0.0.80: useNamespacedStorage strips EVERY non-ASCII-alphanumeric
 * character from NEXT_PUBLIC_CONVEX_URL (not URL.origin), then appends it.
 * Never enumerate/delete unrelated localStorage or other deployments' keys.
 * @param {string} convexUrl
 */
export function legacyAuthStorageKeys(convexUrl) {
    if (!convexUrl) return [];
    const namespace = convexUrl.replace(/[^a-zA-Z0-9]/g, "");
    return ["__convexAuthJWT", "__convexAuthRefreshToken", "__convexAuthOAuthVerifier", "__convexAuthServerStateFetchTime"]
        .map((key) => `${key}_${namespace}`);
}

/** @param {Pick<Storage, 'removeItem'>} storage @param {string} convexUrl */
export function removeLegacyAuthStorage(storage, convexUrl) {
    for (const key of legacyAuthStorageKeys(convexUrl)) {
        try {
            storage.removeItem(key);
        } catch {
            // Storage may be denied by browser policy. Do not disrupt cookie auth.
        }
    }
}
