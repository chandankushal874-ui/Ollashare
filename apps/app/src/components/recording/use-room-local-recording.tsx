"use client";

import type { SharedBrowserFrameHandle } from "@/components/shared-browser/frame-source";
import type { AnnotationStroke } from "@/lib/annotation-types";
import {
	type OfferedMediaFps,
	type RecordingResolution,
	resolveRecordingProfile,
} from "@/lib/media-profiles";
import {
	type RecordingRuntimeSupport,
	getRecordingProfileSupport,
	probeRecordingRuntimeSupport,
	selectRecordingMimeCapability,
	withMimeRecordingRuntimeSupport,
} from "@/lib/recording/capabilities";
import {
	type RoomRecordingScreenAudioSource,
	type RoomRecordingScreenSource,
	buildRoomRecordingAnnotations,
	mapRoomRecordingSources,
} from "@/lib/recording/room-source-mapping";
import type { RecordingSourceInput } from "@/lib/recording/source-registry";
import type { LocalRecordingAnnotations } from "@/lib/recording/use-local-recording";
import { useLocalRecording } from "@/lib/recording/use-local-recording";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RecordingConsentDialog } from "./recording-consent-dialog";
import { RecordingControls, type RecordingTarget } from "./recording-controls";
import { RecordingIndicator } from "./recording-indicator";

export interface RoomLocalRecordingProps {
	roomCode: string;
	joined: boolean;
	roomLive: boolean;
	isHost: boolean;
	compact?: boolean;
	sourceAvailable?: boolean;
	controlsPortalTarget?: HTMLElement | null;
	screenSources: readonly RoomRecordingScreenSource[];
	liveKitScreenAudioTracks?: readonly RoomRecordingScreenAudioSource[];
	focusedSourceId?: string | null;
	screenAnnotations?: Readonly<Record<string, readonly AnnotationStroke[]>>;
	screenAnnotationDrafts?: Readonly<Record<string, AnnotationStroke | null>>;
	sharedBrowserFrame?: SharedBrowserFrameHandle | null;
	sharedBrowserViewerState?: string;
	sharedBrowserAnnotations?: readonly AnnotationStroke[];
	sharedBrowserAnnotationDraft?: AnnotationStroke | null;
}

export const LOCAL_RECORDING_ENABLED =
	process.env.NEXT_PUBLIC_LOCAL_RECORDING_ENABLED === "true";
export const SHARED_BROWSER_RECORDING_ENABLED =
	process.env.NEXT_PUBLIC_SHARED_BROWSER_RECORDING_ENABLED === "true";
export const LOCAL_RECORDING_360P_ENABLED =
	process.env.NEXT_PUBLIC_LOCAL_RECORDING_360P_ENABLED === "true";

function failureCategory(error: Error | null): string {
	const message = error?.message.toLowerCase() ?? "";
	if (message.includes("backpressure")) return "storage_backpressure";
	if (message.includes("quota") || message.includes("indexeddb"))
		return "storage_failure";
	if (message.includes("source") || message.includes("canvas"))
		return "source_failure";
	if (message.includes("awareness")) return "awareness_failure";
	return "client_failure";
}

function errorMessage(error: Error | null): string | null {
	if (!error) return null;
	const message = error.message.toLowerCase();
	if (message.includes("backpressure"))
		return "Recording stopped because local storage could not keep up with encoded chunks. Download or cancel the partial recording, free storage, and use a lower profile.";
	if (message.includes("quota") || message.includes("indexeddb"))
		return "Recording stopped because browser storage is unavailable or full. Free local storage and try again.";
	if (message.includes("source") || message.includes("canvas"))
		return "The selected recording source ended or became inaccessible.";
	return error.message;
}

