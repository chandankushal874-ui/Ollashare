import assert from "node:assert/strict";
import test from "node:test";
import {
    isAllowedPermission,
    isSafeExternalUrl,
    isTrustedNavigation,
    resolveAppUrl,
} from "./security.mjs";

test("desktop URL requires HTTPS except for local development", () => {
    assert.equal(
        resolveAppUrl({ MIRA_DESKTOP_URL: "https://mira.example/en/landing" })
            .href,
        "https://mira.example/en/landing",
    );
    assert.equal(
        resolveAppUrl({ MIRA_DESKTOP_URL: "http://127.0.0.1:3000" }).origin,
        "http://127.0.0.1:3000",
    );
    assert.throws(
        () => resolveAppUrl({ MIRA_DESKTOP_URL: "http://mira.example" }),
        /HTTPS/,
    );
    assert.throws(
        () => resolveAppUrl({ MIRA_DESKTOP_URL: "file:///tmp/index.html" }),
        /Unsupported/,
    );
});

test("navigation is restricted to the configured application origin", () => {
    const appUrl = new URL("https://mira.example/en/landing");
    assert.equal(isTrustedNavigation("https://mira.example/en/screenshare", appUrl), true);
    assert.equal(isTrustedNavigation("https://evil.example/", appUrl), false);
    assert.equal(isTrustedNavigation("not-a-url", appUrl), false);
});

test("external links and permissions are fail-closed", () => {
    const appUrl = new URL("https://mira.example/en/landing");
    assert.equal(isSafeExternalUrl("https://docs.example/"), true);
    assert.equal(isSafeExternalUrl("mailto:support@example.com"), true);
    assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
    assert.equal(
        isAllowedPermission("media", "https://mira.example/en/screenshare", appUrl),
        true,
    );
    assert.equal(
        isAllowedPermission(
            "display-capture",
            "https://mira.example/en/screenshare",
            appUrl,
        ),
        true,
    );
    assert.equal(
        isAllowedPermission("geolocation", "https://mira.example/", appUrl),
        false,
    );
    assert.equal(
        isAllowedPermission("media", "https://evil.example/", appUrl),
        false,
    );
});
