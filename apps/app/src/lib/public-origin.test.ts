import { afterEach, describe, expect, it } from "vitest";
import { effectiveRequestProtocol, isQuickTunnelHost, parsePublicOrigin, requestHostIsAllowed, verifiedHostingMode } from "./public-origin";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("public origin configuration", () => {
  it("accepts a canonical HTTPS origin", () => {
    expect(parsePublicOrigin("https://app.example.com").href).toBe("https://app.example.com/");
  });

  it.each([
    "http://app.example.com",
    "https://localhost",
    "https://app.example.com/path",
    "https://user@app.example.com",
    "https://app.example.com:8443",
  ])("rejects unsafe or non-canonical origins", (value) => {
    expect(() => parsePublicOrigin(value)).toThrow();
  });

  it("rejects quick tunnels only when named-tunnel enforcement is enabled", () => {
    const original = process.env.MIRA_ENFORCE_NAMED_TUNNEL;
    process.env.MIRA_ENFORCE_NAMED_TUNNEL = "1";
    expect(() => parsePublicOrigin("https://temporary.trycloudflare.com")).toThrow("quick tunnel");
    process.env.MIRA_ENFORCE_NAMED_TUNNEL = original;
  });

  it("matches only the canonical origin host", () => {
    const origin = parsePublicOrigin("https://app.example.com");
    expect(requestHostIsAllowed("app.example.com", origin)).toBe(true);
    expect(requestHostIsAllowed("app.example.com:443", origin)).toBe(false);
    expect(requestHostIsAllowed("attacker.example", origin)).toBe(false);
  });

  it("identifies Cloudflare quick-tunnel hosts", () => {
    expect(isQuickTunnelHost("example.trycloudflare.com")).toBe(true);
    expect(isQuickTunnelHost("app.example.com")).toBe(false);
  });

  it("uses the fail-closed loopback deployment mode without trusting request headers", () => {
    process.env.MIRA_HOSTING_MODE = "loopback-proxy";
    process.env.MIRA_TRUSTED_PROXY = "loopback";
    const request = new Request("http://127.0.0.1", { headers: { "x-forwarded-proto": "http", "x-mira-trusted-proxy": "forged" } });
    expect(verifiedHostingMode()).toBe("loopback-proxy");
    expect(effectiveRequestProtocol(request)).toBe("https:");
  });

  it("rejects incomplete hosting modes and accepts only platform-injected Vercel mode", () => {
    process.env.MIRA_HOSTING_MODE = "vercel";
    process.env.PUBLIC_ORIGIN = "https://app.example.com";
    process.env.VERCEL_URL = "app.example.com";
    expect(verifiedHostingMode()).toBeNull();
    expect(effectiveRequestProtocol(new Request("https://app.example.com"))).toBe("http:");

    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    expect(verifiedHostingMode()).toBe("vercel");
    expect(effectiveRequestProtocol(new Request("https://app.example.com", { headers: { host: "app.example.com" } }))).toBe("https:");
  });
});
