import type { OfferedMediaFps, RecordingResolution } from "../media-profiles";

export type RecordingContainer = "webm" | "mp4";
export type RecordingVideoCodec = "vp9" | "vp8" | "h264" | null;
export type RecordingAudioCodec = "opus" | "aac" | null;

export interface RecordingMimeCapability {
	mimeType: string;
	container: RecordingContainer;
	fileExtension: RecordingContainer;
	videoCodec: RecordingVideoCodec;
	audioCodec: RecordingAudioCodec;
}

export interface RecordingMimeSelectionOptions {
	isTypeSupported: (mimeType: string) => boolean;
	preferSafariMp4?: boolean;
	preferVp8?: boolean;
	includeAudio?: boolean;
}

export interface RecordingEncoderSelection {
	mime: RecordingMimeCapability;
	videoBitsPerSecond: number;
	audioBitsPerSecond?: number;
}

export interface RecordingEncoderSelectionOptions
	extends RecordingMimeSelectionOptions {
	videoBitrateKbps: number;
	audioBitrateKbps?: number;
}

export type RecordingMimeSelection =
	| { supported: true; capability: RecordingMimeCapability }
	| {
			supported: false;
			capability: null;
			reason: "no-supported-recording-mime";
	  };

function webmCapability(
	videoCodec: "vp9" | "vp8",
	includeAudio: boolean,
): RecordingMimeCapability {
	const audioCodec = includeAudio ? "opus" : null;
	return {
		mimeType: includeAudio
			? `video/webm;codecs=${videoCodec},opus`
			: `video/webm;codecs=${videoCodec}`,
		container: "webm",
		fileExtension: "webm",
		videoCodec,
		audioCodec,
	};
}

function mp4Capability(includeAudio: boolean): RecordingMimeCapability {
	return {
		mimeType: includeAudio
			? "video/mp4;codecs=avc1.42E01E,mp4a.40.2"
			: "video/mp4;codecs=avc1.42E01E",
		container: "mp4",
		fileExtension: "mp4",
		videoCodec: "h264",
		audioCodec: includeAudio ? "aac" : null,
	};
}

function genericMp4Capability(): RecordingMimeCapability {
	return {
		mimeType: "video/mp4",
		container: "mp4",
		fileExtension: "mp4",
		// A generic Safari MP4 probe does not promise a specific codec string.
		videoCodec: null,
		audioCodec: null,
	};
}

export function getRecordingMimeCandidates(
	options: Omit<RecordingMimeSelectionOptions, "isTypeSupported"> = {},
): RecordingMimeCapability[] {
	const includeAudio = options.includeAudio ?? true;
	const vp9 = webmCapability("vp9", includeAudio);
	const vp8 = webmCapability("vp8", includeAudio);
	const mp4 = mp4Capability(includeAudio);
	const genericMp4 = genericMp4Capability();
	const webmOrder = options.preferVp8 ? [vp8, vp9] : [vp9, vp8];
	return options.preferSafariMp4
		? [mp4, genericMp4, ...webmOrder]
		: [...webmOrder, mp4, genericMp4];
}

export function selectRecordingMimeCapability(
	options: RecordingMimeSelectionOptions,
): RecordingMimeSelection {
	for (const capability of getRecordingMimeCandidates(options)) {
		try {
			if (options.isTypeSupported(capability.mimeType)) {
				return { supported: true, capability };
			}
		} catch {
			// Capability probes are browser APIs and may throw in partial implementations.
		}
	}
	return {
		supported: false,
		capability: null,
		reason: "no-supported-recording-mime",
	};
}

export function selectRecordingEncoder(
	options: RecordingEncoderSelectionOptions,
): RecordingEncoderSelection | null {
	const selected = selectRecordingMimeCapability(options);
	if (!selected.supported) return null;
	return {
		mime: selected.capability,
		videoBitsPerSecond: Math.max(
			100_000,
			Math.round(options.videoBitrateKbps * 1000),
		),
		audioBitsPerSecond:
			options.includeAudio === false
				? undefined
				: Math.max(
						32_000,
						Math.round((options.audioBitrateKbps ?? 128) * 1000),
					),
	};
}

export type RecordingBrowserFamily =
	| "chromium"
	| "firefox"
	| "safari-webkit"
	| "unknown";

