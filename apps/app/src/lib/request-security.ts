import { effectiveRequestProtocol, publicOriginFromEnvironment } from "./public-origin";

export function isSameOriginMutation(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const publicOrigin = publicOriginFromEnvironment();
  if (!publicOrigin) return false;
  const protocol = effectiveRequestProtocol(request);
  const origin = `${protocol}//${request.headers.get("host") ?? new URL(request.url).host}`;
  return origin === publicOrigin.origin &&
    request.headers.get("origin") === publicOrigin.origin &&
    (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
}
