import { describe, expect, test } from "vitest";
import nextConfig from "./next.config.mjs";

describe("production disclosure hardening", () => {
  test("disables framework identity and browser source maps", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.generateEtags).toBe(false);
    expect(nextConfig.productionBrowserSourceMaps).toBe(false);
  });

  test("removes console calls from production bundles", () => {
    expect(nextConfig.compiler?.removeConsole).toBe(true);
  });

});
