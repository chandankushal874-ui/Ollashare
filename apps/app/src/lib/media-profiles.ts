export const STREAMING_RESOLUTIONS = [
	"4K",
	"1440p",
	"1080p",
	"720p",
	"360p",
] as const;
export const RECORDING_RESOLUTIONS = ["1080p", "720p", "360p"] as const;
export const ADAPTIVE_SCREEN_RESOLUTIONS = ["360p", "720p", "1080p"] as const;
export const OFFERED_MEDIA_FPS = [25, 30, 60] as const;
export const READABLE_MEDIA_FPS = [25, 30, 60, 120] as const;

export type StreamingResolution = (typeof STREAMING_RESOLUTIONS)[number];
export type RecordingResolution = (typeof RECORDING_RESOLUTIONS)[number];
export type OfferedMediaFps = (typeof OFFERED_MEDIA_FPS)[number];
export type ReadableMediaFps = (typeof READABLE_MEDIA_FPS)[number];

export interface MediaDimensions {
	width: number;
	height: number;
}

export interface ResolvedStreamingProfile extends MediaDimensions {
	resolution: StreamingResolution;
	fps: ReadableMediaFps;
	bitrateKbps: number;
	captureConstraints: MediaTrackConstraints;
	isLegacyFps: boolean;
}

export interface ResolvedRecordingProfile extends MediaDimensions {
	resolution: RecordingResolution;
	fps: ReadableMediaFps;
	bitrateKbps: number;
	isLegacyFps: boolean;
}

export interface AdaptiveScreenLayer extends MediaDimensions {
	resolution: RecordingResolution;
	fps: OfferedMediaFps;
	bitrateKbps: number;
}

export const MEDIA_DIMENSIONS: Readonly<
	Record<StreamingResolution, MediaDimensions>
> = {
	"4K": { width: 3840, height: 2160 },
	"1440p": { width: 2560, height: 1440 },
	"1080p": { width: 1920, height: 1080 },
	"720p": { width: 1280, height: 720 },
	"360p": { width: 640, height: 360 },
};

const STREAMING_BITRATES_KBPS: Readonly<
	Record<StreamingResolution, Readonly<Record<OfferedMediaFps, number>>>
> = {
	"4K": { 25: 10_000, 30: 14_000, 60: 20_000 },
	"1440p": { 25: 6_000, 30: 8_000, 60: 12_000 },
	"1080p": { 25: 3_500, 30: 5_000, 60: 8_000 },
	"720p": { 25: 1_800, 30: 2_500, 60: 4_000 },
	"360p": { 25: 600, 30: 800, 60: 1_200 },
};

const RECORDING_BITRATES_KBPS: Readonly<
	Record<RecordingResolution, Readonly<Record<OfferedMediaFps, number>>>
> = {
	"1080p": { 25: 5_500, 30: 7_000, 60: 12_000 },
	"720p": { 25: 2_800, 30: 3_500, 60: 6_000 },
	"360p": { 25: 1_000, 30: 1_300, 60: 2_000 },
};

function normalizeResolution(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.toLowerCase() === "4k" ? "4K" : value;
}

export function isStreamingResolution(
	value: unknown,
): value is StreamingResolution {
	return STREAMING_RESOLUTIONS.includes(
		normalizeResolution(value) as StreamingResolution,
	);
}

export function isRecordingResolution(
	value: unknown,
): value is RecordingResolution {
	return RECORDING_RESOLUTIONS.includes(
		normalizeResolution(value) as RecordingResolution,
	);
}

export function isReadableMediaFps(value: unknown): value is ReadableMediaFps {
	return (
		typeof value === "number" &&
		READABLE_MEDIA_FPS.includes(value as ReadableMediaFps)
	);
}

export function isOfferedMediaFps(value: unknown): value is OfferedMediaFps {
	return (
		typeof value === "number" &&
		OFFERED_MEDIA_FPS.includes(value as OfferedMediaFps)
	);
}

export function resolveStreamingResolution(
	value: unknown,
	fallback: StreamingResolution = "1080p",
): StreamingResolution {
	const normalized = normalizeResolution(value);
	return isStreamingResolution(normalized) ? normalized : fallback;
}