export function RoomLocalRecording(props: RoomLocalRecordingProps) {
	const activeAwareness = useQuery(
		api.screenshare.getActiveLocalRecording,
		props.joined && props.roomCode ? { code: props.roomCode } : "skip",
	);
	const startAwareness = useMutation(api.screenshare.startLocalRecording);
	const heartbeatAwareness = useMutation(
		api.screenshare.heartbeatLocalRecording,
	);
	const pauseAwareness = useMutation(api.screenshare.setLocalRecordingPaused);
	const finishAwareness = useMutation(api.screenshare.finishLocalRecording);

	const [target, setTarget] = useState<RecordingTarget>("focused");
	const [resolution, setResolution] = useState<RecordingResolution>("1080p");
	const [fps, setFps] = useState<OfferedMediaFps>(30);
	const [includeAudio, setIncludeAudio] = useState(true);
	const [consentOpen, setConsentOpen] = useState(false);
	const [runtimeSupport, setRuntimeSupport] =
		useState<RecordingRuntimeSupport | null>(null);
	const [localRecordingId] = useState(
		() => `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	const createLocalRecordingId = useCallback(
		() => `local-${Date.now()}-${crypto.randomUUID()}`,
		[],
	);
	const awarenessIdRef = useRef<Id<"screenshareLocalRecordings"> | null>(null);
	const awarenessFinishedRef = useRef(false);
	const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		setRuntimeSupport(probeRecordingRuntimeSupport());
	}, []);

	const screenSources = useMemo(
		() =>
			mapRoomRecordingSources(
				props.screenSources,
				props.liveKitScreenAudioTracks ?? [],
			),
		[props.liveKitScreenAudioTracks, props.screenSources],
	);
	const sharedBrowserAvailable = Boolean(
		SHARED_BROWSER_RECORDING_ENABLED &&
			props.sharedBrowserFrame &&
			props.sharedBrowserViewerState === "connected",
	);
	useEffect(() => {
		if (
			target === "shared-browser" &&
			!sharedBrowserAvailable &&
			!awarenessIdRef.current
		)
			setTarget("focused");
	}, [sharedBrowserAvailable, target]);

	const selectedSources = useMemo<RecordingSourceInput[]>(() => {
		if (target === "shared-browser") {
			return props.sharedBrowserFrame
				? [
						{
							id: `shared-browser:${props.sharedBrowserFrame.sessionId}`,
							owner: { id: "shared-browser", name: "Shared Browser" },
							canvasSource: props.sharedBrowserFrame,
							status:
								props.sharedBrowserViewerState === "connected"
									? "active"
									: "reconnecting",
						},
					]
				: [];
		}
		return screenSources;
	}, [
		props.sharedBrowserFrame,
		props.sharedBrowserViewerState,
		screenSources,
		target,
	]);
	const audioAvailable =
		target !== "shared-browser" &&
		Boolean(runtimeSupport?.audioMixing) &&
		selectedSources.some((source) => (source.audioTracks?.length ?? 0) > 0);
	const effectiveAudio =
		target !== "shared-browser" && audioAvailable && includeAudio;
	const profile = useMemo(
		() => resolveRecordingProfile(resolution, fps),
		[fps, resolution],
	);
	const mimeSelection = useMemo(
		() =>
			runtimeSupport?.mediaRecorder && runtimeSupport.mimeProbe
				? selectRecordingMimeCapability({
						isTypeSupported: MediaRecorder.isTypeSupported.bind(MediaRecorder),
						includeAudio: effectiveAudio,
						preferSafariMp4: runtimeSupport.browserFamily === "safari-webkit",
					})
				: null,
		[effectiveAudio, runtimeSupport],
	);
	const recordingRuntime = useMemo(
		() =>
			runtimeSupport
				? withMimeRecordingRuntimeSupport(runtimeSupport, mimeSelection)
				: null,
		[mimeSelection, runtimeSupport],
	);
	const profileSupport = useMemo(
		() =>
			recordingRuntime
				? getRecordingProfileSupport(recordingRuntime, resolution, fps)
				: {
						supported: false,
						reason: null,
						message: "Checking local recording support…",
						source: "unsupported" as const,
					},
		[fps, recordingRuntime, resolution],
	);
	const mimeType = mimeSelection?.supported
		? mimeSelection.capability.mimeType
		: "";
	const filename = `ollashare-${props.roomCode}-${target}-${resolution}-${fps}fps`;
	const annotations = useMemo<LocalRecordingAnnotations>(() => {
		if (target === "shared-browser") {
			const sourceId = selectedSources[0]?.id;
			return sourceId
				? {
						[sourceId]: {
							committed: props.sharedBrowserAnnotations ?? [],
							draft: props.sharedBrowserAnnotationDraft ?? null,
						},
					}
				: {};
		}
		return buildRoomRecordingAnnotations(
			selectedSources.map((source) => source.id),
			props.screenAnnotations,
			props.screenAnnotationDrafts,
		);
	}, [
		props.screenAnnotationDrafts,
		props.screenAnnotations,
		props.sharedBrowserAnnotationDraft,
		props.sharedBrowserAnnotations,
		selectedSources,
		target,
	]);

	const finishBackend = useCallback(
		async (category?: string) => {
			const recordingId = awarenessIdRef.current;
			if (!recordingId || awarenessFinishedRef.current) return;
			awarenessFinishedRef.current = true;
			awarenessIdRef.current = null;
			if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
			heartbeatTimerRef.current = null;
			try {
				await finishAwareness({
					code: props.roomCode,
					recordingId,
					...(category ? { failureCategory: category } : {}),
				});
			} catch {
				// Backend finish is idempotent and the lease also expires fail-safe.
			}
		},
		[finishAwareness, props.roomCode],
	);

	const recording = useLocalRecording({
		recordingId: localRecordingId,
		createRecordingId: createLocalRecordingId,
		mimeType,
		profile,
		sources: selectedSources,
		layout: {
			mode: target === "grid" ? "grid" : "focused",
			focusedSourceId:
				target === "shared-browser"
					? selectedSources[0]?.id
					: props.focusedSourceId ?? selectedSources[0]?.id,
		},
		annotations,
		includeAudio: effectiveAudio,
		filename,
		enabled:
			LOCAL_RECORDING_ENABLED &&
			props.isHost &&
			props.joined &&
			props.roomLive &&
			Boolean(recordingRuntime?.supported) &&
			profileSupport.supported &&
			Boolean(mimeType) &&
			selectedSources.length > 0,
		onPrepared: async () => {
			if (!props.isHost || !props.roomLive)
				throw new Error("Recording awareness is unavailable");
			if (awarenessIdRef.current) return;
			const started = await startAwareness({
				code: props.roomCode,
				target,
				profile: {
					resolution: profile.resolution,
					fps: profile.fps,
					width: profile.width,
					height: profile.height,
					videoBitrateKbps: profile.bitrateKbps,
					audioIncluded: effectiveAudio,
				},
			});
			awarenessFinishedRef.current = false;
			awarenessIdRef.current = started.recordingId;
			heartbeatTimerRef.current = setInterval(() => {
				const recordingId = awarenessIdRef.current;
				if (!recordingId) return;
				void heartbeatAwareness({ code: props.roomCode, recordingId }).catch(
					() => {
						void recording.stop();
						void finishBackend("heartbeat_failure");
					},
				);
			}, 15_000);
		},
	});
	const recordingRef = useRef(recording);
	recordingRef.current = recording;

	useEffect(() => {
		if (recording.state === "failed") {
			void finishBackend(failureCategory(recording.error));
		} else if (recording.state === "ready") {
			void finishBackend();
		}
	}, [finishBackend, recording.error, recording.state]);
	useEffect(() => {
		if (target !== "shared-browser" || !awarenessIdRef.current) return;
		if (
			props.sharedBrowserViewerState === "disconnected" ||
			props.sharedBrowserViewerState === "failed"
		) {
			void recordingRef.current
				.stop()
				.then(() => finishBackend("source_ended"));
		}
	}, [finishBackend, props.sharedBrowserViewerState, target]);
	useEffect(
		() => () => {
			if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
			void recordingRef.current.cancel();
			void finishBackend("client_unmounted");
		},
		[finishBackend],
	);
	useEffect(() => {
		if (props.roomLive) return;
		void recordingRef.current.stop().then(() => finishBackend());
	}, [finishBackend, props.roomLive]);

	const pause = async () => {
		const recordingId = awarenessIdRef.current;
		if (!recordingId) return;
		await pauseAwareness({ code: props.roomCode, recordingId, paused: true });
		recording.pause();
	};
	const resume = async () => {
		const recordingId = awarenessIdRef.current;
		if (!recordingId) return;
		await pauseAwareness({ code: props.roomCode, recordingId, paused: false });
		recording.resume();
	};
	const stop = async () => {
		await recording.stop();
		await finishBackend();
	};
	const cancel = async () => {
		await recording.cancel();
		await finishBackend();
	};

	const isFpsSupported = useCallback(
		(nextFps: OfferedMediaFps) =>
			Boolean(
				recordingRuntime &&
					getRecordingProfileSupport(recordingRuntime, resolution, nextFps)
						.supported,
			),
		[recordingRuntime, resolution],
	);
	const sourceSummary =
		target === "shared-browser"
			? sharedBrowserAvailable
				? "Source: connected Shared Browser canvas"
				: "Source: Shared Browser unavailable"
			: `${selectedSources.length} screen source${selectedSources.length === 1 ? "" : "s"}`;
	const warning =
		recordingRuntime?.supported && selectedSources.length === 0
			? "No recordable source is available. Start or connect a screen source first."
			: target !== "shared-browser" &&
					selectedSources.every((source) => source.status === "ended")
				? "All selected screen sources ended. The recorder will stop after the source-ended grace slate."
				: target === "shared-browser" &&
						props.sharedBrowserViewerState !== "connected"
					? "Shared Browser is reconnecting. A short reconnect slate is recorded; termination or revocation stops recording."
					: null;

	return (
		<>
			<RecordingIndicator active={activeAwareness ?? null} />
			{LOCAL_RECORDING_ENABLED && (
				<>
					<RecordingControls
						isHost={props.isHost}
						compact={props.compact}
						portalTarget={props.controlsPortalTarget}
						sourceAvailable={
							Boolean(props.sourceAvailable) || sharedBrowserAvailable
						}
						target={target}
						onTargetChange={(next) => {
							setTarget(next);
							if (next === "shared-browser") setIncludeAudio(false);
						}}
						sharedBrowserAvailable={sharedBrowserAvailable}
						resolution={resolution}
						onResolutionChange={(nextResolution) => {
							setResolution(nextResolution);
							if (
								recordingRuntime &&
								!getRecordingProfileSupport(
									recordingRuntime,
									nextResolution,
									fps,
								).supported
							)
								setFps(30);
						}}
						allow360p={LOCAL_RECORDING_360P_ENABLED}
						fps={fps}
						onFpsChange={setFps}
						includeAudio={effectiveAudio}
						onIncludeAudioChange={setIncludeAudio}
						audioAvailable={audioAvailable}
						state={recording.state}
						durationMs={recording.durationMs}
						sizeBytes={recording.sizeBytes}
						mimeType={mimeType}
						sourceSummary={sourceSummary}
						warning={warning}
						error={errorMessage(recording.error)}
						recordingAvailable={Boolean(recordingRuntime?.supported)}
						profileSupported={profileSupport.supported}
						profileMessage={
							recordingRuntime?.supported ? profileSupport.message : null
						}
						unsupportedMessage={
							recordingRuntime?.message ??
							(runtimeSupport ? null : "Checking local recording support…")
						}
						isFpsSupported={isFpsSupported}
						onStart={() => setConsentOpen(true)}
						onPause={() => void pause()}
						onResume={() => void resume()}
						onStop={() => void stop()}
						onCancel={() => void cancel()}
						onDownload={() => void recording.download()}
					/>
					<RecordingConsentDialog
						open={consentOpen}
						portalTarget={props.controlsPortalTarget}
						target={target}
						includeAudio={effectiveAudio}
						audioAvailable={audioAvailable}
						onCancel={() => setConsentOpen(false)}
						onConfirm={() => {
							setConsentOpen(false);
							if (!recordingRuntime?.supported || !profileSupport.supported)
								return;
							void recording.start();
						}}
					/>
				</>
			)}
		</>
	);
}
