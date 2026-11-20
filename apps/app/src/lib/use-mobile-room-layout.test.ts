import { describe, expect, it } from "vitest";
import {
	MOBILE_ROOM_COMPACT_MAX_WIDTH,
	MOBILE_ROOM_KEYBOARD_THRESHOLD,
	measureMobileRoomLayout,
} from "./use-mobile-room-layout";

describe("mobile room layout measurement", () => {
	it("detects compact portrait using the Visual Viewport", () => {
		const layout = measureMobileRoomLayout({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: {
				width: 390,
				height: 844,
				offsetTop: 0,
				offsetLeft: 0,
			},
		});

		expect(layout).toMatchObject({
			isCompact: true,
			orientation: "portrait",
			viewportWidth: 390,
			viewportHeight: 844,
			isKeyboardOpen: false,
		});
	});

	it("detects compact landscape without forcing orientation", () => {
		const layout = measureMobileRoomLayout({
			innerWidth: 844,
			innerHeight: 390,
			visualViewport: {
				width: 844,
				height: 390,
				offsetTop: 0,
				offsetLeft: 0,
			},
		});

		expect(layout.isCompact).toBe(true);
		expect(layout.orientation).toBe("landscape");
	});

	it("tracks Visual Viewport offsets and virtual keyboard inset", () => {
		const keyboardInset = MOBILE_ROOM_KEYBOARD_THRESHOLD + 80;
		const layout = measureMobileRoomLayout({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: {
				width: 390,
				height: 844 - keyboardInset - 12,
				offsetTop: 12,
				offsetLeft: 3,
			},
		});

		expect(layout.viewportOffsetTop).toBe(12);
		expect(layout.viewportOffsetLeft).toBe(3);
		expect(layout.keyboardInset).toBe(keyboardInset);
		expect(layout.isKeyboardOpen).toBe(true);
	});

	it("uses layout viewport dimensions when Visual Viewport is unavailable", () => {
		const layout = measureMobileRoomLayout({
			innerWidth: MOBILE_ROOM_COMPACT_MAX_WIDTH + 1,
			innerHeight: 700,
		});

		expect(layout.viewportWidth).toBe(MOBILE_ROOM_COMPACT_MAX_WIDTH + 1);
		expect(layout.viewportHeight).toBe(700);
		expect(layout.isCompact).toBe(false);
		expect(layout.isKeyboardOpen).toBe(false);
	});

	it("returns a stable desktop fallback during server rendering", () => {
		expect(measureMobileRoomLayout(null)).toEqual({
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
		});
	});
});
