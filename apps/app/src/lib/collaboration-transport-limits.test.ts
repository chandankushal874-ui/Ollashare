import { describe, expect, it } from "vitest";
import {
	COLLABORATION_TRANSPORT_LIMITS,
	CollaborationFloodGuard,
	classifyCollaborationMessage,
	collaborationPayloadBytes,
	isCollaborationPayloadWithinLimit,
} from "./collaboration-transport-limits";

describe("collaboration transport flood guard", () => {
	it("measures UTF-8 bytes and classifies supported collaboration messages", () => {
		expect(collaborationPayloadBytes("é")).toBe(2);
		expect(classifyCollaborationMessage({ type: "SCREEN_ANNOTATION_STROKE" })).toBe("annotation");
		expect(classifyCollaborationMessage({ type: "PRESENTATION_VOTE" })).toBe("presentation");
		expect(classifyCollaborationMessage({ type: "REMOTE_CONTROL_INPUT" })).toBe("control");
		expect(classifyCollaborationMessage({ type: "unknown" })).toBe("unknown");
	});

	it("enforces explicit byte ceilings before collaboration handling", () => {
		const guard = new CollaborationFloodGuard();
		const oversized = JSON.stringify({ type: "PRESENTATION_NOTES_SYNC", notes: "x".repeat(9_000) });
		expect(isCollaborationPayloadWithinLimit(guard, "sender", oversized, 1)).toBe("ignore");
		expect(COLLABORATION_TRANSPORT_LIMITS.maxPayloadBytes).toBe(16_384);
	});

	it("enforces per-sender aggregate and per-message-type buckets", () => {
		const guard = new CollaborationFloodGuard();
		for (let index = 0; index < 20; index += 1) {
			expect(guard.assess("sender", "presentation", 20, 1)).toBe("accept");
		}
		expect(guard.assess("sender", "presentation", 20, 1)).toBe("ignore");

		const otherSender = new CollaborationFloodGuard();
		for (let index = 0; index < 60; index += 1) {
			expect(otherSender.assess("sender", "annotation", 20, 1)).toBe("accept");
		}
		expect(otherSender.assess("sender", "annotation", 20, 1)).toBe("ignore");
	});

	it("evicts the least recently used sender state", () => {
		const guard = new CollaborationFloodGuard();
		for (let index = 0; index < 20; index += 1) {
			expect(guard.assess("recent", "presentation", 20, 1)).toBe("accept");
		}
		for (let index = 1; index < COLLABORATION_TRANSPORT_LIMITS.maxSenders; index += 1) {
			expect(guard.assess(`sender-${index}`, "system", 1, 1)).toBe("accept");
		}
		expect(guard.assess("recent", "presentation", 20, 1)).toBe("ignore");
		expect(guard.assess("overflow", "system", 1, 1)).toBe("accept");
		expect(guard.assess("recent", "presentation", 20, 1)).toBe("ignore");
		expect(guard.assess("sender-1", "system", 1, 1)).toBe("accept");
	});

	it("escalates repeated violations from ignore to permanent disconnect", () => {
		const guard = new CollaborationFloodGuard();
		const tooLarge = COLLABORATION_TRANSPORT_LIMITS.maxPayloadBytes + 1;
		expect(guard.assess("sender", "unknown", tooLarge, 1)).toBe("ignore");
		expect(guard.assess("sender", "unknown", tooLarge, 2)).toBe("ignore");
		expect(guard.assess("sender", "unknown", tooLarge, 3)).toBe("ignore");
		expect(guard.assess("sender", "unknown", tooLarge, 4)).toBe("ignore");
		expect(guard.assess("sender", "unknown", tooLarge, 5)).toBe("ignore");
		expect(guard.assess("sender", "unknown", tooLarge, 6)).toBe("disconnect");
		expect(guard.isBlocked("sender")).toBe(true);
		expect(guard.assess("sender", "annotation", 1, 60_000)).toBe("disconnect");
	});
});
