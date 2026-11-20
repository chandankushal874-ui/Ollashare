import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnnotationStroke } from "../../lib/annotation-types";
import {
	buildRoomRecordingAnnotations,
	mapRoomRecordingSources,
} from "../../lib/recording/room-source-mapping";

function track(id: string, kind: "video" | "audio") {
	return { id, kind, readyState: "live" } as unknown as MediaStreamTrack;
}

const controlsSource = readFileSync(
	new URL("./recording-controls.tsx", import.meta.url),
	"utf8",
);
const consentSource = readFileSync(
	new URL("./recording-consent-dialog.tsx", import.meta.url),
	"utf8",
);
const indicatorSource = readFileSync(
	new URL("./recording-indicator.tsx", import.meta.url),
	"utf8",
);
const orchestrationSource = readFileSync(
	new URL("./use-room-local-recording.tsx", import.meta.url),
	"utf8",
);
const engineSource = readFileSync(
	new URL("../../lib/recording/use-local-recording.ts", import.meta.url),
	"utf8",
);
const pageSource = readFileSync(
	new URL(
		"../../app/[locale]/(dashboard)/screenshare/page.tsx",
		import.meta.url,
	),
	"utf8",
);
const panelSource = readFileSync(
	new URL("../shared-browser/shared-browser-panel.tsx", import.meta.url),
	"utf8",
);

describe("recording UI integration contracts", () => {
	it("is host-only, mobile-unsupported, touch-sized, and exposes gated profiles/actions/status/errors", () => {
		expect(controlsSource).toContain(
			"if (!props.isHost || !props.portalTarget) return null",
		);
		expect(controlsSource).toContain("if (props.compact)");
		expect(controlsSource).toContain(
			"Local recording downloads are unsupported on mobile/compact layouts",
		);
		expect(controlsSource).toContain("min-h-10");
		expect(controlsSource).toContain("sourceAvailable");
		expect(controlsSource).toContain("portalTarget");
		expect(controlsSource).toContain("createPortal");
		expect(controlsSource).toContain("Record & Download");
		expect(controlsSource).toContain("data-full-view-recording-controls");
		expect(controlsSource).not.toContain("w-[21rem]");
		expect(controlsSource).not.toContain("fixed bottom-");
		for (const text of [
			"Focused screen",
			"Screen grid",
			"Shared Browser",
			"1080p",
			"720p",
			"360p",
			"value={25}",
			"value={30}",
			"value={60}",
			"Screen audio",
			"Video only",
			"Record",
			"Pause",
			"Resume",
			"Stop",
			"Cancel",
			"Download locally",
			"MIME:",
			"Stored locally",
		])
			expect(controlsSource).toContain(text);
		expect(controlsSource).toContain('role="alert"');
		expect(controlsSource).toContain("disabled={!props.isFpsSupported(60)}");
		expect(orchestrationSource).toContain("sourceAvailable={");
		expect(orchestrationSource).toContain(
			"portalTarget={props.controlsPortalTarget}",
		);
		expect(pageSource).toContain("sourceAvailable={");
		expect(pageSource).toContain(
			"controlsPortalTarget={recordingControlsPortalTarget}",
		);
		expect(pageSource).toContain("data-full-view-recording-footer");
		expect(orchestrationSource).toContain("getRecordingProfileSupport");
		expect(orchestrationSource).toContain("probeRecordingRuntimeSupport");
		expect(orchestrationSource).toContain("backpressure");
	});

	it("discloses local-only content, annotations, names/status, and screen audio only", () => {
		for (const text of [
			"stored only in this host browser",
			"annotations",
			"owner names",
			"screen-share audio",
			"microphones are not claimed",
			"video only",
			"Confirm and start",
		])
			expect(consentSource).toContain(text);
		expect(consentSource).toContain("createPortal");
		expect(consentSource).toContain("if (!open || !portalTarget) return null");
		expect(orchestrationSource).toContain(
			"portalTarget={props.controlsPortalTarget}",
		);
		expect(consentSource).toContain('role="dialog"');
		expect(consentSource).toContain('aria-modal="true"');
	});

	it("renders safe recording and paused awareness without sensitive identifiers", () => {
		expect(indicatorSource).toContain("Recording paused");
		expect(indicatorSource).toContain("Screen grid");
		expect(indicatorSource).toContain("Shared Browser");
		expect(indicatorSource).toContain('role="status"');
		expect(indicatorSource).not.toContain("recordingId");
		expect(indicatorSource).not.toContain("hostId");
	});
});

