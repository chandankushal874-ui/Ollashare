import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockSource = readFileSync(
	new URL("./mobile-room-control-dock.tsx", import.meta.url),
	"utf8",
);
const sheetSource = readFileSync(
	new URL("./mobile-room-sheet.tsx", import.meta.url),
	"utf8",
);
const participantSource = readFileSync(
	new URL("./room-participant-list.tsx", import.meta.url),
	"utf8",
);
const pageSource = readFileSync(
	new URL(
		"../../app/[locale]/(dashboard)/screenshare/page.tsx",
		import.meta.url,
	),
	"utf8",
);
const sharedBrowserSource = readFileSync(
	new URL("../shared-browser/shared-browser-panel.tsx", import.meta.url),
	"utf8",
);

describe("mobile room control dock contract", () => {
	it("exposes five primary, touch-sized, labelled controls", () => {
		for (const label of ["Share", "Screens", "People", "Chat", "More"]) {
			expect(dockSource).toContain(label);
		}
		expect(dockSource).toContain("aria-label={label}");
		expect(dockSource).toContain(
			"aria-expanded={controls ? active : undefined}",
		);
		expect(dockSource).toContain("aria-controls={controls}");
		expect(dockSource).toContain("min-h-11 min-w-11");
		expect(dockSource).toContain("safe-area-inset-bottom");
		expect(dockSource).toContain('aria-label="Room controls"');
	});
});

describe("mobile room sheet contract", () => {
	it("implements accessible dialog, Escape, focus trap, and focus return", () => {
		expect(sheetSource).toContain('role="dialog"');
		expect(sheetSource).toContain('aria-modal="true"');
		expect(sheetSource).toContain("aria-labelledby={titleId}");
		expect(sheetSource).toContain('event.key === "Escape"');
		expect(sheetSource).toContain('event.key !== "Tab"');
		expect(sheetSource).toContain("returnFocusRef.current?.focus()");
		expect(sheetSource).toContain("closeButtonRef.current?.focus()");
		expect(sheetSource).toContain("FOCUSABLE_SELECTOR");
		expect(sheetSource).toContain("motion-reduce:transition-none");
	});

	it("uses a portrait bottom sheet and bounded landscape right sheet", () => {
		expect(sheetSource).toContain("rounded-t-2xl");
		expect(sheetSource).toContain("w-[min(380px,88vw)]");
		expect(sheetSource).toContain("rounded-l-2xl");
		expect(sheetSource).toContain("safe-area-inset-left");
		expect(sheetSource).toContain("safe-area-inset-right");
		expect(sheetSource).toContain("safe-area-inset-bottom");
		expect(sheetSource).toContain("overflow-y-auto overscroll-contain");
		expect(sheetSource).toContain(
			'data-keyboard-open={isKeyboardOpen ? "true" : "false"}',
		);
	});
});

describe("compact participants and page integration", () => {
	it("keeps annotation, control, release, and kick actions touch-sized", () => {
		for (const action of [
			"Allow drawing",
			"Revoke drawing",
			"Request control",
			"Release control",
			"Kick",
		]) {
			expect(participantSource).toContain(action);
		}
		expect(participantSource).toContain("min-h-11");
		expect(participantSource).toContain("flex flex-wrap gap-2");
		expect(participantSource).toContain("onToggleAnnotation?.(");
		expect(participantSource).toContain("onRequestControl?.(participant.id)");
		expect(participantSource).toContain("onReleaseControl?.(participant.id)");
		expect(participantSource).toContain(
			"onKick?.(participant.id, participant.name)",
		);
	});

	it("preserves desktop rail and integrates compact dock/sheets with page handlers", () => {
		expect(pageSource).toContain(
			"const compactRoomActive = mobileLayout.isCompact && joinedRoom",
		);
		expect(pageSource).toContain("!compactRoomActive && (");
		expect(pageSource).toContain("lg:w-[380px]");
		expect(pageSource).toContain("<MobileRoomControlDock");
		expect(pageSource).toContain("<MobileRoomSheet");
		expect(pageSource).toContain("<RoomParticipantList");
		expect(pageSource).toContain("<RoomInviteManager roomCode={roomCode} />");
		expect(pageSource).toContain(
			"handleSetAnnotationPermission(participantId, allowed)",
		);
		expect(pageSource).toContain("handleRequestRemoteControl(device)");
		expect(pageSource).toContain(
			"handleReleaseRemoteControl(device.id, participantId)",
		);
		expect(pageSource).toContain("onKick={handleKickParticipant}");
		expect(pageSource).toContain("[@media(pointer:coarse)]:opacity-100");
		expect(pageSource).toContain("min-h-11");
	});

	it("keeps Shared Browser changes presentation-only and safe-area aware", () => {
		expect(sharedBrowserSource).toContain("safe-area-inset-top");
		expect(sharedBrowserSource).toContain("safe-area-inset-bottom");
		expect(sharedBrowserSource).toContain("flex-wrap items-center gap-2");
		expect(sharedBrowserSource).toContain("overflow-y-auto overscroll-contain");
		expect(sharedBrowserSource).toContain("sm:flex-nowrap");
	});
});
