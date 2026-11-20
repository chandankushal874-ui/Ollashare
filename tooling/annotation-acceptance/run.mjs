import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { chromium, webkit } from "playwright";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const appSource = path.join(root, "apps/app/src");
const entry = path.join(here, "harness.tsx");

const bundle = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["chrome110", "safari16"],
    jsx: "automatic",
    sourcemap: "inline",
    plugins: [{
        name: "app-alias",
        setup(build) {
            build.onResolve({ filter: /^@\// }, (args) => {
                const base = path.join(appSource, args.path.slice(2));
                const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
                    .find((candidate) => fs.existsSync(candidate));
                return resolved ? { path: resolved } : undefined;
            });
        },
    }],
});
const bundleText = bundle.outputFiles[0].text;
const originalCwd = process.cwd();
process.chdir(path.join(root, "apps/app"));
const tailwindResult = await postcss([
    tailwindcss({ config: path.join(root, "apps/app/tailwind.config.ts") }),
]).process("@tailwind utilities;", { from: undefined });
process.chdir(originalCwd);
const tailwindCss = tailwindResult.css;

let version = 0;
let sequence = 0;
let allowedGuests = new Set();
let events = [];
const strokeOwners = new Map();
const counts = { accepted: 0, rejected: 0 };

function targetKey(targetKind, targetId) {
    return `${targetKind}\u0000${targetId}`;
}

function resetState() {
    version += 1;
    sequence = 0;
    allowedGuests = new Set();
    events = [];
    strokeOwners.clear();
    counts.accepted = 0;
    counts.rejected = 0;
}

function snapshot() {
    return {
        version,
        allowedGuests: [...allowedGuests],
        events,
    };
}

function reject(message, status = 403) {
    counts.rejected += 1;
    return { status, body: { error: message } };
}

function acceptAction(body) {
    const type = body?.type;
    if (type === "reset") {
        resetState();
        return { status: 200, body: snapshot() };
    }
    if (type === "grant" || type === "revoke") {
        if (body.participantId !== "host" || body.guestId !== "guest") return reject("host authorization required");
        if (type === "grant") allowedGuests.add("guest");
        else allowedGuests.delete("guest");
        version += 1;
        counts.accepted += 1;
        return { status: 200, body: snapshot() };
    }
    if (type !== "operation") return reject("unknown action", 400);

    const participantId = String(body.participantId ?? "");
    const participantName = String(body.participantName ?? "Participant");
    const targetKind = body.targetKind;
    const targetId = String(body.targetId ?? "");
    const operation = body.operation;
    if ((targetKind !== "screen" && targetKind !== "shared-browser") || !targetId || !operation) return reject("invalid annotation target", 400);
    const isHost = participantId === "host";
    if (!isHost && !allowedGuests.has(participantId)) return reject("annotation permission denied");
    const key = targetKey(targetKind, targetId);

    if (operation.kind === "stroke") {
        if (!operation.strokeId || !Array.isArray(operation.points) || operation.points.length < 2) return reject("invalid stroke", 400);
        strokeOwners.set(`${key}\u0000${operation.strokeId}`, participantId);
    } else if (operation.kind === "erase") {
        const owner = strokeOwners.get(`${key}\u0000${operation.strokeId}`);
        if (!owner) return reject("stroke not found", 404);
        if (!isHost && owner !== participantId) return reject("cannot erase another participant's annotation");
        strokeOwners.delete(`${key}\u0000${operation.strokeId}`);
    } else if (operation.kind === "clear") {
        if (operation.scope === "all" && !isHost) return reject("only host may clear all annotations");
        for (const ownerKey of [...strokeOwners.keys()]) {
            if (!ownerKey.startsWith(`${key}\u0000`)) continue;
            if (operation.scope === "all" || strokeOwners.get(ownerKey) === participantId) strokeOwners.delete(ownerKey);
        }
    } else {
        return reject("invalid operation", 400);
    }

    sequence += 1;
    const event = {
        sequence,
        targetKind,
        targetId,
        kind: operation.kind,
        actorId: participantId,
        actorName: participantName,
        strokeId: operation.strokeId,
        color: operation.color,
        width: operation.width,
        tool: operation.tool,
        opacity: operation.opacity,
        points: operation.points,
        clearScope: operation.scope,
        createdAt: Date.now(),
    };
    events.push(event);
    version += 1;
    counts.accepted += 1;
    return { status: 200, body: { event, version } };
}

const indexHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Annotation Acceptance</title><style>${tailwindCss}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/bundle.js") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(bundleText);
        return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(snapshot()));
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
        let raw = "";
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => {
            try {
                const result = acceptAction(JSON.parse(raw || "{}"));
                response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
                response.end(JSON.stringify(result.body));
            } catch (error) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            }
        });
        return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(indexHtml);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

const results = [];
const defects = [];

function record(engine, viewport, scenario, status, detail = "") {
    results.push({ engine, viewport, scenario, status, detail });
    const symbol = status === "passed" ? "PASS" : status === "blocked" ? "BLOCK" : "FAIL";
    console.log(`${symbol} | ${engine} | ${viewport} | ${scenario}${detail ? ` | ${detail}` : ""}`);
}

async function expectEventually(fn, message, timeout = 5000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeout) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
    }
    if (lastError) throw lastError;
    throw new Error(message);
}

async function clickByLabel(page, label) {
    await page.getByLabel(label, { exact: true }).click();
}

async function dragOn(page, testId, from, to, steps = 8) {
    const element = page.getByTestId(testId);
    const box = await element.boundingBox();
    assert.ok(box, `${testId} must have a bounding box`);
    await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * to.x, box.y + box.height * to.y, { steps });
    await page.mouse.up();
}

async function clickOn(page, testId, point) {
    const element = page.getByTestId(testId);
    const box = await element.boundingBox();
    assert.ok(box, `${testId} must have a bounding box`);
    await page.mouse.click(box.x + box.width * point.x, box.y + box.height * point.y);
}

async function resetVia(page) {
    await page.evaluate(async () => {
        await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "reset" }) });
    });
}

async function countStrokes(page, targetId) {
    return page.locator(`[aria-label="Screen annotations ${targetId}"] polyline`).count();
}

