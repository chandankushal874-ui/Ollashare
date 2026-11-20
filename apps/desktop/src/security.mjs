const DEVELOPMENT_ORIGINS = new Set([
    "http://127.0.0.1:3000",
    "http://localhost:3000",
]);

export function resolveAppUrl(environment = process.env) {
    const raw = environment.MIRA_DESKTOP_URL ?? "http://127.0.0.1:3000";
    const url = new URL(raw);
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
        throw new Error(`Unsupported desktop app protocol: ${url.protocol}`);
    }
    if (
        url.protocol !== "https:" &&
        !DEVELOPMENT_ORIGINS.has(url.origin)
    ) {
        throw new Error(
            "MIRA_DESKTOP_URL must use HTTPS unless it is the local development server",
        );
    }
    return url;
}

export function isTrustedNavigation(target, appUrl) {
    try {
        const url = new URL(target);
        return url.origin === appUrl.origin;
    } catch {
        return false;
    }
}

export function isSafeExternalUrl(target) {
    try {
        return new Set(["https:", "mailto:"]).has(new URL(target).protocol);
    } catch {
        return false;
    }
}

export function isAllowedPermission(permission, requestingUrl, appUrl) {
    if (!isTrustedNavigation(requestingUrl, appUrl)) return false;
    return new Set([
        "media",
        "display-capture",
        "notifications",
        "clipboard-sanitized-write",
    ]).has(permission);
}
