/**
 * Mira WebRTC stream helpers.
 */

import {
	MEDIA_DIMENSIONS,
	type ReadableMediaFps,
	type StreamingResolution,
	resolveSenderScaleDownBy,
	resolveStreamingProfile,
} from "./media-profiles";

export interface StreamQualityConfig {
	resolution: StreamingResolution;
	fps: ReadableMediaFps;
	bitrateKbps: number;
	codec: "AV1" | "VP9" | "H.264";
	audioEnabled: boolean;
}

export const RESOLUTION_CONSTRAINTS = MEDIA_DIMENSIONS;

export function resolveScreenCaptureOptions(
	config: Pick<StreamQualityConfig, "resolution" | "fps" | "audioEnabled">,
): DisplayMediaStreamOptions {
	const profile = resolveStreamingProfile(config.resolution, config.fps);
	return {
		video: profile.captureConstraints,
		audio: config.audioEnabled
			? {
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false,
				}
			: false,
	};
}

/**
 * Applies the quality config to a captured video track + its RtpSender:
 * - contentHint "motion" prevents Chromium from downclocking screen capture to
 *   5-15 FPS (required for 60+ FPS streaming).
 * - maxBitrate overrides WebRTC's low default bandwidth estimate.
 * - degradationPreference "maintain-framerate" drops resolution (not FPS) under
 *   packet loss.
 */
export async function applySenderConfig(
	pc: RTCPeerConnection,
	track: MediaStreamTrack,
	config: StreamQualityConfig,
) {
	// Use "detail" so Chromium WebRTC preserves crystal-clear resolution (no blur) under SCTP or network jitter
	track.contentHint = "detail";

	const sender = pc.getSenders().find((s) => s.track === track);
	if (!sender) return;

	try {
		const profile = resolveStreamingProfile(config.resolution, config.fps);
		const params = sender.getParameters();
		if (!params.encodings || params.encodings.length === 0) {
			params.encodings = [{}];
		}
		const first = params.encodings[0] ?? {};
		first.maxBitrate = (config.bitrateKbps || profile.bitrateKbps) * 1000;
		first.maxFramerate = profile.fps;
		const scaleResolutionDownBy = resolveSenderScaleDownBy(
			track.getSettings(),
			profile,
		);
		if (scaleResolutionDownBy !== undefined) {
			first.scaleResolutionDownBy = scaleResolutionDownBy;
		}
		params.encodings[0] = first;
		// Preserve text readability at low resolutions, especially deliberate 360p output.
		params.degradationPreference = "maintain-resolution";
		await sender.setParameters(params);
	} catch {
		// setParameters is best-effort; some browsers reject mid-negotiation edits.
	}
}

async function applySenderFps(
	sender: RTCRtpSender,
	fps: number,
): Promise<boolean> {
	try {
		const params = sender.getParameters();
		if (!params.encodings || params.encodings.length === 0) {
			params.encodings = [{}];
		}
		params.encodings = params.encodings.map((encoding) => ({
			...encoding,
			maxFramerate: fps,
		}));
		await sender.setParameters(params);
		return true;
	} catch {
		return false;
	}
}

/**
 * Enforces a selected FPS on both the capture track and every publisher
 * encoding. Applying only capture constraints is insufficient for SFU tracks,
 * while applying only sender parameters can leave capture at the previous rate.
 */
export async function enforcePublishedVideoFps(
	track: MediaStreamTrack | null,
	senders: Iterable<RTCRtpSender>,
	fps: number,
): Promise<boolean> {
	let applied = false;
	if (track?.kind === "video") {
		try {
			await track.applyConstraints({
				frameRate: { ideal: fps, max: fps },
			});
			applied = true;
		} catch {
			// Sender maxFramerate remains a valid enforcement fallback.
		}
	}
	for (const sender of senders) {
		if (await applySenderFps(sender, fps)) applied = true;
	}
	return applied;
}

/**
 * Live mid-broadcast bitrate update: works without renegotiation because it
 * only touches sender encodings. Returns false if the browser rejected it.
 */
export async function updateLiveBitrate(
	peerConnections: Iterable<RTCPeerConnection>,
	track: MediaStreamTrack | null,
	bitrateKbps: number,
): Promise<boolean> {
	let applied = false;
	for (const pc of peerConnections) {
		const sender = pc.getSenders().find((s) => s.track === track);
		if (!sender) continue;
		try {
			const params = sender.getParameters();
			if (!params.encodings || params.encodings.length === 0) {
				params.encodings = [{}];
			}
			const first = params.encodings[0] ?? {};
			first.maxBitrate = bitrateKbps * 1000;
			params.encodings[0] = first;
			await sender.setParameters(params);
			applied = true;
		} catch {
			// Skip this sender; try the rest.
		}
	}
	return applied;
}

/**
 * Live mesh frame-rate update. Caps the capture track and every matching RTP
 * sender so the selected value is the actual outgoing ceiling.
 */
export async function updateLiveFps(
	peerConnections: Iterable<RTCPeerConnection>,
	track: MediaStreamTrack | null,
	fps: number,
): Promise<boolean> {
	const senders: RTCRtpSender[] = [];
	for (const pc of peerConnections) {
		const sender = pc
			.getSenders()
			.find((candidate) => candidate.track === track);
		if (sender) senders.push(sender);
	}
	return enforcePublishedVideoFps(track, senders, fps);
}

/**
 * Restricts the set of codecs offered for a video transceiver. Prefers the
 * configured codec when the browser supports it; AV1 software encoding is
 * avoided unless explicitly chosen (it can saturate CPU at 1080p60).
 */
export function setCodecPreferences(
	transceiver: RTCRtpTransceiver,
	codec: StreamQualityConfig["codec"],
) {
	const caps = RTCRtpSender.getCapabilities("video");
	if (!caps) return;

	// Priority order: configured codec first, then safe fallbacks.
	const priority = (() => {
		if (codec === "AV1") return ["AV1", "VP9", "H264", "VP8"];
		if (codec === "VP9") return ["VP9", "H264", "VP8", "AV1"];
		return ["H264", "VP8", "VP9", "AV1"];
	})();

	const ordered: RTCRtpCodec[] = [];
	for (const want of priority) {
		for (const c of caps.codecs) {
			if (c.mimeType.toLowerCase() === `video/${want.toLowerCase()}`) {
				ordered.push(c);
			}
		}
	}
	// Keep any remaining codecs at the end so negotiation never fails outright.
	for (const c of caps.codecs) {
		if (!ordered.includes(c)) ordered.push(c);
	}
	if (ordered.length === 0) return;
	try {
		transceiver.setCodecPreferences(ordered);
	} catch {
		// Best-effort; unsupported browsers keep default preferences.
	}
}

export {
	buildIceServers,
	buildRtcConfiguration,
	DEFAULT_STUN_SERVERS,
} from "./ice";
export type { IceEnv } from "./ice";
export { configureIceRestart } from "./ice-restart";
export type { IceRestartOptions, IceRestartController } from "./ice-restart";

export { extractPeerStats } from "./webrtc-stats";
export type { PeerConnectionStats } from "./webrtc-stats";