export type RecordingRuntimeUnsupportedReason =
	| "mobile-unsupported"
	| "safari-webkit-experimental"
	| "media-recorder-unavailable"
	| "media-recorder-mime-probe-unavailable"
	| "canvas-2d-unavailable"
	| "canvas-capture-unavailable"
	| "media-stream-unavailable"
	| "indexeddb-unavailable"
	| "no-supported-recording-mime";

export interface RecordingRuntimeSupport {
	supported: boolean;
	browserFamily: RecordingBrowserFamily;
	isMobile: boolean;
	mediaRecorder: boolean;
	mimeProbe: boolean;
	canvas2d: boolean;
	canvasCapture: boolean;
	mediaStream: boolean;
	indexedDb: boolean;
	audioMixing: boolean;
	reason: RecordingRuntimeUnsupportedReason | null;
	message: string | null;
}

export interface RecordingCapabilityEnvironment {
	userAgent?: string;
	vendor?: string;
	mediaRecorder?: typeof MediaRecorder;
	mediaStream?: typeof MediaStream;
	indexedDb?: IDBFactory;
	audioContext?: typeof AudioContext;
	createCanvas?: () => HTMLCanvasElement;
}

export interface RecordingProfileCalibration {
	resolution: RecordingResolution;
	fps: OfferedMediaFps;
	observedFps: number;
	durationMs: number;
	measuredAt: number;
}

export type RecordingProfileSupportReason =
	| RecordingRuntimeUnsupportedReason
	| "high-resolution-60fps-not-calibrated"
	| "360p60-chromium-only";

export interface RecordingProfileSupport {
	supported: boolean;
	reason: RecordingProfileSupportReason | null;
	message: string | null;
	source: "static-verified" | "runtime-calibration" | "unsupported";
}

function detectBrowserFamily(
	userAgent: string,
	vendor: string,
): RecordingBrowserFamily {
	if (/Firefox|FxiOS/i.test(userAgent)) return "firefox";
	if (
		/AppleWebKit/i.test(userAgent) &&
		(/Safari/i.test(userAgent) || /Apple/i.test(vendor)) &&
		!/Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser/i.test(userAgent)
	)
		return "safari-webkit";
	if (/Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser/i.test(userAgent))
		return "chromium";
	return "unknown";
}

function unsupportedRuntime(
	base: Omit<RecordingRuntimeSupport, "supported" | "reason" | "message">,
	reason: RecordingRuntimeUnsupportedReason,
	message: string,
): RecordingRuntimeSupport {
	return { ...base, supported: false, reason, message };
}

/**
 * Cheap synchronous release gate. It checks API shape and MIME support only; it
 * never starts an encoder or runs a frame-rate benchmark during page load.
 */
