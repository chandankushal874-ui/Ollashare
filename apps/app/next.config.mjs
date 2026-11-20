import "./src/env.mjs";
import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  generateEtags: false,
  // Preserve the listener URL so locale rewrites stay internal behind TLS termination.
  skipMiddlewareUrlNormalize: true,
  transpilePackages: ["@v1/ui", "@v1/backend", "@v1/analytics", "@v1/logger"],
  productionBrowserSourceMaps: false,
  typescript: {
    ignoreBuildErrors: process.env.MIRA_DEPLOY_IGNORE_TYPE_ERRORS === "1",
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  webpack: (config, { dev }) => {
    if (!dev) {
      config.devtool = false;
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/shared-browser-viewer/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), display-capture=(), geolocation=(), clipboard-read=(), clipboard-write=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
      {
        source: "/((?!shared-browser-viewer/).*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), display-capture=(self), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
  widenClientFileUpload: false,
  hideSourceMaps: true,
  disableLogger: true,
  sourcemaps: {
    disable: true,
    deleteSourcemapsAfterUpload: true,
  },
});
