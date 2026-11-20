import { describe, expect, it, vi } from "vitest";
import { consumeViewerFragment } from "./viewer-fragment";

describe("Shared Browser viewer fragment handoff", () => {
  it("returns the token and immediately removes the fragment while preserving the query", () => {
    const replaceState = vi.fn();
    const token = consumeViewerFragment({ hash: "#token=opaque.jwt.value&ignored=1", pathname: "/shared-browser-viewer/session-1", search: "?locale=en" } as Location, { replaceState } as unknown as History);
    expect(token).toBe("opaque.jwt.value");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/shared-browser-viewer/session-1?locale=en");
  });

  it("still clears malformed or missing token fragments", () => {
    const replaceState = vi.fn();
    expect(consumeViewerFragment({ hash: "#not-token", pathname: "/shared-browser-viewer/session-1", search: "" } as Location, { replaceState } as unknown as History)).toBe("");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/shared-browser-viewer/session-1");
  });
});
