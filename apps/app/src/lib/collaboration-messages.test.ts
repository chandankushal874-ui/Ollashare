import { describe, expect, it } from "vitest";
import { acceptsCollaborationMessage } from "./collaboration-messages";

describe("annotation transport isolation", () => {
	it("rejects all raw annotation mutations from LiveKit and P2P", () => {
		const messages = [
			{ type: "SCREEN_ANNOTATION_STROKE", authorId: "host", targetType: "screen", targetId: "track", stroke: {} },
			{ type: "SCREEN_ANNOTATION_ERASE", authorId: "host", targetType: "screen", targetId: "track", strokeId: "stroke" },
			{ type: "SCREEN_ANNOTATION_CLEAR", authorId: "host", targetType: "shared-browser", targetId: "session" },
		];
		for (const message of messages) {
			expect(acceptsCollaborationMessage(message, "host", "host", { permittedGuestIds: ["host"] })).toBe(false);
		}
	});

	it("continues to authorize non-annotation collaboration messages", () => {
		expect(acceptsCollaborationMessage({ type: "STAGE_MODE_CHANGE", mode: "screens" }, "host", "host")).toBe(true);
		expect(acceptsCollaborationMessage({ type: "PRESENTATION_VOTE", option: "A" }, "guest", "host")).toBe(true);
	});
});
