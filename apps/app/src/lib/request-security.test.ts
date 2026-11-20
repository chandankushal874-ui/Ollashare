import { afterEach, describe, expect, it } from "vitest";
import { isSameOriginMutation } from "./request-security";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("isSameOriginMutation", () => {
  it("accepts an HTTPS browser mutation only in the verified loopback deployment mode", () => {
    process.env.PUBLIC_ORIGIN = "https://app.example.com";
    process.env.MIRA_HOSTING_MODE = "loopback-proxy";
    process.env.MIRA_TRUSTED_PROXY = "loopback";
    const request = new Request("http://app.example.com/api/auth", {
      method: "POST",
      headers: {
        host: "app.example.com",
        origin: "https://app.example.com",
        "sec-fetch-site": "same-origin",
        "x-forwarded-proto": "http",
        "x-mira-trusted-proxy": "forged",
      },
    });

    expect(isSameOriginMutation(request)).toBe(true);
  });

  it("fails closed without an explicit verified hosting mode", () => {
    process.env.PUBLIC_ORIGIN = "https://app.example.com";
    process.env.MIRA_TRUSTED_PROXY = "loopback";
    const request = new Request("http://app.example.com/api/auth", {
      method: "POST",
      headers: {
        host: "app.example.com",
        origin: "https://app.example.com",
        "sec-fetch-site": "same-origin",
        "x-forwarded-proto": "https",
        "x-mira-trusted-proxy": "loopback",
      },
    });

    expect(isSameOriginMutation(request)).toBe(false);
  });

  it("rejects a cross-origin mutation", () => {
    process.env.PUBLIC_ORIGIN = "https://app.example.com";
    process.env.MIRA_HOSTING_MODE = "loopback-proxy";
    process.env.MIRA_TRUSTED_PROXY = "loopback";
    const request = new Request("http://app.example.com/api/auth", {
      method: "POST",
      headers: {
        host: "app.example.com",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "x-forwarded-proto": "https",
        "x-mira-trusted-proxy": "loopback",
      },
    });

    expect(isSameOriginMutation(request)).toBe(false);
  });
});
