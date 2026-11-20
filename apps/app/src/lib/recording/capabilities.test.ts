import { describe, expect, it, vi } from "vitest";
import {
	getRecordingMimeCandidates,
	getRecordingProfileSupport,
	probeRecordingRuntimeSupport,
	selectRecordingMimeCapability,
	withMimeRecordingRuntimeSupport,
} from "./capabilities";

describe("recording MIME capabilities", () => {
	it("prefers VP9 WebM then VP8 WebM by default", () => {
		const probe = vi.fn((mime: string) => mime.includes("vp8"));
		const result = selectRecordingMimeCapability({ isTypeSupported: probe });
		expect(result).toEqual({
			supported: true,
			capability: {
				mimeType: "video/webm;codecs=vp8,opus",
				container: "webm",
				fileExtension: "webm",
				videoCodec: "vp8",
				audioCodec: "opus",
			},
		});
		expect(probe.mock.calls.map(([mime]) => mime)).toEqual([
			"video/webm;codecs=vp9,opus",
			"video/webm;codecs=vp8,opus",
		]);
	});

	it("can prefer Safari MP4 and returns actual container metadata", () => {
		const result = selectRecordingMimeCapability({
			preferSafariMp4: true,
			isTypeSupported: (mime) => mime.startsWith("video/mp4"),
		});
		expect(result.supported).toBe(true);
		if (result.supported) {
			expect(result.capability).toMatchObject({
				container: "mp4",
				fileExtension: "mp4",
				videoCodec: "h264",
				audioCodec: "aac",
			});
		}
	});

	it("supports video-only candidate metadata", () => {
		expect(getRecordingMimeCandidates({ includeAudio: false })[0]).toEqual({
			mimeType: "video/webm;codecs=vp9",
			container: "webm",
			fileExtension: "webm",
			videoCodec: "vp9",
			audioCodec: null,
		});
	});

	it("fails cleanly when no MIME is supported or the probe throws", () => {
		expect(
			selectRecordingMimeCapability({
				isTypeSupported: () => {
					throw new Error("unsupported API");
				},
			}),
		).toEqual({
			supported: false,
			capability: null,
			reason: "no-supported-recording-mime",
		});
	});
});

function supportedRuntime(
	overrides: Partial<ReturnType<typeof probeRecordingRuntimeSupport>> = {},
) {
	return {
		supported: true,
		browserFamily: "chromium" as const,
		isMobile: false,
		mediaRecorder: true,
		mimeProbe: true,
		canvas2d: true,
		canvasCapture: true,
		mediaStream: true,
		indexedDb: true,
		audioMixing: true,
		reason: null,
		message: null,
		...overrides,
	};
}

function capabilityEnvironment(userAgent: string) {
	const Recorder =
		function MockMediaRecorder() {} as unknown as typeof MediaRecorder;
	Recorder.isTypeSupported = (mimeType: string) =>
		mimeType.startsWith("video/webm");
	return {
		userAgent,
		vendor: /Safari/.test(userAgent) ? "Apple Computer, Inc." : "Google Inc.",
		mediaRecorder: Recorder as unknown as typeof MediaRecorder,
		mediaStream: class {} as unknown as typeof MediaStream,
		indexedDb: {} as IDBFactory,
		audioContext: class {} as unknown as typeof AudioContext,
		createCanvas: () =>
			({
				getContext: () => ({}),
				captureStream: () => ({}),
			}) as unknown as HTMLCanvasElement,
	};
}

describe("recording runtime and profile support", () => {
	it("allows the verified Chromium matrix but gates high-resolution 60 FPS", () => {
		const runtime = probeRecordingRuntimeSupport(
			capabilityEnvironment(
				"Mozilla/5.0 AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
			),
		);
		expect(runtime).toMatchObject({
			supported: true,
			browserFamily: "chromium",
		});
		for (const resolution of ["360p", "720p", "1080p"] as const) {
			for (const fps of [25, 30] as const) {
				expect(
					getRecordingProfileSupport(runtime, resolution, fps),
				).toMatchObject({
					supported: true,
					source: "static-verified",
				});
			}
		}
		expect(getRecordingProfileSupport(runtime, "360p", 60).supported).toBe(
			true,
		);
		for (const resolution of ["720p", "1080p"] as const) {
			expect(getRecordingProfileSupport(runtime, resolution, 60)).toMatchObject(
				{
					supported: false,
					reason: "high-resolution-60fps-not-calibrated",
				},
			);
		}
	});

	it("accepts only a recent >=50 FPS short calibration for high-resolution 60", () => {
		const runtime = supportedRuntime();
		const now = Date.UTC(2026, 10, 20);
		expect(
			getRecordingProfileSupport(runtime, "720p", 60, {
				now,
				calibration: {
					resolution: "720p",
					fps: 60,
					observedFps: 50.2,
					durationMs: 3000,
					measuredAt: now - 1000,
				},
			}),
		).toMatchObject({ supported: true, source: "runtime-calibration" });
		expect(
			getRecordingProfileSupport(runtime, "720p", 60, {
				now,
				calibration: {
					resolution: "720p",
					fps: 60,
					observedFps: 49.9,
					durationMs: 3000,
					measuredAt: now - 1000,
				},
			}).supported,
		).toBe(false);
	});

	it("fails Safari/WebKit and mobile closed even when individual APIs exist", () => {
		expect(
			probeRecordingRuntimeSupport(
				capabilityEnvironment(
					"Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
				),
			),
		).toMatchObject({
			supported: false,
			browserFamily: "safari-webkit",
			reason: "safari-webkit-experimental",
		});
		expect(
			probeRecordingRuntimeSupport(
				capabilityEnvironment(
					"Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
				),
			),
		).toMatchObject({ supported: false, reason: "mobile-unsupported" });
	});

	it("fails closed for missing browser APIs and selected-mode MIME support", () => {
		const runtime = probeRecordingRuntimeSupport({
			...capabilityEnvironment("Mozilla/5.0 Chrome/131.0.0.0"),
			mediaRecorder: undefined,
		});
		expect(runtime).toMatchObject({
			supported: false,
			reason: "media-recorder-unavailable",
		});
		expect(
			withMimeRecordingRuntimeSupport(supportedRuntime(), {
				supported: false,
				capability: null,
				reason: "no-supported-recording-mime",
			}),
		).toMatchObject({
			supported: false,
			reason: "no-supported-recording-mime",
		});
	});

	it("allows 360p60 only on the verified Chromium family", () => {
		expect(
			getRecordingProfileSupport(
				supportedRuntime({ browserFamily: "firefox" }),
				"360p",
				60,
			),
		).toMatchObject({
			supported: false,
			reason: "360p60-chromium-only",
		});
	});
});
