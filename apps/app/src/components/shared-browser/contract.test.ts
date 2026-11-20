import { describe, expect, it } from "vitest";
import {
  assertShortLivedViewerGrant,
  type SharedBrowserGrant,
} from "./contract";

const now = Date.parse("2026-10-28T09:00:00.000Z");

function grant(overrides: Partial<SharedBrowserGrant> = {}): SharedBrowserGrant {
  return {
    id: "grant-1",
    sessionId: "browser-1",
    access: "view-only",
    viewerUrl: "https://viewer.example.test/shared-browser-viewer/browser-1#token=opaque",
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
}

describe("assertShortLivedViewerGrant", () => {
  it("accepts an expiring HTTPS viewer grant", () => {
    expect(assertShortLivedViewerGrant(grant(), now)).toEqual(grant());
  });

  it("accepts bounded browser/server clock skew", () => {
    expect(() =>
      assertShortLivedViewerGrant(
        grant({ expiresAt: new Date(now + 5 * 60_000 + 5_000).toISOString() }),
        now,
      ),
    ).not.toThrow();
  });

  it("rejects expired and long-lived grants", () => {
    expect(() =>
      assertShortLivedViewerGrant(
        grant({ expiresAt: new Date(now - 1).toISOString() }),
        now,
      ),
    ).toThrow("expired");
    expect(() =>
      assertShortLivedViewerGrant(
        grant({ expiresAt: new Date(now + 10 * 60_000).toISOString() }),
        now,
      ),
    ).toThrow("not short-lived");
  });

  it("rejects insecure remote URLs and embedded credentials", () => {
    expect(() =>
      assertShortLivedViewerGrant(
        grant({ viewerUrl: "http://viewer.example.test/session" }),
        now,
      ),
    ).toThrow("insecure");
    expect(() =>
      assertShortLivedViewerGrant(
        grant({ viewerUrl: "https://user:secret@viewer.example.test/session" }),
        now,
      ),
    ).toThrow("credentials");
  });
});
