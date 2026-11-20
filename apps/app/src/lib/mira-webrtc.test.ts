import { describe, expect, it, vi } from "vitest";
import {
	type StreamQualityConfig,
	applySenderConfig,
	enforcePublishedVideoFps,
	resolveScreenCaptureOptions,
	updateLiveFps,
} from "./mira-webrtc";

const config360: StreamQualityConfig = {
	resolution: "360p",
	fps: 25,
	bitrateKbps: 600,
	codec: "H.264",
	audioEnabled: false,
};

describe("Mira WebRTC media profiles", () => {
	it("builds exact host/guest capture options from a shared profile", () => {
		expect(resolveScreenCaptureOptions(config360)).toEqual({
			video: {
				width: { ideal: 640, max: 640 },
				height: { ideal: 360, max: 360 },
				frameRate: { ideal: 25, max: 25 },
			},
			audio: false,
		});
		expect(
			resolveScreenCaptureOptions({ ...config360, audioEnabled: true }).audio,
		).toEqual({
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
		});
	});

	it("applies bitrate, FPS, actual-track downscale, and text-safe degradation policy", async () => {
		const setParameters = vi.fn().mockResolvedValue(undefined);
		const track = {
			kind: "video",
			contentHint: "",
			getSettings: () => ({ width: 1920, height: 1080 }),
		} as unknown as MediaStreamTrack;
		const sender = {
			track,
			getParameters: () => ({ encodings: [] }),
			setParameters,
		} as unknown as RTCRtpSender;
		const pc = {
			getSenders: () => [sender],
		} as unknown as RTCPeerConnection;

		await applySenderConfig(pc, track, config360);

		expect(track.contentHint).toBe("detail");
		expect(setParameters).toHaveBeenCalledWith({
			encodings: [
				{
					maxBitrate: 600_000,
					maxFramerate: 25,
					scaleResolutionDownBy: 3,
				},
			],
			degradationPreference: "maintain-resolution",
		});
	});

	it("enforces the selected FPS on capture constraints and every sender encoding", async () => {
		const applyConstraints = vi.fn().mockResolvedValue(undefined);
		const firstSetParameters = vi.fn().mockResolvedValue(undefined);
		const secondSetParameters = vi.fn().mockResolvedValue(undefined);
		const track = {
			kind: "video",
			applyConstraints,
		} as unknown as MediaStreamTrack;
		const first = {
			track,
			getParameters: () => ({ encodings: [{ maxFramerate: 60 }] }),
			setParameters: firstSetParameters,
		} as unknown as RTCRtpSender;
		const second = {
			track,
			getParameters: () => ({ encodings: [] }),
			setParameters: secondSetParameters,
		} as unknown as RTCRtpSender;

		await expect(
			enforcePublishedVideoFps(track, [first, second], 25),
		).resolves.toBe(true);
		expect(applyConstraints).toHaveBeenCalledWith({
			frameRate: { ideal: 25, max: 25 },
		});
		expect(firstSetParameters).toHaveBeenCalledWith({
			encodings: [{ maxFramerate: 25 }],
		});
		expect(secondSetParameters).toHaveBeenCalledWith({
			encodings: [{ maxFramerate: 25 }],
		});
	});

	it("updates every mesh sender that publishes the selected screen track", async () => {
		const applyConstraints = vi.fn().mockResolvedValue(undefined);
		const setParameters = vi.fn().mockResolvedValue(undefined);
		const track = {
			kind: "video",
			applyConstraints,
		} as unknown as MediaStreamTrack;
		const sender = {
			track,
			getParameters: () => ({ encodings: [{ maxFramerate: 60 }] }),
			setParameters,
		} as unknown as RTCRtpSender;
		const peer = {
			getSenders: () => [sender],
		} as unknown as RTCPeerConnection;

		await expect(updateLiveFps([peer], track, 30)).resolves.toBe(true);
		expect(setParameters).toHaveBeenCalledWith({
			encodings: [{ maxFramerate: 30 }],
		});
	});
});
