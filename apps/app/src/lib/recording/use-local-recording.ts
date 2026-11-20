"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationStroke } from "../annotation-types";
import type { ResolvedRecordingProfile } from "../media-profiles";
import { renderAnnotations } from "./annotation-renderer";
import { RecordingAudioMixer } from "./audio-mixer";
import {
	CanvasCompositor,
	type RecordingLayoutInput,
} from "./canvas-compositor";
import {
	IndexedDbRecordingChunkStore,
	type RecordingChunkStore,
	type RecordingStreamWriter,
} from "./chunk-store";
import {
	LocalRecordingController,
	type LocalRecordingSnapshot,
} from "./controller";
import {
	type RecordingSourceInput,
	RecordingSourceRegistry,
} from "./source-registry";

export interface LocalRecordingAnnotations {
	[sourceId: string]: {
		committed: readonly AnnotationStroke[];
		draft?: AnnotationStroke | null;
	};
}

export interface UseLocalRecordingOptions {
	recordingId: string;
	mimeType: string;
	profile: Pick<
		ResolvedRecordingProfile,
		"width" | "height" | "fps" | "bitrateKbps"
	>;
	sources: readonly RecordingSourceInput[];
	layout?: RecordingLayoutInput;
	annotations?: LocalRecordingAnnotations;
	includeAudio?: boolean;
	audioBitsPerSecond?: number;
	filename?: string;
	store?: RecordingChunkStore;
	createStore?: () => RecordingChunkStore;
	createRecordingId?: () => string;
	allSourcesEndedGraceMs?: number;
	enabled?: boolean;
	onPrepared?: () => Promise<void> | void;
}

interface ActiveLocalRecordingEngine {
	registry: RecordingSourceRegistry;
	compositor: CanvasCompositor;
	mixer: RecordingAudioMixer;
	controller: LocalRecordingController;
	unsubscribeRegistry: () => void;
	unsubscribeController: () => void;
	releasePromise: Promise<void> | null;
}

const INITIAL_SNAPSHOT: LocalRecordingSnapshot = {
	state: "idle",
	recordingId: "",
	mimeType: "",
	durationMs: 0,
	sizeBytes: 0,
	chunkCount: 0,
	error: null,
};

