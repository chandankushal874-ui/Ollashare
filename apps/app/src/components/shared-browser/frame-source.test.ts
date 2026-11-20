// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createSharedBrowserFrameHandle } from "./frame-source";

function iframeWithDocument(
	document: Document,
	src = "https://mira.test/viewer",
) {
	const iframe = document.createElement("iframe");
	iframe.setAttribute("src", src);
	Object.defineProperty(iframe, "contentDocument", {
		configurable: true,
		value: document,
	});
	Object.defineProperty(iframe, "contentWindow", {
		configurable: true,
		value: { location: { origin: "https://mira.test" } },
	});
	return iframe;
}

function viewerDocument(sessionId: string, canvases = 1) {
	const document = window.document.implementation.createHTMLDocument();
	const root = document.createElement("main");
	root.dataset.miraSharedBrowserRoot = "viewer";
	root.dataset.sessionId = sessionId;
	const target = document.createElement("div");
	target.dataset.miraNovncTarget = "display";
	for (let index = 0; index < canvases; index += 1) {
		const canvas = document.createElement("canvas");
		canvas.width = 1920;
		canvas.height = 1080;
		target.append(canvas);
	}
	root.append(target);
	document.body.append(root);
	return document;
}

describe("Shared Browser noVNC frame source", () => {
	it("returns a read-only handle for one same-origin connected canvas", () => {
		const iframe = iframeWithDocument(viewerDocument("session-1"));
		const handle = createSharedBrowserFrameHandle({
			iframe,
			sessionId: "session-1",
			connectionState: "connected",
			expectedOrigin: "https://mira.test",
		});
		expect(handle?.sessionId).toBe("session-1");
		expect(handle?.connectionState).toBe("connected");
		expect(handle?.getDimensions()).toEqual({ width: 1920, height: 1080 });
		expect(handle?.getCanvas()?.tagName).toBe("CANVAS");
		expect(Object.keys(handle ?? {})).toEqual([
			"sessionId",
			"connectionState",
			"getCanvas",
			"getDimensions",
		]);
	});

	it("fails closed for disconnected, cross-origin, security, missing, and multiple canvases", () => {
		const document = viewerDocument("session-1");
		const iframe = iframeWithDocument(document);
		expect(
			createSharedBrowserFrameHandle({
				iframe,
				sessionId: "session-1",
				connectionState: "loading",
				expectedOrigin: "https://mira.test",
			}),
		).toBeNull();
		expect(
			createSharedBrowserFrameHandle({
				iframe: iframeWithDocument(document, "https://evil.test/viewer"),
				sessionId: "session-1",
				connectionState: "connected",
				expectedOrigin: "https://mira.test",
			}),
		).toBeNull();
		const blocked = iframeWithDocument(document);
		Object.defineProperty(blocked, "contentWindow", {
			configurable: true,
			get: () => {
				throw new DOMException("Blocked", "SecurityError");
			},
		});
		expect(
			createSharedBrowserFrameHandle({
				iframe: blocked,
				sessionId: "session-1",
				connectionState: "connected",
				expectedOrigin: "https://mira.test",
			}),
		).toBeNull();
		expect(
			createSharedBrowserFrameHandle({
				iframe: iframeWithDocument(viewerDocument("session-1", 0)),
				sessionId: "session-1",
				connectionState: "connected",
				expectedOrigin: "https://mira.test",
			}),
		).toBeNull();
		expect(
			createSharedBrowserFrameHandle({
				iframe: iframeWithDocument(viewerDocument("session-1", 2)),
				sessionId: "session-1",
				connectionState: "connected",
				expectedOrigin: "https://mira.test",
			}),
		).toBeNull();
	});
});
