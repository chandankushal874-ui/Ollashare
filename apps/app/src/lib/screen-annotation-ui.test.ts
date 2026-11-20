import { describe, expect, it } from "vitest";
import type { AnnotationStroke } from "./annotation-types";
import {
	FULL_VIEW_CONTROL_ROW_CLASS,
	PARTICIPANT_ACTION_ROW_CLASS,
	createAnnotationStrokeId,
	findNearestErasableStroke,
	getFullViewInteractionState,
	tryReleasePointerCapture,
	trySetPointerCapture,
} from "./screen-annotation-ui";

const strokes: AnnotationStroke[] = [
	{
		id: "host-stroke",
		authorId: "host",
		authorName: "Host",
		targetType: "shared-browser",
		targetId: "session",
		color: "#fff",
		width: 4,
		points: [
			{ u: 0.2, v: 0.2 },
			{ u: 0.3, v: 0.3 },
		],
		createdAt: 1,
	},
	{
		id: "guest-stroke",
		authorId: "guest",
		authorName: "Guest",
		targetType: "shared-browser",
		targetId: "session",
		color: "#fff",
		width: 4,
		points: [
			{ u: 0.21, v: 0.21 },
			{ u: 0.4, v: 0.4 },
		],
		createdAt: 2,
	},
];

describe("screen annotation UI behavior", () => {
	it("keeps Draw and Control mutually exclusive while remote control remains authorized", () => {
		expect(
			getFullViewInteractionState({
				mode: "draw",
				remoteControlActive: true,
				annotationAllowed: true,
				annotationSelected: true,
			}),
		).toEqual({
			annotationEnabled: true,
			remoteInputEnabled: false,
		});
		expect(
			getFullViewInteractionState({
				mode: "control",
				remoteControlActive: true,
				annotationAllowed: true,
				annotationSelected: true,
			}),
		).toEqual({
			annotationEnabled: false,
			remoteInputEnabled: true,
		});
	});

	it("reacts immediately when guest drawing permission is revoked", () => {
		expect(
			getFullViewInteractionState({
				mode: "draw",
				remoteControlActive: false,
				annotationAllowed: true,
				annotationSelected: true,
			}).annotationEnabled,
		).toBe(true);
		expect(
			getFullViewInteractionState({
				mode: "draw",
				remoteControlActive: false,
				annotationAllowed: false,
				annotationSelected: true,
			}).annotationEnabled,
		).toBe(false);
	});

	it("allows a host to erase any stroke and a guest only their own", () => {
		expect(
			findNearestErasableStroke(strokes, { u: 0.2, v: 0.2 }, "host", true)?.id,
		).toBe("host-stroke");
		expect(
			findNearestErasableStroke(strokes, { u: 0.2, v: 0.2 }, "guest", false)
				?.id,
		).toBe("guest-stroke");
		expect(
			findNearestErasableStroke(
				strokes,
				{ u: 0.2, v: 0.2 },
				"other-guest",
				false,
			),
		).toBeNull();
	});

	it("guards pointer capture and release failures used by cancel/lost-capture cleanup", () => {
		expect(() =>
			trySetPointerCapture(
				{
					setPointerCapture: () => {
						throw new Error("unsupported");
					},
				} as unknown as Element,
				7,
			),
		).not.toThrow();
		expect(() =>
			tryReleasePointerCapture(
				{
					hasPointerCapture: () => true,
					releasePointerCapture: () => {
						throw new Error("lost");
					},
				} as unknown as Element,
				7,
			),
		).not.toThrow();
	});

	it("falls back when randomUUID is unavailable", () => {
		expect(createAnnotationStrokeId(null)).toMatch(/^annotation-/);
	});

	it("keeps mobile Full View and participant controls scrollable, wrapping, and touch-sized", () => {
		expect(FULL_VIEW_CONTROL_ROW_CLASS).toContain("overflow-x-auto");
		expect(FULL_VIEW_CONTROL_ROW_CLASS).toContain("[&>*]:min-h-11");
		expect(PARTICIPANT_ACTION_ROW_CLASS).toContain("flex-wrap");
		expect(PARTICIPANT_ACTION_ROW_CLASS).toContain("[&>button]:min-h-11");
	});
});
