export type SharedBrowserAccess = "controller" | "view-only";

export type SharedBrowserSessionState =
  | "provisioning"
  | "ready"
  | "terminating"
  | "terminated";

export interface SharedBrowserSession {
  id: string;
  roomCode: string;
  state: SharedBrowserSessionState;
  createdAt: string;
  isController?: boolean;
  controllerUserIds?: string[];
}

export interface SharedBrowserGrant {
  id: string;
  sessionId: string;
  access: SharedBrowserAccess;
  viewerUrl: string;
  expiresAt: string;
}

export interface ProvisionSharedBrowserRequest {
  roomCode: string;
}

export interface IssueSharedBrowserGrantRequest {
  roomCode: string;
  access: SharedBrowserAccess;
}

export interface SharedBrowserApiError {
  code: string;
  message: string;
}

export const SHARED_BROWSER_GRANT_MAX_LIFETIME_MS = 5 * 60 * 1000;
export const SHARED_BROWSER_GRANT_CLOCK_SKEW_MS = 30_000;

export function assertShortLivedViewerGrant(
  grant: SharedBrowserGrant,
  now = Date.now(),
): SharedBrowserGrant {
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("The Shared Browser access grant has expired.");
  }
  if (expiresAt - now > SHARED_BROWSER_GRANT_MAX_LIFETIME_MS + SHARED_BROWSER_GRANT_CLOCK_SKEW_MS) {
    throw new Error("The backend returned a grant that is not short-lived.");
  }

  const viewerUrl = new URL(grant.viewerUrl);
  const isLocalDevelopment =
    viewerUrl.protocol === "http:" &&
    (viewerUrl.hostname === "localhost" || viewerUrl.hostname === "127.0.0.1");
  if (viewerUrl.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("The backend returned an insecure Shared Browser viewer URL.");
  }
  if (viewerUrl.username || viewerUrl.password) {
    throw new Error("The Shared Browser viewer URL must not contain credentials.");
  }

  return grant;
}