/** Headless React integration for the local recording engine; no page UI is rendered. */
export function useLocalRecording(options: UseLocalRecordingOptions) {
	const [snapshot, setSnapshot] = useState<LocalRecordingSnapshot>({
		...INITIAL_SNAPSHOT,
		recordingId: options.recordingId,
		mimeType: options.mimeType,
	});
	const engineRef = useRef<ActiveLocalRecordingEngine | null>(null);
	const startOperationRef = useRef<Promise<LocalRecordingSnapshot> | null>(
		null,
	);
	const recordingSequenceRef = useRef(0);
	const snapshotRef = useRef(snapshot);
	const sourcesRef = useRef(options.sources);
	const annotationsRef = useRef(options.annotations);
	const layoutRef = useRef(options.layout);
	snapshotRef.current = snapshot;
	sourcesRef.current = options.sources;
	annotationsRef.current = options.annotations;
	layoutRef.current = options.layout;

	const releaseEngineResources = useCallback(
		(engine: ActiveLocalRecordingEngine): Promise<void> => {
			if (engine.releasePromise) return engine.releasePromise;
			engine.releasePromise = (async () => {
				engine.unsubscribeRegistry();
				engine.compositor.close();
				engine.registry.close();
				await engine.mixer.close();
			})();
			return engine.releasePromise;
		},
		[],
	);

	const disposeEngine = useCallback(
		async (engine: ActiveLocalRecordingEngine, cancel: boolean) => {
			if (engineRef.current === engine) engineRef.current = null;
			if (cancel) await engine.controller.cancel();
			engine.unsubscribeController();
			await releaseEngineResources(engine);
		},
		[releaseEngineResources],
	);

	const start = useCallback(() => {
		if (startOperationRef.current) return startOperationRef.current;
		const operation = (async (): Promise<LocalRecordingSnapshot> => {
			if (options.enabled === false) return snapshotRef.current;
			const previous = engineRef.current;
			if (previous) {
				const previousState = previous.controller.snapshot.state;
				if (!["completed", "cancelled", "failed"].includes(previousState)) {
					return previous.controller.start();
				}
				await disposeEngine(previous, previousState === "failed");
			}

			const sequence = recordingSequenceRef.current++;
			const recordingId =
				options.createRecordingId?.() ??
				(sequence === 0
					? options.recordingId
					: `${options.recordingId}-${Date.now()}-${sequence}`);
			setSnapshot({
				...INITIAL_SNAPSHOT,
				recordingId,
				mimeType: options.mimeType,
			});

			const registry = new RecordingSourceRegistry();
			const mixer = new RecordingAudioMixer();
			let compositor: CanvasCompositor | null = null;
			try {
				for (const source of sourcesRef.current) registry.add(source);
				if (options.includeAudio !== false) {
					await mixer.initializeFromUserGesture();
					for (const source of sourcesRef.current) {
						for (const track of source.audioTracks ?? []) {
							await mixer.add({ sourceId: source.id, track });
						}
					}
				}
				compositor = new CanvasCompositor({
					profile: options.profile,
					layout: layoutRef.current,
					onFrame: (context, frames) => {
						const annotations = annotationsRef.current;
						if (!annotations) return;
						for (const frame of frames) {
							const sourceAnnotations = annotations[frame.source.id];
							if (sourceAnnotations) {
								renderAnnotations(context, sourceAnnotations, frame.imageRect);
							}
						}
					},
				});
				const activeCompositor = compositor;
				activeCompositor.setSources(registry.list());
				const store =
					options.createStore?.() ??
					options.store ??
					new IndexedDbRecordingChunkStore();
				const controller = new LocalRecordingController({
					recordingId,
					mimeType: options.mimeType,
					store,
					filename: options.filename,
					videoBitsPerSecond: options.profile.bitrateKbps * 1000,
					audioBitsPerSecond:
						options.includeAudio === false
							? undefined
							: options.audioBitsPerSecond ?? 128_000,
					allSourcesEndedGraceMs: options.allSourcesEndedGraceMs,
					prepareStream: async () => {
						activeCompositor.start();
						try {
							const canvasStream = activeCompositor.captureStream();
							const tracks = [...canvasStream.getVideoTracks()];
							if (options.includeAudio !== false) {
								tracks.push(...(mixer.stream?.getAudioTracks() ?? []));
							}
							const prepared = {
								stream: new MediaStream(tracks),
								cleanup: () => activeCompositor.stop(),
							};
							await options.onPrepared?.();
							return prepared;
						} catch (error) {
							activeCompositor.stop();
							throw error;
						}
					},
				});
				const unsubscribeRegistry = registry.subscribe(() => {
					const registeredSources = registry.list();
					activeCompositor.setSources(registeredSources);
					controller.setSourceStatuses(
						registeredSources.map((source) => source.status),
					);
				});
				const engineHolder: { current: ActiveLocalRecordingEngine | null } = {
					current: null,
				};
				const unsubscribeController = controller.subscribe((nextSnapshot) => {
					setSnapshot(nextSnapshot);
					const currentEngine = engineHolder.current;
					if (
						currentEngine &&
						["ready", "completed", "failed", "cancelled"].includes(
							nextSnapshot.state,
						)
					) {
						void releaseEngineResources(currentEngine);
					}
				});
				const engine: ActiveLocalRecordingEngine = {
					registry,
					compositor: activeCompositor,
					mixer,
					controller,
					unsubscribeRegistry,
					unsubscribeController,
					releasePromise: null,
				};
				engineHolder.current = engine;
				engineRef.current = engine;
				const started = await controller.start();
				controller.setSourceStatuses(
					registry.list().map((source) => source.status),
				);
				return started;
			} catch (error) {
				compositor?.close();
				registry.close();
				await mixer.close();
				const failed: LocalRecordingSnapshot = {
					...INITIAL_SNAPSHOT,
					state: "failed",
					recordingId,
					mimeType: options.mimeType,
					error: error instanceof Error ? error : new Error(String(error)),
				};
				setSnapshot(failed);
				return failed;
			}
		})();
		startOperationRef.current = operation;
		void operation.finally(() => {
			if (startOperationRef.current === operation)
				startOperationRef.current = null;
		});
		return operation;
	}, [
		disposeEngine,
		options.allSourcesEndedGraceMs,
		options.audioBitsPerSecond,
		options.createRecordingId,
		options.createStore,
		options.enabled,
		options.filename,
		options.includeAudio,
		options.mimeType,
		options.onPrepared,
		options.profile,
		options.recordingId,
		options.store,
		releaseEngineResources,
	]);

	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || engine.releasePromise) return;
		engine.compositor.setLayout(options.layout ?? { mode: "grid" });
	}, [options.layout]);

	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || engine.releasePromise) return;
		const previous = new Map(
			engine.registry.list().map((source) => [source.id, source] as const),
		);
		const next = new Map(
			options.sources.map((source) => [source.id, source] as const),
		);
		for (const sourceId of previous.keys()) {
			if (!next.has(sourceId)) {
				engine.registry.remove(sourceId);
				engine.mixer.removeSource(sourceId);
			}
		}
		for (const source of options.sources) {
			const current = previous.get(source.id);
			const sourceTrackIds = (source.audioTracks ?? [])
				.map((track) => track.id)
				.join("|");
			const currentTrackIds = current?.originalAudioTrackIds.join("|");
			if (!current) {
				engine.registry.add(source);
				if (options.includeAudio !== false) {
					void engine.mixer.replaceSource(source.id, source.audioTracks ?? []);
				}
			} else if (
				current.originalVideoTrackId !== (source.videoTrack?.id ?? null) ||
				current.canvasSource !== (source.canvasSource ?? null) ||
				currentTrackIds !== sourceTrackIds
			) {
				engine.registry.replace(source.id, source);
				if (options.includeAudio !== false) {
					void engine.mixer.replaceSource(source.id, source.audioTracks ?? []);
				}
			} else if (source.status && source.status !== current.status) {
				engine.registry.setStatus(source.id, source.status);
			}
		}
	}, [options.includeAudio, options.sources]);

	useEffect(() => {
		const handlePageHide = () => {
			const engine = engineRef.current;
			if (engine) void disposeEngine(engine, true);
		};
		window.addEventListener("pagehide", handlePageHide);
		return () => {
			window.removeEventListener("pagehide", handlePageHide);
			const engine = engineRef.current;
			if (engine) void disposeEngine(engine, true);
		};
	}, [disposeEngine]);

	return {
		...snapshot,
		start,
		pause: () => {
			const engine = engineRef.current;
			engine?.compositor.pause();
			return engine?.controller.pause() ?? snapshotRef.current;
		},
		resume: () => {
			const engine = engineRef.current;
			engine?.compositor.resume();
			return engine?.controller.resume() ?? snapshotRef.current;
		},
		stop: () =>
			engineRef.current?.controller.stop() ??
			Promise.resolve(snapshotRef.current),
		cancel: () =>
			engineRef.current?.controller.cancel() ??
			Promise.resolve(snapshotRef.current),
		download: (writer?: RecordingStreamWriter) =>
			engineRef.current?.controller.download(writer) ??
			Promise.resolve(snapshotRef.current),
	};
}
