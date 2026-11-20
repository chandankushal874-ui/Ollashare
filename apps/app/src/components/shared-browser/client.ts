import {
  assertShortLivedViewerGrant,
  type IssueSharedBrowserGrantRequest,
  type ProvisionSharedBrowserRequest,
  type SharedBrowserGrant,
  type SharedBrowserSession,
} from "./contract";

const API_ROOT = "/api/shared-browser";

export class SharedBrowserRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SharedBrowserRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body) headers.set("Content-Type", "application/json");

  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new SharedBrowserRequestError(
      body?.message ??
        (response.status === 404
          ? "Shared Browser backend is not connected yet."
          : `Shared Browser request failed (${response.status}).`),
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const sharedBrowserClient = {
  getSession(roomCode: string) {
    return request<SharedBrowserSession | null>(
      `/sessions/current?roomCode=${encodeURIComponent(roomCode)}`,
    );
  },

  provision(input: ProvisionSharedBrowserRequest) {
    return request<SharedBrowserSession>("/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async issueGrant(
    sessionId: string,
    input: IssueSharedBrowserGrantRequest,
  ) {
    const grant = await request<SharedBrowserGrant | { sessionEnded: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/grants`,
      { method: "POST", body: JSON.stringify(input) },
    );
    if ("sessionEnded" in grant) throw new SharedBrowserRequestError("This Shared Browser session ended. Reconnect to the current room session.", 410);
    return assertShortLivedViewerGrant(grant);
  },

  revokeGrant(sessionId: string, grantId: string) {
    return request<void>(
      `/sessions/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE" },
    );
  },
  grantController(sessionId: string, viewerId: string) {
    return request<{ controllerUserId: string; leaseId: string; expiresAt: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/controller`,
      { method: "POST", body: JSON.stringify({ viewerId }) },
    );
  },

  revokeController(sessionId: string, viewerId: string) {
    return request<void>(
      `/sessions/${encodeURIComponent(sessionId)}/controller`,
      { method: "DELETE", body: JSON.stringify({ viewerId }) },
    );
  },

  terminate(sessionId: string) {
    return request<void>(
      `/sessions/${encodeURIComponent(sessionId)}/terminate`,
      { method: "POST" },
    );
  },
};
