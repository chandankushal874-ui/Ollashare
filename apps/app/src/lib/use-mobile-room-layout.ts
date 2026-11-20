"use client";

import { type CSSProperties, useEffect, useState } from "react";

export const MOBILE_ROOM_COMPACT_MAX_WIDTH = 900;
export const MOBILE_ROOM_KEYBOARD_THRESHOLD = 120;

export type MobileRoomOrientation = "portrait" | "landscape";

export type MobileRoomLayoutMeasurement = {
	layoutWidth: number;
	layoutHeight: number;
	viewportWidth: number;
	viewportHeight: number;
	viewportOffsetTop: number;
	viewportOffsetLeft: number;
	keyboardInset: number;
	isKeyboardOpen: boolean;
	isCompact: boolean;
	orientation: MobileRoomOrientation;
};

type LayoutWindow = Pick<Window, "innerWidth" | "innerHeight"> & {
	visualViewport?: Pick<
		VisualViewport,
		"width" | "height" | "offsetTop" | "offsetLeft"
	> | null;
};

const DESKTOP_FALLBACK: MobileRoomLayoutMeasurement = {
	layoutWidth: 1280,
	layoutHeight: 720,
	viewportWidth: 1280,
	viewportHeight: 720,
	viewportOffsetTop: 0,
	viewportOffsetLeft: 0,
	keyboardInset: 0,
	isKeyboardOpen: false,
	isCompact: false,
	orientation: "landscape",
};

export function measureMobileRoomLayout(
	windowLike?: LayoutWindow | null,
): MobileRoomLayoutMeasurement {
	if (!windowLike) return DESKTOP_FALLBACK;

	const layoutWidth = Math.max(0, Math.round(windowLike.innerWidth));
	const layoutHeight = Math.max(0, Math.round(windowLike.innerHeight));
	const viewport = windowLike.visualViewport;
	const viewportWidth = Math.max(0, Math.round(viewport?.width ?? layoutWidth));
	const viewportHeight = Math.max(
		0,
		Math.round(viewport?.height ?? layoutHeight),
	);
	const viewportOffsetTop = Math.max(0, Math.round(viewport?.offsetTop ?? 0));
	const viewportOffsetLeft = Math.max(0, Math.round(viewport?.offsetLeft ?? 0));
	const keyboardInset = Math.max(
		0,
		layoutHeight - viewportHeight - viewportOffsetTop,
	);

	return {
		layoutWidth,
		layoutHeight,
		viewportWidth,
		viewportHeight,
		viewportOffsetTop,
		viewportOffsetLeft,
		keyboardInset,
		isKeyboardOpen: keyboardInset >= MOBILE_ROOM_KEYBOARD_THRESHOLD,
		isCompact: layoutWidth <= MOBILE_ROOM_COMPACT_MAX_WIDTH,
		orientation: layoutHeight >= layoutWidth ? "portrait" : "landscape",
	};
}

export type MobileRoomLayout = MobileRoomLayoutMeasurement & {
	viewportRevision: number;
	viewportStyle: CSSProperties;
};

function sameMeasurement(
	left: MobileRoomLayoutMeasurement,
	right: MobileRoomLayoutMeasurement,
) {
	return (
		left.layoutWidth === right.layoutWidth &&
		left.layoutHeight === right.layoutHeight &&
		left.viewportWidth === right.viewportWidth &&
		left.viewportHeight === right.viewportHeight &&
		left.viewportOffsetTop === right.viewportOffsetTop &&
		left.viewportOffsetLeft === right.viewportOffsetLeft &&
		left.keyboardInset === right.keyboardInset &&
		left.isKeyboardOpen === right.isKeyboardOpen &&
		left.isCompact === right.isCompact &&
		left.orientation === right.orientation
	);
}

export function useMobileRoomLayout(): MobileRoomLayout {
	const [state, setState] = useState(() => ({
		layout: measureMobileRoomLayout(
			typeof window === "undefined" ? null : window,
		),
		viewportRevision: 0,
	}));

	useEffect(() => {
		let frame = 0;
		const update = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const next = measureMobileRoomLayout(window);
				setState((current) =>
					sameMeasurement(current.layout, next)
						? current
						: {
								layout: next,
								viewportRevision: current.viewportRevision + 1,
							},
				);
			});
		};

		update();
		window.addEventListener("resize", update, { passive: true });
		window.addEventListener("orientationchange", update, { passive: true });
		window.visualViewport?.addEventListener("resize", update, {
			passive: true,
		});
		window.visualViewport?.addEventListener("scroll", update, {
			passive: true,
		});

		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener("resize", update);
			window.removeEventListener("orientationchange", update);
			window.visualViewport?.removeEventListener("resize", update);
			window.visualViewport?.removeEventListener("scroll", update);
		};
	}, []);

	const { layout, viewportRevision } = state;
	return {
		...layout,
		viewportRevision,
		viewportStyle: {
			"--mobile-room-viewport-width": `${layout.viewportWidth}px`,
			"--mobile-room-viewport-height": `${layout.viewportHeight}px`,
			"--mobile-room-viewport-top": `${layout.viewportOffsetTop}px`,
			"--mobile-room-viewport-left": `${layout.viewportOffsetLeft}px`,
			"--mobile-room-keyboard-inset": `${layout.keyboardInset}px`,
		} as CSSProperties,
	};
}