export function resolveRecordingResolution(
	value: unknown,
	fallback: RecordingResolution = "1080p",
): RecordingResolution {
	const normalized = normalizeResolution(value);
	return isRecordingResolution(normalized) ? normalized : fallback;
}

export function resolveReadableMediaFps(
	value: unknown,
	fallback: ReadableMediaFps = 60,
): ReadableMediaFps {
	return isReadableMediaFps(value) ? value : fallback;
}

export function resolveOfferedMediaFps(
	value: unknown,
	fallback: OfferedMediaFps = 60,
): OfferedMediaFps {
	return isOfferedMediaFps(value) ? value : fallback;
}

function bitrateLookupFps(fps: ReadableMediaFps): OfferedMediaFps {
	// Legacy 120 FPS rooms remain readable. Their bitrate resolves conservatively
	// to the 60 FPS ceiling, but 120 is never returned by the offered-FPS helper.
	return fps === 120 ? 60 : fps;
}

export function getStreamingBitrateKbps(
	resolution: StreamingResolution,
	fps: ReadableMediaFps,
): number {
	return STREAMING_BITRATES_KBPS[resolution][bitrateLookupFps(fps)];
}

export function getRecordingBitrateKbps(
	resolution: RecordingResolution,
	fps: ReadableMediaFps,
): number {
	return RECORDING_BITRATES_KBPS[resolution][bitrateLookupFps(fps)];
}

export function buildScreenCaptureConstraints(
	resolution: StreamingResolution,
	fps: ReadableMediaFps,
): MediaTrackConstraints {
	const { width, height } = MEDIA_DIMENSIONS[resolution];
	return {
		width: { ideal: width, max: width },
		height: { ideal: height, max: height },
		frameRate: { ideal: fps, max: fps },
	};
}

export function resolveStreamingProfile(
	resolution: unknown,
	fps: unknown,
): ResolvedStreamingProfile {
	const resolvedResolution = resolveStreamingResolution(resolution);
	const resolvedFps = resolveReadableMediaFps(fps);
	const dimensions = MEDIA_DIMENSIONS[resolvedResolution];
	return {
		resolution: resolvedResolution,
		fps: resolvedFps,
		...dimensions,
		bitrateKbps: getStreamingBitrateKbps(resolvedResolution, resolvedFps),
		captureConstraints: buildScreenCaptureConstraints(
			resolvedResolution,
			resolvedFps,
		),
		isLegacyFps: resolvedFps === 120,
	};
}

/**
 * Returns additional screen-share layers from lowest to highest quality.
 * The selected profile remains the primary layer; these layers let LiveKit
 * subscribers adapt between 360p, 720p, and 1080p without renegotiation.
 */
export function resolveAdaptiveScreenLayers(
	resolution: StreamingResolution,
	fps: OfferedMediaFps,
): AdaptiveScreenLayer[] {
	const selectedHeight = MEDIA_DIMENSIONS[resolution].height;
	return ADAPTIVE_SCREEN_RESOLUTIONS.filter(
		(candidate) => MEDIA_DIMENSIONS[candidate].height < selectedHeight,
	).map((candidate) => ({
		resolution: candidate,
		fps,
		...MEDIA_DIMENSIONS[candidate],
		bitrateKbps: getStreamingBitrateKbps(candidate, fps),
	}));
}

export function resolveRecordingProfile(
	resolution: unknown,
	fps: unknown,
): ResolvedRecordingProfile {
	const resolvedResolution = resolveRecordingResolution(resolution);
	const resolvedFps = resolveReadableMediaFps(fps);
	return {
		resolution: resolvedResolution,
		fps: resolvedFps,
		...MEDIA_DIMENSIONS[resolvedResolution],
		bitrateKbps: getRecordingBitrateKbps(resolvedResolution, resolvedFps),
		isLegacyFps: resolvedFps === 120,
	};
}

export function resolveSenderScaleDownBy(
	trackSettings: Pick<MediaTrackSettings, "width" | "height"> | undefined,
	target: MediaDimensions,
): number | undefined {
	const sourceWidth = trackSettings?.width;
	const sourceHeight = trackSettings?.height;
	if (!sourceWidth || !sourceHeight) return undefined;
	const scale = Math.max(
		sourceWidth / target.width,
		sourceHeight / target.height,
		1,
	);
	return Math.round(scale * 1000) / 1000;
}