async function runDesktopAcceptance(browserType, engineName, viewport) {
    const browser = await browserType.launch({ headless: true });
    const hostContext = await browser.newContext({ viewport });
    const guestContext = await browser.newContext({ viewport });
    const viewerContext = await browser.newContext({ viewport });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const viewer = await viewerContext.newPage();
    const consoleErrors = [];
    for (const page of [host, guest, viewer]) {
        page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
        page.on("pageerror", (error) => consoleErrors.push(error.message));
    }
    try {
        await Promise.all([
            host.goto(`${baseUrl}/?role=host`),
            guest.goto(`${baseUrl}/?role=guest`),
            viewer.goto(`${baseUrl}/?role=viewer`),
        ]);
        await resetVia(host);
        await expectEventually(async () => (await host.getByTestId("status").textContent())?.includes("drawing allowed"), "host state ready");

        for (const target of ["host-screen", "guest-screen"]) {
            assert.equal(await host.getByTestId(`toolbar-${target}`).count(), 1);
            assert.equal(await viewer.getByTestId(`toolbar-${target}`).count(), 0);
            assert.equal(await guest.getByTestId(`toolbar-${target}`).count(), 0);
        }
        record(engineName, `${viewport.width}x${viewport.height}`, "regular host tools on host/guest tiles; guest/viewer denied before grant", "passed");

        await clickByLabel(host, "Draw on host-screen");
        await dragOn(host, "surface-host-screen", { x: 0.18, y: 0.22 }, { x: 0.55, y: 0.52 });
        await expectEventually(() => countStrokes(viewer, "host-screen").then((count) => count === 1), "viewer reconstructs host stroke");
        assert.equal(await countStrokes(guest, "host-screen"), 1);
        record(engineName, `${viewport.width}x${viewport.height}`, "viewer synchronizes host stroke while remaining view-only", "passed");

        const beforeDeniedAttempt = events.length;
        await dragOn(guest, "surface-host-screen", { x: 0.2, y: 0.8 }, { x: 0.7, y: 0.7 });
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(events.length, beforeDeniedAttempt);
        record(engineName, `${viewport.width}x${viewport.height}`, "viewer/guest cannot draw before authoritative grant", "passed");

        await host.getByTestId("permission-toggle").click();
        await expectEventually(async () => await guest.getByTestId("toolbar-host-screen").count() === 1, "guest toolbar appears after grant");
        await clickByLabel(guest, "Draw on guest-screen");
        await clickByLabel(guest, "Highlighter guest-screen");
        await guest.getByLabel("Annotation width guest-screen").selectOption("8");
        await dragOn(guest, "surface-guest-screen", { x: 0.15, y: 0.3 }, { x: 0.78, y: 0.62 });
        await expectEventually(() => countStrokes(host, "guest-screen").then((count) => count === 1), "host reconstructs guest highlighter");
        await expectEventually(() => countStrokes(viewer, "guest-screen").then((count) => count === 1), "viewer reconstructs guest highlighter");
        const highlight = viewer.locator('[aria-label="Screen annotations guest-screen"] polyline').first();
        assert.equal(await highlight.getAttribute("stroke-opacity"), String(0.35));
        assert.equal(await highlight.getAttribute("stroke-width"), String(16));
        assert.equal(await highlight.getAttribute("data-tool"), "highlighter");
        record(engineName, `${viewport.width}x${viewport.height}`, "host grants guest; guest highlighter synchronizes to host/viewer and is translucent/wider", "passed");

        await clickByLabel(guest, "Eraser host-screen");
        await clickByLabel(guest, "Draw on host-screen");
        await clickOn(guest, "surface-host-screen", { x: 0.18, y: 0.22 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(await countStrokes(host, "host-screen"), 1, "guest must not erase host stroke");

        await clickByLabel(guest, "Pen host-screen");
        await dragOn(guest, "surface-host-screen", { x: 0.2, y: 0.78 }, { x: 0.72, y: 0.7 });
        await expectEventually(() => countStrokes(host, "host-screen").then((count) => count === 2), "guest own stroke appears");
        await clickByLabel(guest, "Eraser host-screen");
        await clickOn(guest, "surface-host-screen", { x: 0.2, y: 0.78 });
        await expectEventually(() => countStrokes(host, "host-screen").then((count) => count === 1), "guest erases own stroke");

        await clickByLabel(host, "Eraser guest-screen");
        await clickByLabel(host, "Draw on guest-screen");
        await clickOn(host, "surface-guest-screen", { x: 0.15, y: 0.3 });
        await expectEventually(() => countStrokes(viewer, "guest-screen").then((count) => count === 0), "host erases guest stroke");
        record(engineName, `${viewport.width}x${viewport.height}`, "host erase-any and guest erase-own semantics", "passed");

        await host.getByTestId("layout-focused").click();
        assert.equal(await host.getByTestId("toolbar-host-screen").count(), 1);
        await host.getByRole("button", { name: "Guest screen", exact: true }).click();
        assert.equal(await host.getByTestId("toolbar-guest-screen").count(), 1);
        await host.getByTestId("layout-full").click();
        assert.equal(await host.getByTestId("toolbar-host-screen").count(), 1);
        assert.equal(await host.getByTestId("toolbar-guest-screen").count(), 1);
        record(engineName, `${viewport.width}x${viewport.height}`, "host tools remain available in focused and Full View layouts", "passed");

        await host.getByTestId("remote-control-toggle").click();
        const modeGroup = host.getByRole("group", { name: "Full View interaction mode" });
        await modeGroup.getByRole("button", { name: "Draw", exact: true }).click();
        await expectEventually(async () => (await host.getByTestId("interaction-state").textContent()) === "draw:true control:false", "draw mode exclusive");
        assert.equal(await host.getByTestId("surface-guest-screen").getAttribute("data-remote-input-enabled"), "false");
        await modeGroup.getByRole("button", { name: "Control", exact: true }).click();
        await expectEventually(async () => (await host.getByTestId("interaction-state").textContent()) === "draw:false control:true", "control mode exclusive");
        assert.equal(await host.getByTestId("surface-guest-screen").getAttribute("data-annotation-enabled"), "false");
        record(engineName, `${viewport.width}x${viewport.height}`, "Full View Draw/Control are mutually exclusive", "passed");

        await host.getByTestId("remote-control-toggle").click();
        await host.getByTestId("layout-regular").click();
        const hostBrowserToolbar = host.getByRole("toolbar", { name: "Shared Browser annotation tools" });
        assert.equal(await hostBrowserToolbar.count(), 1);
        assert.equal(await viewer.getByRole("toolbar", { name: "Shared Browser annotation tools" }).count(), 0);
        await hostBrowserToolbar.locator('button[title="Draw mode"]').click();
        const hostCanvas = host.getByLabel("Shared Browser annotations");
        const canvasBox = await hostCanvas.boundingBox();
        assert.ok(canvasBox);
        await host.mouse.move(canvasBox.x + 30, canvasBox.y + 40);
        await host.mouse.down();
        await host.mouse.move(canvasBox.x + 180, canvasBox.y + 140, { steps: 8 });
        await host.mouse.up();
        await expectEventually(() => viewer.evaluate(() => document.querySelectorAll('canvas[aria-label="Shared Browser annotations"]').length === 1), "viewer browser canvas mounted");
        await expectEventually(() => Promise.resolve(events.some((event) => event.targetKind === "shared-browser" && event.actorId === "host")), "shared browser host event accepted");
        record(engineName, `${viewport.width}x${viewport.height}`, "real SharedBrowserAnnotationOverlay host draw and viewer reconstruction path", "passed");

        await host.getByTestId("permission-toggle").click();
        await expectEventually(async () => await guest.getByTestId("toolbar-host-screen").count() === 0, "guest toolbar removed after revoke");
        assert.equal(await guest.getByTestId("surface-host-screen").getAttribute("data-annotation-enabled"), "false");
        const afterRevoke = events.length;
        await dragOn(guest, "surface-host-screen", { x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 });
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(events.length, afterRevoke);
        assert.equal(await guest.getByRole("toolbar", { name: "Shared Browser annotation tools" }).count(), 0);
        record(engineName, `${viewport.width}x${viewport.height}`, "revoke disables screen and shared-browser drawing without reload", "passed");

        if (consoleErrors.length > 0) defects.push({ engine: engineName, defect: "browser console errors", detail: consoleErrors });
    } finally {
        await Promise.all([hostContext.close(), guestContext.close(), viewerContext.close()]);
        await browser.close();
    }
}

async function runResponsiveAcceptance(browserType, engineName, contextOptions, label) {
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
        await page.goto(`${baseUrl}/?role=host`);
        await resetVia(page);
        await expectEventually(async () => (await page.getByTestId("status").textContent())?.includes("drawing allowed"), "mobile state ready");
        const toolbar = page.getByTestId("toolbar-host-screen");
        const toolbarStyle = await toolbar.evaluate((element) => ({
            overflowX: getComputedStyle(element).overflowX,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            rect: element.getBoundingClientRect().toJSON(),
        }));
        assert.ok(["auto", "scroll"].includes(toolbarStyle.overflowX));
        assert.ok(toolbarStyle.rect.left >= -1 && toolbarStyle.rect.right <= contextOptions.viewport.width + 1);
        const controlSizes = await toolbar.locator("button,select").evaluateAll((elements) => elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
        }));
        assert.ok(controlSizes.length >= 8);
        const undersizedScreenControls = controlSizes.filter((size) => size.height < 44 || size.width < 44);
        if (undersizedScreenControls.length > 0) {
            record(engineName, label, "screen annotation controls meet 44x44 minimum", "failed", JSON.stringify(undersizedScreenControls));
        } else {
            record(engineName, label, "screen annotation controls meet 44x44 minimum", "passed");
        }
        const firstButton = toolbar.locator("button").first();
        const unobstructed = await firstButton.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit === element || Boolean(hit && element.contains(hit));
        });
        assert.equal(unobstructed, true);

        const browserToolbar = page.getByRole("toolbar", { name: "Shared Browser annotation tools" });
        const browserControlSizes = await browserToolbar.locator("button,select").evaluateAll((elements) => elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
        }));
        assert.ok(browserControlSizes.length >= 8);
        const undersizedBrowserControls = browserControlSizes.filter((size) => size.height < 44 || size.width < 44);
        if (undersizedBrowserControls.length > 0) {
            record(engineName, label, "shared-browser annotation controls meet 44x44 minimum", "failed", JSON.stringify(undersizedBrowserControls));
        } else {
            record(engineName, label, "shared-browser annotation controls meet 44x44 minimum", "passed");
        }

        await page.getByTestId("layout-full").click();
        await page.getByTestId("remote-control-toggle").click();
        const hud = page.getByTestId("full-view-hud");
        const hudMetrics = await hud.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, overflowX: getComputedStyle(element).overflowX, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
        });
        assert.ok(hudMetrics.left >= -1 && hudMetrics.right <= contextOptions.viewport.width + 1);
        assert.ok(hudMetrics.top >= 0);
        assert.ok(["auto", "scroll"].includes(hudMetrics.overflowX));
        const hudSizes = await hud.locator("button").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
        assert.ok(hudSizes.every((height) => height >= 44), JSON.stringify(hudSizes));
        const drawButton = hud.getByRole("button", { name: "Draw", exact: true });
        await drawButton.scrollIntoViewIfNeeded();
        await drawButton.click();
        assert.equal(await page.getByTestId("interaction-state").textContent(), "draw:true control:false");
        record(engineName, label, "mobile controls remain visible, horizontally scrollable, and not overlay-blocked", "passed", `toolbar ${toolbarStyle.clientWidth}/${toolbarStyle.scrollWidth}; hud ${hudMetrics.clientWidth}/${hudMetrics.scrollWidth}`);
        if (pageErrors.length > 0) defects.push({ engine: engineName, defect: "mobile page errors", detail: pageErrors });
    } finally {
        await context.close();
        await browser.close();
    }
}

try {
    await runDesktopAcceptance(chromium, "Chromium", { width: 1440, height: 1000 });
    await runDesktopAcceptance(webkit, "WebKit", { width: 1280, height: 900 });
    await runResponsiveAcceptance(chromium, "Chromium", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, "390x844 mobile");
    await runResponsiveAcceptance(webkit, "WebKit", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }, "390x844 iOS-like");
} catch (error) {
    defects.push({ engine: "runner", defect: error instanceof Error ? error.message : String(error), detail: error instanceof Error ? error.stack : "" });
    console.error(error);
} finally {
    await new Promise((resolve) => server.close(resolve));
}

const failed = results.filter((result) => result.status === "failed").length + defects.length;
const summary = {
    passed: results.filter((result) => result.status === "passed").length,
    blocked: results.filter((result) => result.status === "blocked").length,
    failed,
    acceptedActions: counts.accepted,
    rejectedActions: counts.rejected,
    results,
    defects,
};
console.log(`ANNOTATION_ACCEPTANCE_SUMMARY=${JSON.stringify(summary)}`);
if (failed > 0) process.exitCode = 1;
