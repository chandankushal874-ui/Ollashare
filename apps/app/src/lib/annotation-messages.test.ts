import { describe, expect, it } from "vitest";
import {
	ANNOTATION_LIMITS,
	type AnnotationMessage,
	acceptsAnnotationTarget,
	buildActiveAnnotationTargets,
	canSendAnnotationMessage,
	isAnnotationMessage,
	isWithinAnnotationRateLimit,
	retainBoundedAnnotationStrokes,
	setBoundedRecordEntry,
} from "./annotation-messages";

const base = {
	authorId: "guest-1",
	authorName: "Guest",
	targetType: "shared-browser",
	targetId: "browser-session-1",
} as const;

const stroke: AnnotationMessage = {
	...base,
	type: "SCREEN_ANNOTATION_STROKE",
	stroke: {
		id: "stroke-1",
		color: "#2563eb",
		width: 3,
		points: [
			{ u: 0, v: 0 },
			{ u: 1, v: 1 },
		],
	},
};

describe("annotation authorization", () => {
	it("lets the host mutate and clear any target", () => {
		const clearAll: AnnotationMessage = {
			...base,
			authorId: "host-1",
			authorName: "Host",
			type: "SCREEN_ANNOTATION_CLEAR",
		};
		expect(
			canSendAnnotationMessage(clearAll, "host-1", "host-1", {
				permittedGuestIds: [],
			}),
		).toBe(true);
	});

	it("lets a permitted guest add and erase only their own strokes", () => {
		const permissions = {
			permittedGuestIds: new Set(["guest-1"]),
			strokeAuthors: { "stroke-1": "guest-1", "host-stroke": "host-1" },
		};
		expect(
			canSendAnnotationMessage(stroke, "guest-1", "host-1", permissions),
		).toBe(true);
		expect(
			canSendAnnotationMessage(
				{ ...base, type: "SCREEN_ANNOTATION_ERASE", strokeId: "stroke-1" },
				"guest-1",
				"host-1",
				permissions,
			),
		).toBe(true);
		expect(
			canSendAnnotationMessage(
				{ ...base, type: "SCREEN_ANNOTATION_ERASE", strokeId: "host-stroke" },
				"guest-1",
				"host-1",
				permissions,
			),
		).toBe(false);
	});

	it("lets a guest clear only their own annotations", () => {
		const permissions = { permittedGuestIds: ["guest-1"] };
		expect(
			canSendAnnotationMessage(
				{
					...base,
					type: "SCREEN_ANNOTATION_CLEAR",
					authorIdToClear: "guest-1",
				},
				"guest-1",
				"host-1",
				permissions,
			),
		).toBe(true);
		expect(
			canSendAnnotationMessage(
				{ ...base, type: "SCREEN_ANNOTATION_CLEAR" },
				"guest-1",
				"host-1",
				permissions,
			),
		).toBe(false);
		expect(
			canSendAnnotationMessage(
				{ ...base, type: "SCREEN_ANNOTATION_CLEAR", authorIdToClear: "host-1" },
				"guest-1",
				"host-1",
				permissions,
			),
		).toBe(false);
	});
});

