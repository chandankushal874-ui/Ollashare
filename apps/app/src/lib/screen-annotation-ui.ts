import type { AnnotationStroke } from "./annotation-types";

export type FullViewInteractionMode = "draw" | "control";

export const FULL_VIEW_CONTROL_ROW_CLASS =
	"flex min-w-0 max-w-full items-center gap-2 overflow-x-auto overscroll-x-contain touch-pan-x [scrollbar-width:none] [&>*]:min-h-11 [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden";

export const PARTICIPANT_ACTION_ROW_CLASS =
	"flex flex-wrap items-center justify-end gap-1.5 [&>button]:min-h-11";

export function getFullViewInteractionState({
	mode,
	remoteControlActive,
	annotationAllowed,
	annotationSelected,
}: {
	mode: FullViewInteractionMode;
	remoteControlActive: boolean;
	annotationAllowed: boolean;
	annotationSelected: boolean;
}) {
	return {
		annotationEnabled:
			annotationAllowed &&
			annotationSelected &&
			(!remoteControlActive || mode === "draw"),
		remoteInputEnabled: remoteControlActive && mode === "control",
	};
}

export function createAnnotationStrokeId(
	cryptoApi: Pick<Crypto, "randomUUID"> | null = globalThis.crypto,
) {
	try {
		if (typeof cryptoApi?.randomUUID === "function")
			return cryptoApi.randomUUID();
	} catch {
		// Fall through to a collision-resistant local identifier for older Safari versions.
	}
	return `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function trySetPointerCapture(element: Element, pointerId: number) {
	try {
		if ("setPointerCapture" in element)
			(
				element as Element & { setPointerCapture(pointerId: number): void }
			).setPointerCapture(pointerId);
	} catch {
		// Safari can throw if capture is requested after the pointer is no longer active.
	}
}

export function tryReleasePointerCapture(element: Element, pointerId: number) {
	try {
		const captureElement = element as Element & {
			hasPointerCapture?(pointerId: number): boolean;
			releasePointerCapture?(pointerId: number): void;
		};
		if (
			captureElement.releasePointerCapture &&
			(!captureElement.hasPointerCapture ||
				captureElement.hasPointerCapture(pointerId))
		) {
			captureElement.releasePointerCapture(pointerId);
		}
	} catch {
		// Lost capture and detached elements are normal cancellation paths on Safari.
	}
}

export function findNearestErasableStroke(
	strokes: AnnotationStroke[],
	point: { u: number; v: number },
	authorId: string,
	canEraseAll: boolean,
	threshold = 0.04,
) {
	const nearest = strokes
		.filter((stroke) => canEraseAll || stroke.authorId === authorId)
		.map((stroke) => ({
			stroke,
			distance: Math.min(
				...stroke.points.map((candidate) =>
					Math.hypot(candidate.u - point.u, candidate.v - point.v),
				),
			),
		}))
		.sort((left, right) => left.distance - right.distance)[0];
	return nearest && nearest.distance <= threshold ? nearest.stroke : null;
}