export function probeRecordingRuntimeSupport(
	environment: RecordingCapabilityEnvironment = {},
): RecordingRuntimeSupport {
	const userAgent =
		environment.userAgent ??
		(typeof navigator === "undefined" ? "" : navigator.userAgent);
	const vendor =
		environment.vendor ??
		(typeof navigator === "undefined" ? "" : navigator.vendor);
	const browserFamily = detectBrowserFamily(userAgent, vendor);
	const isMobile = /Android|iPhone|iPad|iPod|Mobile|IEMobile/i.test(userAgent);
	const Recorder =
		environment.mediaRecorder ??
		(typeof MediaRecorder === "undefined" ? undefined : MediaRecorder);
	const Stream =
		environment.mediaStream ??
		(typeof MediaStream === "undefined" ? undefined : MediaStream);
	const database =
		environment.indexedDb ??
		(typeof indexedDB === "undefined" ? undefined : indexedDB);
	const Audio =
		environment.audioContext ??
		(typeof AudioContext === "undefined" ? undefined : AudioContext);
	let canvas2d = false;
	let canvasCapture = false;
	try {
		const canvas =
			environment.createCanvas?.() ??
			(typeof document === "undefined"
				? undefined
				: document.createElement("canvas"));
		canvas2d = Boolean(canvas?.getContext?.("2d"));
		canvasCapture = typeof canvas?.captureStream === "function";
	} catch {
		// Partial DOM/canvas implementations fail closed below.
	}
	const mediaRecorder = typeof Recorder === "function";
	const mimeProbe = typeof Recorder?.isTypeSupported === "function";
	const base = {
		browserFamily,
		isMobile,
		mediaRecorder,
		mimeProbe,
		canvas2d,
		canvasCapture,
		mediaStream: typeof Stream === "function",
		indexedDb: Boolean(database),
		audioMixing: typeof Audio === "function",
	};
	if (isMobile)
		return unsupportedRuntime(
			base,
			"mobile-unsupported",
			"Local recording downloads are not supported on mobile browsers in this release.",
		);
	if (browserFamily === "safari-webkit")
		return unsupportedRuntime(
			base,
			"safari-webkit-experimental",
			"Local recording is experimental and disabled on Safari/WebKit until MediaRecorder, canvas capture, audio, and output playback are verified on a supported macOS release runner.",
		);
	if (!mediaRecorder)
		return unsupportedRuntime(
			base,
			"media-recorder-unavailable",
			"Local recording is unavailable because this browser does not expose MediaRecorder.",
		);
	if (!mimeProbe)
		return unsupportedRuntime(
			base,
			"media-recorder-mime-probe-unavailable",
			"Local recording is unavailable because this browser cannot verify an output recording format.",
		);
	if (!canvas2d)
		return unsupportedRuntime(
			base,
			"canvas-2d-unavailable",
			"Local recording is unavailable because 2D canvas composition is not supported.",
		);
	if (!canvasCapture)
		return unsupportedRuntime(
			base,
			"canvas-capture-unavailable",
			"Local recording is unavailable because canvas video capture is not supported.",
		);
	if (!base.mediaStream)
		return unsupportedRuntime(
			base,
			"media-stream-unavailable",
			"Local recording is unavailable because MediaStream is not supported.",
		);
	if (!base.indexedDb)
		return unsupportedRuntime(
			base,
			"indexeddb-unavailable",
			"Local recording is unavailable because local browser storage is not supported.",
		);
	return { ...base, supported: true, reason: null, message: null };
}

function validHighFpsCalibration(
	resolution: RecordingResolution,
	calibration: RecordingProfileCalibration | null | undefined,
	now: number,
): boolean {
	return Boolean(
		calibration &&
			calibration.resolution === resolution &&
			calibration.fps === 60 &&
			calibration.observedFps >= 50 &&
			calibration.durationMs >= 3000 &&
			calibration.measuredAt <= now &&
			now - calibration.measuredAt <= 30 * 24 * 60 * 60 * 1000,
	);
}

/** Release profile policy, intentionally separate from live-stream FPS choices. */
export function getRecordingProfileSupport(
	runtime: RecordingRuntimeSupport,
	resolution: RecordingResolution,
	fps: OfferedMediaFps,
	options: {
		calibration?: RecordingProfileCalibration | null;
		now?: number;
	} = {},
): RecordingProfileSupport {
	if (!runtime.supported) {
		return {
			supported: false,
			reason: runtime.reason,
			message: runtime.message,
			source: "unsupported",
		};
	}
	if (fps === 25 || fps === 30) {
		return {
			supported: true,
			reason: null,
			message: null,
			source: "static-verified",
		};
	}
	if (resolution === "360p") {
		if (runtime.browserFamily === "chromium") {
			return {
				supported: true,
				reason: null,
				message: null,
				source: "static-verified",
			};
		}
		return {
			supported: false,
			reason: "360p60-chromium-only",
			message:
				"60 FPS local recording is enabled only for verified Chromium 360p output in this release. Use 25 or 30 FPS in this browser.",
			source: "unsupported",
		};
	}
	if (
		validHighFpsCalibration(
			resolution,
			options.calibration,
			options.now ?? Date.now(),
		)
	) {
		return {
			supported: true,
			reason: null,
			message: null,
			source: "runtime-calibration",
		};
	}
	return {
		supported: false,
		reason: "high-resolution-60fps-not-calibrated",
		message: `${resolution} at 60 FPS is disabled for local download because current validation produced about 31 FPS. Use 25 or 30 FPS; 60 FPS requires a recent short calibration measuring at least 50 FPS.`,
		source: "unsupported",
	};
}

export function withMimeRecordingRuntimeSupport(
	runtime: RecordingRuntimeSupport,
	mimeSelection: RecordingMimeSelection | null,
): RecordingRuntimeSupport {
	if (!runtime.supported || mimeSelection?.supported) return runtime;
	return {
		...runtime,
		supported: false,
		reason: "no-supported-recording-mime",
		message:
			"Local recording is unavailable because this browser does not expose a supported recording format for the selected audio mode.",
	};
}