describe("page source and annotation mapping", () => {
	it("maps mesh stream and LiveKit screen audio without participant microphones", () => {
		const video = track("video", "video");
		const meshAudio = track("mesh-screen-audio", "audio");
		const liveKitAudio = track("livekit-screen-audio", "audio");
		const sources = mapRoomRecordingSources(
			[
				{
					id: "screen-a",
					deviceName: "Window",
					ownerId: "alice",
					ownerName: "Alice",
					stream: {
						getVideoTracks: () => [video],
						getAudioTracks: () => [meshAudio],
					} as unknown as MediaStream,
					isLive: true,
				},
			],
			[
				{ participantIdentity: "alice", mediaStreamTrack: liveKitAudio },
				{
					participantIdentity: "bob",
					mediaStreamTrack: track("bob-mic", "audio"),
				},
			],
		);
		expect(sources).toHaveLength(1);
		expect(sources[0]?.owner).toEqual({ id: "alice", name: "Alice" });
		expect(sources[0]?.videoTrack).toBe(video);
		expect(sources[0]?.audioTracks?.map((item) => item.id)).toEqual([
			"mesh-screen-audio",
			"livekit-screen-audio",
		]);
		expect(sources[0]?.status).toBe("active");
	});

	it("includes committed and draft annotations by stable source id", () => {
		const committed = {
			id: "committed",
			authorId: "u",
			authorName: "Alice",
			targetType: "screen",
			targetId: "screen-a",
			color: "#fff",
			width: 2,
			tool: "pen",
			points: [
				{ u: 0, v: 0 },
				{ u: 1, v: 1 },
			],
			createdAt: 1,
		} as AnnotationStroke;
		const draft = { ...committed, id: "draft" };
		expect(
			buildRoomRecordingAnnotations(
				["screen-a"],
				{ "screen-a": [committed] },
				{ "screen-a": draft },
			),
		).toEqual({ "screen-a": { committed: [committed], draft } });
		expect(pageSource).toContain("focusedSourceId={zoomedDeviceId}");
		expect(pageSource).toContain(
			"screenAnnotationDrafts={recordingAnnotationDrafts}",
		);
		expect(pageSource).toContain(
			"sharedBrowserAnnotationDraft={sharedBrowserRecordingDraft}",
		);
	});
});

describe("feature flags, awareness lifecycle, and security boundaries", () => {
	it("fails flags closed and keeps recording/stream flags independent", () => {
		expect(orchestrationSource).toContain(
			'process.env.NEXT_PUBLIC_LOCAL_RECORDING_ENABLED === "true"',
		);
		expect(orchestrationSource).toContain(
			'process.env.NEXT_PUBLIC_SHARED_BROWSER_RECORDING_ENABLED === "true"',
		);
		expect(orchestrationSource).toContain(
			'process.env.NEXT_PUBLIC_LOCAL_RECORDING_360P_ENABLED === "true"',
		);
		expect(orchestrationSource).toContain(
			"allow360p={LOCAL_RECORDING_360P_ENABLED}",
		);
		expect(orchestrationSource).not.toContain(
			"allow360p={STREAM_360P_ENABLED}",
		);
		expect(pageSource).toContain("liveKit.updateScreenShareFps(patch.fps)");
		expect(pageSource).toContain("peerConnectionsRef.current.values()");
		expect(pageSource).toContain("Outgoing stream capped at");
	});

	it("starts awareness after preparation and before MediaRecorder start, heartbeats, and cleans idempotently", () => {
		expect(
			engineSource.indexOf("await options.onPrepared?.()"),
		).toBeGreaterThan(engineSource.indexOf("compositor.captureStream()"));
		expect(engineSource.indexOf("await options.onPrepared?.()")).toBeLessThan(
			engineSource.indexOf("return prepared"),
		);
		expect(orchestrationSource).toContain("startAwareness({");
		expect(orchestrationSource).toContain("}, 15_000)");
		expect(orchestrationSource).toContain("awarenessFinishedRef.current");
		expect(orchestrationSource).toContain('finishBackend("client_unmounted")');
		expect(orchestrationSource).toContain("if (props.roomLive) return");
	});

	it("preserves same-origin sandbox and exposes only the guarded frame handle", () => {
		expect(panelSource).toContain(
			'sandbox="allow-scripts allow-same-origin allow-pointer-lock"',
		);
		expect(panelSource).not.toContain("onFrameHandleChange?.(grant");
		expect(pageSource).toContain(
			"onFrameHandleChange={handleSharedBrowserFrameChange}",
		);
		expect(pageSource).toContain("lastConnectedSharedBrowserFrameRef.current");
		expect(orchestrationSource).toContain("Shared Browser is reconnecting");
		expect(orchestrationSource).toContain('finishBackend("source_ended")');
		expect(orchestrationSource).not.toContain("bandwidth reduction");
	});
});
