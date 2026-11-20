import { describe, expect, it } from "vitest";
import {
	MEDIA_DIMENSIONS,
	OFFERED_MEDIA_FPS,
	READABLE_MEDIA_FPS,
	getRecordingBitrateKbps,
	getStreamingBitrateKbps,
	isOfferedMediaFps,
	isReadableMediaFps,
	resolveSenderScaleDownBy,
	resolveStreamingProfile,
} from "./media-profiles";

describe("media profiles", () => {
	it("defines streaming dimensions including true 360p", () => {
		expect(MEDIA_DIMENSIONS).toEqual({
			"4K": { width: 3840, height: 2160 },
			"1440p": { width: 2560, height: 1440 },
			"1080p": { width: 1920, height: 1080 },
			"720p": { width: 1280, height: 720 },
			"360p": { width: 640, height: 360 },
		});
	});

	it("resolves all offered streaming and recording bitrate targets", () => {
		expect(OFFERED_MEDIA_FPS).toEqual([25, 30, 60]);
		expect([
			getStreamingBitrateKbps("360p", 25),
			getStreamingBitrateKbps("360p", 30),
			getStreamingBitrateKbps("360p", 60),
			getStreamingBitrateKbps("720p", 25),
			getStreamingBitrateKbps("720p", 30),
			getStreamingBitrateKbps("720p", 60),
			getStreamingBitrateKbps("1080p", 25),
			getStreamingBitrateKbps("1080p", 30),
			getStreamingBitrateKbps("1080p", 60),
		]).toEqual([600, 800, 1200, 1800, 2500, 4000, 3500, 5000, 8000]);
		expect([
			getRecordingBitrateKbps("360p", 25),
			getRecordingBitrateKbps("360p", 30),
			getRecordingBitrateKbps("360p", 60),
			getRecordingBitrateKbps("720p", 25),
			getRecordingBitrateKbps("720p", 30),
			getRecordingBitrateKbps("720p", 60),
			getRecordingBitrateKbps("1080p", 25),
			getRecordingBitrateKbps("1080p", 30),
			getRecordingBitrateKbps("1080p", 60),
		]).toEqual([1000, 1300, 2000, 2800, 3500, 6000, 5500, 7000, 12000]);
	});

	it("reads legacy 120 FPS without offering it for new settings", () => {
		expect(READABLE_MEDIA_FPS).toEqual([25, 30, 60, 120]);
		expect(isReadableMediaFps(120)).toBe(true);
		expect(isOfferedMediaFps(120)).toBe(false);
		const legacy = resolveStreamingProfile("720p", 120);
		expect(legacy).toMatchObject({
			fps: 120,
			bitrateKbps: 4000,
			isLegacyFps: true,
		});
	});

	it("creates exact 360p/25 capture constraints and does not fall back to 1080p", () => {
		expect(resolveStreamingProfile("360p", 25)).toMatchObject({
			width: 640,
			height: 360,
			fps: 25,
			bitrateKbps: 600,
			captureConstraints: {
				width: { ideal: 640, max: 640 },
				height: { ideal: 360, max: 360 },
				frameRate: { ideal: 25, max: 25 },
			},
		});
	});

	it("computes sender downscale from actual source settings", () => {
		expect(
			resolveSenderScaleDownBy(
				{ width: 1920, height: 1080 },
				{ width: 640, height: 360 },
			),
		).toBe(3);
		expect(
			resolveSenderScaleDownBy(
				{ width: 1280, height: 720 },
				{ width: 1920, height: 1080 },
			),
		).toBe(1);
		expect(
			resolveSenderScaleDownBy({}, { width: 640, height: 360 }),
		).toBeUndefined();
	});
});
