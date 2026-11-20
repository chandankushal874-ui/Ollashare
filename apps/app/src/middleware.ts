import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
} from "@convex-dev/auth/nextjs/server";
import { createI18nMiddleware } from "next-international/middleware";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { isSameOriginMutation } from "./lib/request-security";
import { applySecurityHeaders, buildContentSecurityPolicy, createCspNonce } from "./lib/frontend-security.mjs";
import { effectiveRequestProtocol, publicOriginFromEnvironment, requestHostIsAllowed } from "./lib/public-origin";

const I18nMiddleware = createI18nMiddleware({
  locales: ["en", "fr", "es"],
  defaultLocale: "en",
  urlMappingStrategy: "rewrite",
});

const isSignInPage = createRouteMatcher(["/login", "/signup", "/en/login", "/en/signup", "/fr/login", "/fr/signup", "/es/login", "/es/signup"]);
const isPublicApi = createRouteMatcher(["/api/auth(.*)"]);
const isPublicRoute = createRouteMatcher(["/landing(.*)", "/en/landing(.*)", "/fr/landing(.*)", "/es/landing(.*)"]);

function publicRequestOrigin() {
  return publicOriginFromEnvironment();
}

function redirectTo(request: NextRequest, dest: string) {
  const url = request.nextUrl.clone();
  const publicOrigin = publicRequestOrigin();
  if (publicOrigin && requestHostIsAllowed(request.headers.get("host"), publicOrigin) && effectiveRequestProtocol(request) === "https:") {
    url.protocol = publicOrigin.protocol;
    url.hostname = publicOrigin.hostname;
    url.port = publicOrigin.port;
  }
  const parsed = new URL(dest, url.origin);
  url.pathname = parsed.pathname;
  url.search = parsed.search;
  return NextResponse.redirect(url);
}

const authMiddleware = convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  if (isPublicApi(request)) {
    return;
  }

  const { pathname, searchParams } = request.nextUrl;
  if (pathname.startsWith("/shared-browser-viewer/")) return NextResponse.next({ request: { headers: request.headers } });
  if (
    /^\/api\/files\/[^/]+\/?$/.test(pathname) ||
    /^\/api\/uploads\/?$/.test(pathname) ||
    pathname.startsWith("/api/shared-browser/") ||
    pathname.startsWith("/api/internal/shared-browser/")
  ) return;

  // Retired native distribution surfaces must not redirect to login or serve assets.
  if (/^\/(api\/download(?:\/|$)|os-control(?:\/|$)|downloads\/(?:mira-desktop-agent\.zip|mira_sharer\.exe|MID_DAY_REPORT_2026-10-16\.txt)$|mira-desktop-agent\.zip$)/.test(pathname)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  // Block access to source maps across all routes
  if (pathname.endsWith(".map") || pathname.includes(".map/")) {
    return new NextResponse("Not Found", { status: 404 });
  }

  // Root or locale-only requests (/ or /en or /fr or /es) -> Landing page (or studio if authed)
  if (
    pathname === "/" ||
    pathname === "/en" ||
    pathname === "/es" ||
    pathname === "/fr"
  ) {
    let authed = false;
    try {
      authed = await convexAuth.isAuthenticated();
    } catch {
      authed = false;
    }
    if (authed) {
      return redirectTo(request, "/screenshare");
    }
    return redirectTo(request, "/landing");
  }

  if (isPublicRoute(request)) {
    return I18nMiddleware(request);
  }

  if (
    pathname.includes("/screenshare") &&
    (searchParams.has("room") || searchParams.has("code"))
  ) {
    return I18nMiddleware(request);
  }

  let isAuthenticated = false;
  try {
    isAuthenticated = await convexAuth.isAuthenticated();
  } catch {
    isAuthenticated = false;
  }

  const isSignIn = isSignInPage(request);
  if (isSignIn && isAuthenticated) {
    const redirectTarget = searchParams.get("redirect");
    if (
      redirectTarget?.startsWith("/") &&
      !redirectTarget.startsWith("/login") &&
      !redirectTarget.startsWith("/signup")
    ) {
      return redirectTo(request, redirectTarget);
    }
    return redirectTo(request, "/screenshare");
  }

  if (!isSignIn && !isAuthenticated) {
    const dest = `${pathname}${request.nextUrl.search}`;
    return redirectTo(request, `/login?redirect=${encodeURIComponent(dest)}`);
  }

  return I18nMiddleware(request);
}, { convexUrl: process.env.CONVEX_INTERNAL_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL });

// Auth SDK 0.0.80 responds with JSON null on backend failures; its client then
// dereferences result.redirect. Normalize only that failed proxy response while
// retaining the SDK's cookie-clearing headers and successful session behavior.
async function routeMiddleware(request: NextRequest, event: NextFetchEvent) {
  const publicOrigin = publicOriginFromEnvironment();
  if (!publicOrigin) return new NextResponse("Server origin policy unavailable", { status: 503 });
  if (!requestHostIsAllowed(request.headers.get("host"), publicOrigin)) return new NextResponse("Invalid host", { status: 421 });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
  const isSignInAction = request.method === "POST" && /^\/api\/auth\/?$/.test(request.nextUrl.pathname)
    ? (await request.clone().json().catch(() => null))?.action === "auth:signIn"
    : false;
  const response = await authMiddleware(request, event);
  const location = response?.headers.get('location');
  if (location) {
    const target = new URL(location, request.url);
    const host = request.headers.get("host");
    if (host && requestHostIsAllowed(host, publicOrigin) && effectiveRequestProtocol(request) === "https:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      target.protocol = publicOrigin.protocol;
      target.hostname = publicOrigin.hostname;
      target.port = publicOrigin.port;
      response?.headers.set('location', target.href);
    }
  }
  const rewrite = response?.headers.get('x-middleware-rewrite');
  if (rewrite && process.env.MIRA_INTERNAL_ORIGIN) {
    const target = new URL(rewrite);
    const listener = new URL(process.env.MIRA_INTERNAL_ORIGIN);
    if (!['127.0.0.1', '[::1]'].includes(listener.hostname)) throw new Error('Internal listener must be loopback');
    response?.headers.set('x-middleware-rewrite', `${listener.protocol}//${listener.host}${target.pathname}${target.search}`);
  }
  if (isSignInAction && response) {
    const body = await response.clone().text();
    if (body.trim() === "null") {
      console.warn("[auth] proxy rejected authentication");
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new NextResponse(JSON.stringify({ tokens: null }), { status: 401, headers });
    }
  }
  return response;
}

export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  const nonce = createCspNonce();
  const viewerRoute = request.nextUrl.pathname.startsWith('/shared-browser-viewer/');
  const policy = buildContentSecurityPolicy({ nonce, development: process.env.NODE_ENV === 'development', livekitUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL || undefined, sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN, frameAncestors: viewerRoute ? "'self'" : "'none'" });
  request.headers.set('x-nonce', nonce); request.headers.set('Content-Security-Policy', policy);
  const response = await routeMiddleware(request, event);
  const secured = applySecurityHeaders(response ?? NextResponse.next({ request: { headers: request.headers } }), nonce, policy, request.headers);
  if (viewerRoute) secured.headers.delete('x-frame-options');
  return secured;
}

export const config = {
  matcher: [
    "/((?!_next/static|api|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    "/((?!.*\\..*|_next).*)",
    "/",
    "/(api|trpc)(.*)",
  ],
};