describe("annotation target and flood bounds", () => {
	it("accepts only exact active targets", () => {
		expect(acceptsAnnotationTarget(stroke, new Set(), "browser-session-1")).toBe(true);
		expect(acceptsAnnotationTarget(stroke, new Set(), "browser-session-10")).toBe(false);
		expect(
			acceptsAnnotationTarget(
				{ ...stroke, targetType: "screen", targetId: "screen-1" },
				new Set(["screen-1"]),
				null,
			),
		).toBe(true);
		expect(
			acceptsAnnotationTarget(
				{ ...stroke, targetType: "screen", targetId: "screen-1-old" },
				new Set(["screen-1"]),
				null,
			),
		).toBe(false);
	});

	it("rejects oversized identifiers, point floods, and encoded payloads", () => {
		expect(isAnnotationMessage({ ...stroke, targetId: "x".repeat(ANNOTATION_LIMITS.targetIdLength + 1) })).toBe(false);
		expect(
			isAnnotationMessage({
				...stroke,
				stroke: { ...stroke.stroke, points: Array.from({ length: ANNOTATION_LIMITS.maxPoints + 1 }, () => ({ u: 0.5, v: 0.5 })) },
			}),
		).toBe(false);
		expect(isAnnotationMessage({ ...stroke, ignored: "x".repeat(ANNOTATION_LIMITS.maxMessageBytes) })).toBe(false);
	});

	it("builds a stable bounded active target list with screens before the browser", () => {
		expect(
			buildActiveAnnotationTargets(
				["host-primary", "guest-1", "host-primary", "guest-2", "guest-3"],
				"browser-session-1",
			),
		).toEqual([
			{ targetKind: "screen", targetId: "host-primary" },
			{ targetKind: "screen", targetId: "guest-1" },
			{ targetKind: "screen", targetId: "guest-2" },
			{ targetKind: "shared-browser", targetId: "browser-session-1" },
		]);
	});

	it("drops malformed target ids and bounds screen-only target lists", () => {
		expect(
			buildActiveAnnotationTargets(
				["host-primary", "bad target", "guest-1", "guest-2", "guest-3", "guest-4"],
				null,
			),
		).toEqual([
			{ targetKind: "screen", targetId: "host-primary" },
			{ targetKind: "screen", targetId: "guest-1" },
			{ targetKind: "screen", targetId: "guest-2" },
			{ targetKind: "screen", targetId: "guest-3" },
		]);
	});

	it("accepts bounded highlighter metadata and rejects malformed style", () => {
		expect(isAnnotationMessage({
			...stroke,
			stroke: { ...stroke.stroke, tool: "highlighter", opacity: 0.35 },
		})).toBe(true);
		expect(isAnnotationMessage({
			...stroke,
			stroke: { ...stroke.stroke, tool: "highlighter", opacity: 0.9 },
		})).toBe(false);
		expect(isAnnotationMessage({
			...stroke,
			stroke: { ...stroke.stroke, tool: "pen", opacity: 0.35 },
		})).toBe(false);
	});

	it("evicts oldest strokes deterministically by stroke and point budgets", () => {
		const strokes = Array.from({ length: 5 }, (_, index) => ({
			id: `stroke-${index}`,
			points: Array.from({ length: 3 }, () => ({ u: 0, v: 0 })),
		}));
		expect(retainBoundedAnnotationStrokes(strokes, 3, 7).map((item) => item.id)).toEqual(["stroke-3", "stroke-4"]);
	});

	it("bounds per-author state with oldest-entry eviction", () => {
		const state: Record<string, number[]> = {};
		for (let index = 0; index <= ANNOTATION_LIMITS.maxAuthorsWithRateState; index += 1) {
			setBoundedRecordEntry(state, `author-${index}`, [index], ANNOTATION_LIMITS.maxAuthorsWithRateState);
		}
		expect(Object.keys(state)).toHaveLength(ANNOTATION_LIMITS.maxAuthorsWithRateState);
		expect(state["author-0"]).toBeUndefined();
		expect(state[`author-${ANNOTATION_LIMITS.maxAuthorsWithRateState}`]).toEqual([ANNOTATION_LIMITS.maxAuthorsWithRateState]);
	});
});

describe("annotation rate bounds", () => {
	it("accepts below the sliding-window limit and rejects at the limit", () => {
		expect(isWithinAnnotationRateLimit([9_100, 9_200], 10_000, 3, 1_000)).toBe(
			true,
		);
		expect(
			isWithinAnnotationRateLimit([9_100, 9_200, 9_300], 10_000, 3, 1_000),
		).toBe(false);
	});

	it("ignores expired entries and fails closed on invalid timestamps", () => {
		expect(isWithinAnnotationRateLimit([8_000, 9_000], 10_000, 1, 1_000)).toBe(
			true,
		);
		expect(isWithinAnnotationRateLimit([10_001], 10_000)).toBe(false);
	});
});
