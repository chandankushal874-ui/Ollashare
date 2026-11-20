const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type VerifiedHostingMode = "loopback-proxy" | "vercel";

export function isQuickTunnelHost(hostname: string): boolean {
  return hostname === "trycloudflare.com" || hostname.endsWith(".trycloudflare.com");
}

export function parsePublicOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.port
  ) {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, fragment, or port");
  }
  if (LOOPBACK_HOSTS.has(origin.hostname.toLowerCase()) || origin.hostname.startsWith("127.")) {
    throw new Error("PUBLIC_ORIGIN must not use a loopback host");
  }
  if (process.env.MIRA_ENFORCE_NAMED_TUNNEL === "1" && isQuickTunnelHost(origin.hostname.toLowerCase())) {
    throw new Error("PUBLIC_ORIGIN must not use a trycloudflare.com quick tunnel when named-tunnel enforcement is enabled");
  }
  return origin;
}

export function publicOriginFromEnvironment(): URL | null {
  const value = process.env.PUBLIC_ORIGIN;
  if (!value) return null;
  try {
    return parsePublicOrigin(value);
  } catch {
    return null;
  }
}

export function requestHostIsAllowed(host: string | null, origin: URL): boolean {
  return host !== null && host.toLowerCase() === origin.host;
}

export function verifiedHostingMode(): VerifiedHostingMode | null {
  if (process.env.MIRA_HOSTING_MODE === "loopback-proxy" && process.env.MIRA_TRUSTED_PROXY === "loopback") {
    return "loopback-proxy";
  }
  if (
    process.env.MIRA_HOSTING_MODE === "vercel" &&
    process.env.VERCEL === "1" &&
    process.env.VERCEL_ENV &&
    process.env.VERCEL_URL
  ) {
    return "vercel";
  }
  return null;
}

export function effectiveRequestProtocol(request: Request): "http:" | "https:" {
  const mode = verifiedHostingMode();
  if (mode === "loopback-proxy") return "https:";
  if (mode === "vercel") {
    const url = new URL(request.url);
    const vercelHost = process.env.VERCEL_URL?.toLowerCase();
    const host = request.headers.get("host")?.toLowerCase();
    const publicOrigin = publicOriginFromEnvironment();
    if (
      url.protocol === "https:" &&
      vercelHost &&
      host === vercelHost &&
      publicOrigin &&
      publicOrigin.hostname.toLowerCase() === vercelHost
    ) {
      return "https:";
    }
  }
  return "http:";
}
