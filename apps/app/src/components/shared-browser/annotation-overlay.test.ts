import { describe, expect, it } from "vitest";
import { applyAnnotationEvents } from "../../lib/annotation-messages";
import { type AnnotationEvent, type AnnotationStroke, getAnnotationStrokeRenderStyle } from "../../lib/annotation-types";

describe("Shared Browser annotation integration", () => {
	it("rebuilds state only from authoritative ordered events", () => {
		const events: AnnotationEvent[] = [
			{ sequence: 1, kind: "stroke", actorId: "host", actorName: "Host", strokeId: "host-1", color: "#f59e0b", width: 4, points: [{ u: 0, v: 0 }, { u: 1, v: 1 }], createdAt: 1 },
			{ sequence: 2, kind: "stroke", actorId: "guest", actorName: "Guest", strokeId: "guest-1", color: "#2563eb", width: 2, points: [{ u: 0.2, v: 0.2 }, { u: 0.3, v: 0.3 }], createdAt: 2 },
			{ sequence: 3, kind: "clear", actorId: "guest", actorName: "Guest", clearScope: "own", createdAt: 3 },
		];
		const strokes = applyAnnotationEvents([], events, "shared-browser", "session");
		expect(strokes.map((stroke) => stroke.id)).toEqual(["host-1"]);
	});

	it("replays highlighter style and renders it wider and translucent", () => {
		const strokes = applyAnnotationEvents([], [{
			sequence: 1,
			kind: "stroke",
			actorId: "guest",
			actorName: "Guest",
			strokeId: "highlight-1",
			color: "#f59e0b",
			width: 8,
			tool: "highlighter",
			opacity: 0.35,
			points: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
			createdAt: 1,
		}], "shared-browser", "session");
		expect(strokes[0]).toMatchObject({ tool: "highlighter", opacity: 0.35, width: 8 });
		expect(getAnnotationStrokeRenderStyle(strokes[0]!)).toEqual({ lineWidth: 16, opacity: 0.35 });
	});

	it("treats old persisted strokes without style metadata as opaque pen strokes", () => {
		const strokes = applyAnnotationEvents([], [{
			sequence: 1,
			kind: "stroke",
			actorId: "host",
			actorName: "Host",
			strokeId: "old-pen",
			color: "#2563eb",
			width: 4,
			points: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
			createdAt: 1,
		}], "shared-browser", "session");
		expect(strokes[0]).toMatchObject({ tool: "pen", opacity: 1 });
		expect(getAnnotationStrokeRenderStyle(strokes[0]!)).toEqual({ lineWidth: 4, opacity: 1 });
	});

	it("keeps newest strokes under bounded replay limits", () => {
		const events = Array.from({ length: 140 }, (_, index) => ({
			sequence: index + 1,
			kind: "stroke" as const,
			actorId: index % 2 === 0 ? "host" : "guest",
			actorName: "Author",
			strokeId: `stroke-${index}`,
			color: "#f59e0b",
			width: 4,
			points: Array.from({ length: 50 }, () => ({ u: 0.5, v: 0.5 })),
			createdAt: index,
		}));
		const strokes = applyAnnotationEvents([], events, "shared-browser", "session");
		expect(strokes).toHaveLength(81);
		expect(strokes[0]?.id).toBe("stroke-59");
	});

	it("applies host clear-all after earlier persisted strokes", () => {
		const existing: AnnotationStroke[] = [{
			id: "existing",
			authorId: "host",
			authorName: "Host",
			targetType: "shared-browser",
			targetId: "session",
			color: "#f59e0b",
			width: 4,
			points: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
			createdAt: 1,
		}];
		expect(applyAnnotationEvents(existing, [{ sequence: 2, kind: "clear", actorId: "host", actorName: "Host", clearScope: "all", createdAt: 2 }], "shared-browser", "session")).toEqual([]);
	});
});
