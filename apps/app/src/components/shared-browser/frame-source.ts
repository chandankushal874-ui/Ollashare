export type SharedBrowserFrameConnectionState =
	| "checking"
	| "disconnected"
	| "loading"
	| "connected"
	| "failed";

export interface SharedBrowserFrameDimensions {
	width: number;
	height: number;
}

/** Read-only, same-origin handle to the single noVNC display canvas. */
export interface SharedBrowserFrameHandle {
	readonly sessionId: string;
	readonly connectionState: "connected";
	getDimensions(): SharedBrowserFrameDimensions | null;
	getCanvas(): HTMLCanvasElement | null;
}

export interface SharedBrowserFrameHandleInput {
	iframe: HTMLIFrameElement;
	sessionId: string;
	connectionState: SharedBrowserFrameConnectionState;
	expectedOrigin?: string;
}

function validSessionId(sessionId: string): boolean {
	return /^[A-Za-z0-9_;-]{1,160}$/.test(sessionId);
}

function getSameOriginDocument(
	iframe: HTMLIFrameElement,
	expectedOrigin: string,
): Document | null {
	try {
		const source = iframe.getAttribute("src");
		if (!source) return null;
		const frameUrl = new URL(source, expectedOrigin);
		if (frameUrl.origin !== expectedOrigin) return null;
		const frameWindow = iframe.contentWindow;
		if (!frameWindow || frameWindow.location.origin !== expectedOrigin)
			return null;
		return iframe.contentDocument;
	} catch {
		return null;
	}
}

function findSingleNoVncCanvas(
	document: Document,
	sessionId: string,
): HTMLCanvasElement | null {
	const roots = Array.from(
		document.querySelectorAll<HTMLElement>("[data-mira-shared-browser-root]"),
	).filter((root) => root.dataset.sessionId === sessionId);
	if (roots.length !== 1) return null;
	const targets = roots[0]?.querySelectorAll<HTMLElement>(
		"[data-mira-novnc-target]",
	);
	if (!targets || targets.length !== 1) return null;
	const canvases = targets[0]?.querySelectorAll<HTMLCanvasElement>("canvas");
	if (!canvases || canvases.length !== 1) return null;
	const canvas = canvases[0];
	if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
	return canvas;
}

/**
 * Creates a guarded canvas accessor without retaining credentials, viewer URLs, or
 * a mutable reference to the noVNC canvas. Every read revalidates origin and shape.
 */
export function createSharedBrowserFrameHandle({
	iframe,
	sessionId,
	connectionState,
	expectedOrigin = window.location.origin,
}: SharedBrowserFrameHandleInput): SharedBrowserFrameHandle | null {
	if (connectionState !== "connected" || !validSessionId(sessionId))
		return null;
	const initialDocument = getSameOriginDocument(iframe, expectedOrigin);
	if (!initialDocument || !findSingleNoVncCanvas(initialDocument, sessionId))
		return null;

	const getCanvas = (): HTMLCanvasElement | null => {
		const document = getSameOriginDocument(iframe, expectedOrigin);
		return document ? findSingleNoVncCanvas(document, sessionId) : null;
	};

	return Object.freeze({
		sessionId,
		connectionState: "connected" as const,
		getCanvas,
		getDimensions: () => {
			const canvas = getCanvas();
			return canvas ? { width: canvas.width, height: canvas.height } : null;
		},
	});
}
