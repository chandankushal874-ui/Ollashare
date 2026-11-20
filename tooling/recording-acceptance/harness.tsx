import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSharedBrowserFrameHandle } from "../../apps/app/src/components/shared-browser/frame-source";
import type { AnnotationStroke } from "../../apps/app/src/lib/annotation-types";
import {
	getRecordingProfileSupport,
	probeRecordingRuntimeSupport,
} from "../../apps/app/src/lib/recording/capabilities";
import {
	BoundedChunkWriteQueue,
	IndexedDbRecordingChunkStore,
	MAX_BLOB_MATERIALIZATION_BYTES,
	type RecordingChunk,
	type RecordingChunkMetadata,
	type RecordingChunkStore,
	assertBlobMaterializationAllowed,
	calculateIndexedDbRecordingCap,
} from "../../apps/app/src/lib/recording/chunk-store";
import { sanitizeRecordingFilename } from "../../apps/app/src/lib/recording/download";
import type { RecordingSourceInput } from "../../apps/app/src/lib/recording/source-registry";
import { useLocalRecording } from "../../apps/app/src/lib/recording/use-local-recording";

type LayoutMode = "focused" | "grid";
type SourceMode = "track" | "canvas";
type StoreMode = "indexeddb" | "quota-failure";

interface HarnessConfiguration {
	width: number;
	height: number;
	fps: 25 | 30 | 60;
	includeAudio: boolean;
	layout: LayoutMode;
	sourceMode: SourceMode;
	storeMode: StoreMode;
	sourceCount: number;
	allSourcesEndedGraceMs: number;
	mimeType: string;
}

interface SyntheticSource {
	input: RecordingSourceInput;
	canvas: HTMLCanvasElement;
	stream: MediaStream | null;
	audioContext: AudioContext | null;
	oscillator: OscillatorNode | null;
	animation: number;
	dispose(): Promise<void>;
}

interface HarnessSnapshot {
	state: string;
	recordingId: string;
	mimeType: string;
	durationMs: number;
	sizeBytes: number;
	chunkCount: number;
	error: string | null;
}

interface HarnessDownload {
	state: HarnessSnapshot;
	bytes: number;
	base64: string;
	filename: string;
	metadataBefore: RecordingChunkMetadata | null;
	metadataAfter: RecordingChunkMetadata | null;
}

interface HarnessApi {
	capabilities(): {
		mediaRecorder: boolean;
		indexedDb: boolean;
		canvasCapture: boolean;
		audioContext: boolean;
		supportedMimes: string[];
		runtime: ReturnType<typeof probeRecordingRuntimeSupport>;
	};
	profileSupport(
		width: number,
		height: number,
		fps: 25 | 30 | 60,
	): ReturnType<typeof getRecordingProfileSupport>;
	configure(next: Partial<HarnessConfiguration>): Promise<HarnessConfiguration>;
	start(): Promise<HarnessSnapshot>;
	pause(): HarnessSnapshot;
	resume(): HarnessSnapshot;
	stop(): Promise<HarnessSnapshot>;
	cancel(): Promise<HarnessSnapshot>;
	download(): Promise<HarnessDownload>;
	replaceSource(index?: number): Promise<void>;
	setAllSourceStatuses(
		status: "active" | "reconnecting" | "ended",
	): Promise<void>;
	inspect(): Promise<{
		configuration: HarnessConfiguration;
		snapshot: HarnessSnapshot;
		metadata: RecordingChunkMetadata | null;
		knownMetadata: Record<string, RecordingChunkMetadata | null>;
		chunkIndexes: number[];
		chunkSizes: number[];
		canvas: {
			width: number;
			height: number;
			coloredPixels: number;
			annotationPixels: number;
			badgePixels: number;
			distinctRegionColors: number;
		} | null;
		originalTracks: { kind: string; readyState: string }[];
		resourceMetrics: ResourceMetrics;
	}>;
	validateFrameSources(): Promise<{
		sameOrigin: boolean;
		crossOriginRejected: boolean;
		dimensions: { width: number; height: number } | null;
	}>;
	simulateLimits(): Promise<{
		materializationBlocked: boolean;
		calculatedCap: number;
		backpressureBlocked: boolean;
	}>;
	dispatchPageHide(): Promise<void>;
	unmount(): Promise<ResourceMetrics>;
	reset(): Promise<void>;
}

declare global {
	interface Window {
		recordingHarness: HarnessApi;
		__recordingResourceMetrics?: ResourceMetrics;
		__recordingCompositorCanvas?: HTMLCanvasElement;
	}
}

interface ResourceMetrics {
	clonesCreated: number;
	cloneStops: number;
	capturedTracks: number;
	capturedTrackStops: number;
	audioContextsCreated: number;
	audioContextsClosed: number;
	compositorFrames: number;
}

const DEFAULT_CONFIGURATION: HarnessConfiguration = {
	width: 1280,
	height: 720,
	fps: 30,
	includeAudio: false,
	layout: "focused",
	sourceMode: "canvas",
	storeMode: "indexeddb",
	sourceCount: 1,
	allSourcesEndedGraceMs: 350,
	mimeType: "video/webm;codecs=vp9,opus",
};

const annotations: Record<string, { committed: readonly AnnotationStroke[] }> =
	{
		"synthetic-0": {
			committed: [
				{
					id: "acceptance-highlighter",
					authorId: "host",
					authorName: "Host",
					targetType: "screen",
					targetId: "synthetic-0",
					color: "#ff00ff",
					width: 12,
					tool: "highlighter",
					opacity: 0.35,
					points: [
						{ u: 0.12, v: 0.18 },
						{ u: 0.48, v: 0.52 },
						{ u: 0.88, v: 0.22 },
					],
					createdAt: 1,
				},
			],
		},
	};

function installResourceInstrumentation(): ResourceMetrics {
	if (window.__recordingResourceMetrics)
		return window.__recordingResourceMetrics;
	const metrics: ResourceMetrics = {
		clonesCreated: 0,
		cloneStops: 0,
		capturedTracks: 0,
		capturedTrackStops: 0,
		audioContextsCreated: 0,
		audioContextsClosed: 0,
		compositorFrames: 0,
	};
	window.__recordingResourceMetrics = metrics;

	const trackPrototype = globalThis.MediaStreamTrack?.prototype;
	if (trackPrototype) {
		const originalClone = trackPrototype.clone;
		trackPrototype.clone = function cloneInstrumented() {
			const clone = originalClone.call(this);
			metrics.clonesCreated += 1;
			const originalStop = clone.stop.bind(clone);
			let stopped = false;
			clone.stop = () => {
				if (!stopped) metrics.cloneStops += 1;
				stopped = true;
				originalStop();
			};
			return clone;
		};
	}

	const canvasPrototype = HTMLCanvasElement.prototype;
	const originalCapture = canvasPrototype.captureStream;
	if (typeof originalCapture === "function") {
		canvasPrototype.captureStream = function captureStreamInstrumented(
			frameRate?: number,
		) {
			if (!this.dataset.syntheticSource) {
				window.__recordingCompositorCanvas = this;
			}
			const stream = originalCapture.call(this, frameRate);
			for (const track of stream.getTracks()) {
				metrics.capturedTracks += 1;
				const originalStop = track.stop.bind(track);
				let stopped = false;
				track.stop = () => {
					if (!stopped) metrics.capturedTrackStops += 1;
					stopped = true;
					originalStop();
				};
			}
			return stream;
		};
	}

	const contextPrototype = CanvasRenderingContext2D.prototype;
	const originalFillRect = contextPrototype.fillRect;
	contextPrototype.fillRect = function fillRectInstrumented(
		x: number,
		y: number,
		width: number,
		height: number,
	) {
		if (
			x === 0 &&
			y === 0 &&
			width === this.canvas.width &&
			height === this.canvas.height &&
			!this.canvas.dataset.syntheticSource
		) {
			metrics.compositorFrames += 1;
		}
		return originalFillRect.call(this, x, y, width, height);
	};

	const AudioContextConstructor = globalThis.AudioContext;
	if (AudioContextConstructor) {
		const originalClose = AudioContextConstructor.prototype.close;
		const originalCreateDestination =
			AudioContextConstructor.prototype.createMediaStreamDestination;
		AudioContextConstructor.prototype.createMediaStreamDestination =
			function createDestinationInstrumented() {
				metrics.audioContextsCreated += 1;
				return originalCreateDestination.call(this);
			};
		AudioContextConstructor.prototype.close = function closeInstrumented() {
			metrics.audioContextsClosed += 1;
			return originalClose.call(this);
		};
	}
	return metrics;
}

function drawSyntheticFrame(
	canvas: HTMLCanvasElement,
	context: CanvasRenderingContext2D,
	index: number,
	startedAt: number,
): void {
	const elapsed = (performance.now() - startedAt) / 1000;
	const phase = (elapsed * 0.35 + index * 0.21) % 1;
	context.fillStyle = index % 2 === 0 ? "#0b4f6c" : "#4c1d95";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = "#22d3ee";
	context.fillRect(
		phase * canvas.width - 80,
		canvas.height * 0.18,
		160,
		canvas.height * 0.28,
	);
	context.fillStyle = "#f97316";
	context.beginPath();
	context.arc(
		canvas.width * (1 - phase),
		canvas.height * 0.65,
		Math.max(20, canvas.height * 0.09),
		0,
		Math.PI * 2,
	);
	context.fill();
	context.fillStyle = "#ffffff";
	context.font = `700 ${Math.max(18, Math.round(canvas.height * 0.08))}px sans-serif`;
	context.fillText(
		`SOURCE ${index + 1}`,
		canvas.width * 0.08,
		canvas.height * 0.9,
	);
	context.fillStyle = index % 2 === 0 ? "#22d3ee" : "#facc15";
	context.fillRect(0, 0, 24, 24);
}

async function createSyntheticSource(
	index: number,
	configuration: HarnessConfiguration,
): Promise<SyntheticSource> {
	const canvas = document.createElement("canvas");
	canvas.width = 640;
	canvas.height = 360;
	canvas.dataset.syntheticSource = String(index);
	canvas.style.position = "fixed";
	canvas.style.left = "-10000px";
	document.body.appendChild(canvas);
	const context = canvas.getContext("2d", { alpha: false });
	if (!context) throw new Error("Synthetic canvas 2D context unavailable");
	const startedAt = performance.now();
	let animation = 0;
	const render = () => {
		drawSyntheticFrame(canvas, context, index, startedAt);
		animation = requestAnimationFrame(render);
	};
	render();

	let stream: MediaStream | null = null;
	let audioContext: AudioContext | null = null;
	let oscillator: OscillatorNode | null = null;
	let input: RecordingSourceInput;
	if (configuration.sourceMode === "canvas") {
		input = {
			id: `synthetic-${index}`,
			owner: {
				id: `owner-${index}`,
				name: index === 0 ? "noVNC Same Origin" : `Canvas ${index + 1}`,
			},
			canvasSource: {
				getCanvas: () => canvas,
				getDimensions: () => ({ width: canvas.width, height: canvas.height }),
			},
			status: "active",
		};
	} else {
		stream = canvas.captureStream(configuration.fps);
		const audioTracks: MediaStreamTrack[] = [];
		if (configuration.includeAudio) {
			audioContext = new AudioContext();
			await audioContext.resume();
			const destination = audioContext.createMediaStreamDestination();
			oscillator = audioContext.createOscillator();
			const gain = audioContext.createGain();
			oscillator.frequency.value = 440 + index * 110;
			gain.gain.value = 0.12;
			oscillator.connect(gain);
			gain.connect(destination);
			oscillator.start();
			audioTracks.push(...destination.stream.getAudioTracks());
		}
		input = {
			id: `synthetic-${index}`,
			owner: { id: `owner-${index}`, name: `Synthetic ${index + 1}` },
			videoTrack: stream.getVideoTracks()[0],
			audioTracks,
			status: "active",
		};
	}

	return {
		input,
		canvas,
		stream,
		audioContext,
		oscillator,
		animation,
		async dispose() {
			cancelAnimationFrame(animation);
			for (const track of stream?.getTracks() ?? []) track.stop();
			try {
				oscillator?.stop();
			} catch {
				// Oscillator may already be stopped during teardown.
			}
			if (audioContext && audioContext.state !== "closed")
				await audioContext.close();
			canvas.remove();
		},
	};
}

class QuotaFailureStore implements RecordingChunkStore {
	constructor(private readonly delegate: RecordingChunkStore) {}
	initialize(metadata: RecordingChunkMetadata): Promise<void> {
		return this.delegate.initialize(metadata);
	}
	append(): Promise<void> {
		return Promise.reject(
			new DOMException("Synthetic quota exceeded", "QuotaExceededError"),
		);
	}
	finalize(
		recordingId: string,
		status?: RecordingChunkMetadata["status"],
	): Promise<void> {
		return this.delegate.finalize(recordingId, status);
	}
	getMetadata(recordingId: string): Promise<RecordingChunkMetadata | null> {
		return this.delegate.getMetadata(recordingId);
	}
	iterate(recordingId: string): AsyncIterable<RecordingChunk> {
		return this.delegate.iterate(recordingId);
	}
	delete(recordingId: string): Promise<void> {
		return this.delegate.delete(recordingId);
	}
}

function snapshotValue(
	recording: ReturnType<typeof useLocalRecording>,
): HarnessSnapshot {
	return {
		state: recording.state,
		recordingId: recording.recordingId,
		mimeType: recording.mimeType,
		durationMs: recording.durationMs,
		sizeBytes: recording.sizeBytes,
		chunkCount: recording.chunkCount,
		error: recording.error?.message ?? null,
	};
}

function bytesToBase64(chunks: readonly Uint8Array[]): string {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let binary = "";
	const step = 0x8000;
	for (let index = 0; index < merged.length; index += step) {
		binary += String.fromCharCode(...merged.subarray(index, index + step));
	}
	return btoa(binary);
}

function nextPaint(): Promise<void> {
	return new Promise((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);
}

function requireRecording(
	ref: React.MutableRefObject<ReturnType<typeof useLocalRecording> | null>,
): ReturnType<typeof useLocalRecording> {
	const recording = ref.current;
	if (!recording) throw new Error("Recording harness is not mounted");
	return recording;
}

function Harness() {
	const [configuration, setConfiguration] = useState(DEFAULT_CONFIGURATION);
	const [sources, setSources] = useState<SyntheticSource[]>([]);
	const sourcesRef = useRef<SyntheticSource[]>([]);
	const sourcesReadyRef = useRef<Promise<void>>(Promise.resolve());
	const storesRef = useRef(new Map<string, RecordingChunkStore>());
	const activeStoreRef = useRef<RecordingChunkStore | null>(null);
	const recordingRef = useRef<ReturnType<typeof useLocalRecording> | null>(
		null,
	);
	const resourceMetrics = useMemo(() => installResourceInstrumentation(), []);
	const runtimeSupport = useMemo(() => probeRecordingRuntimeSupport(), []);

	useEffect(() => {
		let disposed = false;
		let resolveReady: () => void = () => undefined;
		const sourceConfiguration: HarnessConfiguration = {
			...DEFAULT_CONFIGURATION,
			fps: configuration.fps,
			includeAudio: configuration.includeAudio,
			sourceCount: configuration.sourceCount,
			sourceMode: configuration.sourceMode,
		};
		sourcesReadyRef.current = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		void (async () => {
			try {
				const created = await Promise.all(
					Array.from({ length: sourceConfiguration.sourceCount }, (_, index) =>
						createSyntheticSource(index, sourceConfiguration),
					),
				);
				if (disposed) {
					await Promise.all(created.map((source) => source.dispose()));
					return;
				}
				const previous = sourcesRef.current;
				sourcesRef.current = created;
				setSources(created);
				await Promise.all(previous.map((source) => source.dispose()));
			} finally {
				resolveReady();
			}
		})();
		return () => {
			disposed = true;
			resolveReady();
		};
	}, [
		configuration.fps,
		configuration.includeAudio,
		configuration.sourceCount,
		configuration.sourceMode,
	]);

	useEffect(
		() => () => {
			void Promise.all(sourcesRef.current.map((source) => source.dispose()));
		},
		[],
	);

	const createStore = useCallback((): RecordingChunkStore => {
		const indexedDbStore = new IndexedDbRecordingChunkStore(
			indexedDB,
			"mira-recording-acceptance-v1",
		);
		const store =
			configuration.storeMode === "quota-failure"
				? new QuotaFailureStore(indexedDbStore)
				: indexedDbStore;
		activeStoreRef.current = store;
		return store;
	}, [configuration.storeMode]);

	const recording = useLocalRecording({
		recordingId: "acceptance-recording",
		createRecordingId: () => `acceptance-${Date.now()}-${crypto.randomUUID()}`,
		mimeType: configuration.mimeType,
		profile: {
			width: configuration.width,
			height: configuration.height,
			fps: configuration.fps,
			bitrateKbps:
				configuration.height >= 1080
					? configuration.fps === 60
						? 12_000
						: 8_000
					: configuration.height >= 720
						? configuration.fps === 60
							? 7_000
							: 4_500
						: 2_000,
		},
		sources: sources.map((source) => source.input),
		layout: {
			mode: configuration.layout,
			focusedSourceId: sources[0]?.input.id,
		},
		annotations,
		includeAudio:
			configuration.sourceMode === "track" && configuration.includeAudio,
		filename: `Ollashare acceptance ${configuration.width}x${configuration.height} ${configuration.fps}fps`,
		createStore,
		allSourcesEndedGraceMs: configuration.allSourcesEndedGraceMs,
		enabled: sources.length > 0 && Boolean(configuration.mimeType),
	});
	recordingRef.current = recording;

	useEffect(() => {
		const currentStore = activeStoreRef.current;
		if (currentStore && recording.recordingId) {
			storesRef.current.set(recording.recordingId, currentStore);
		}
	}, [recording.recordingId]);

	useEffect(() => {
		const api: HarnessApi = {
			capabilities: () => {
				const candidates = [
					"video/webm;codecs=vp9,opus",
					"video/webm;codecs=vp8,opus",
					"video/webm;codecs=vp9",
					"video/webm;codecs=vp8",
					"video/mp4;codecs=avc1.42E01E,mp4a.40.2",
					"video/mp4",
				];
				return {
					mediaRecorder: typeof MediaRecorder !== "undefined",
					indexedDb: typeof indexedDB !== "undefined",
					canvasCapture:
						typeof HTMLCanvasElement.prototype.captureStream === "function",
					audioContext: typeof AudioContext !== "undefined",
					supportedMimes:
						typeof MediaRecorder === "undefined"
							? []
							: candidates.filter((mime) =>
									MediaRecorder.isTypeSupported(mime),
								),
					runtime: runtimeSupport,
				};
			},
			profileSupport: (width, height, fps) => {
				const resolution =
					width === 640 && height === 360
						? "360p"
						: width === 1280 && height === 720
							? "720p"
							: "1080p";
				return getRecordingProfileSupport(runtimeSupport, resolution, fps);
			},
			configure: async (next) => {
				const currentState = recordingRef.current?.state;
				if (
					[
						"preparing",
						"recording",
						"paused",
						"stopping",
						"downloading",
					].includes(currentState ?? "")
				) {
					throw new Error("Cannot reconfigure while recording is active");
				}
				let resolved = configuration;
				setConfiguration((current) => {
					resolved = { ...current, ...next };
					return resolved;
				});
				await nextPaint();
				await sourcesReadyRef.current;
				await nextPaint();
				return resolved;
			},
			start: async () => {
				await sourcesReadyRef.current;
				await requireRecording(recordingRef).start();
				await nextPaint();
				const current = requireRecording(recordingRef);
				if (activeStoreRef.current && current.recordingId) {
					storesRef.current.set(current.recordingId, activeStoreRef.current);
				}
				return snapshotValue(current);
			},
			pause: () => {
				const current = requireRecording(recordingRef);
				current.pause();
				return snapshotValue(current);
			},
			resume: () => {
				const current = requireRecording(recordingRef);
				current.resume();
				return snapshotValue(current);
			},
			stop: async () => {
				await requireRecording(recordingRef).stop();
				await nextPaint();
				return snapshotValue(requireRecording(recordingRef));
			},
			cancel: async () => {
				await requireRecording(recordingRef).cancel();
				await nextPaint();
				return snapshotValue(requireRecording(recordingRef));
			},
			download: async () => {
				const current = requireRecording(recordingRef);
				const recordingId = current.recordingId;
				const store =
					storesRef.current.get(recordingId) ?? activeStoreRef.current;
				const metadataBefore = store
					? await store.getMetadata(recordingId)
					: null;
				const chunks: Uint8Array[] = [];
				await current.download({
					write: async (chunk) => {
						chunks.push(chunk.slice());
					},
					close: async () => undefined,
					abort: async () => undefined,
				});
				await nextPaint();
				const metadataAfter = store
					? await store.getMetadata(recordingId)
					: null;
				return {
					state: snapshotValue(requireRecording(recordingRef)),
					bytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
					base64: bytesToBase64(chunks),
					filename: sanitizeRecordingFilename(
						`Ollashare acceptance ${configuration.width}x${configuration.height} ${configuration.fps}fps`,
						current.mimeType,
					),
					metadataBefore,
					metadataAfter,
				};
			},
			replaceSource: async (index = 0) => {
				const replacement = await createSyntheticSource(index, configuration);
				const previous = sourcesRef.current[index];
				const next = [...sourcesRef.current];
				next[index] = replacement;
				sourcesRef.current = next;
				setSources(next);
				await nextPaint();
				if (previous) await previous.dispose();
			},
			setAllSourceStatuses: async (status) => {
				const next = sourcesRef.current.map((source) => ({
					...source,
					input: { ...source.input, status },
				}));
				sourcesRef.current = next;
				setSources(next);
				await nextPaint();
			},
			inspect: async () => {
				const current = requireRecording(recordingRef);
				const store =
					storesRef.current.get(current.recordingId) ?? activeStoreRef.current;
				const metadata = store
					? await store.getMetadata(current.recordingId)
					: null;
				const knownMetadata: Record<string, RecordingChunkMetadata | null> = {};
				for (const [recordingId, knownStore] of storesRef.current) {
					knownMetadata[recordingId] =
						await knownStore.getMetadata(recordingId);
				}
				const chunkIndexes: number[] = [];
				const chunkSizes: number[] = [];
				if (store) {
					for await (const chunk of store.iterate(current.recordingId)) {
						chunkIndexes.push(chunk.index);
						chunkSizes.push(chunk.size);
					}
				}
				const candidateCanvas = window.__recordingCompositorCanvas;
				const compositorCanvas =
					candidateCanvas?.width === configuration.width &&
					candidateCanvas.height === configuration.height
						? candidateCanvas
						: undefined;
				let canvas: {
					width: number;
					height: number;
					coloredPixels: number;
					annotationPixels: number;
					badgePixels: number;
					distinctRegionColors: number;
				} | null = null;
				if (compositorCanvas) {
					const context = compositorCanvas.getContext("2d", {
						willReadFrequently: true,
					});
					if (context) {
						const stepX = Math.max(1, Math.floor(compositorCanvas.width / 320));
						const stepY = Math.max(
							1,
							Math.floor(compositorCanvas.height / 180),
						);
						let coloredPixels = 0;
						let annotationPixels = 0;
						let badgePixels = 0;
						for (let y = 0; y < compositorCanvas.height; y += stepY) {
							for (let x = 0; x < compositorCanvas.width; x += stepX) {
								const pixel = context.getImageData(x, y, 1, 1).data;
								if ((pixel[0] ?? 0) + (pixel[1] ?? 0) + (pixel[2] ?? 0) > 90)
									coloredPixels += 1;
								if (
									(pixel[0] ?? 0) > (pixel[1] ?? 0) * 1.15 &&
									(pixel[2] ?? 0) > (pixel[1] ?? 0) * 1.15 &&
									(pixel[0] ?? 0) + (pixel[2] ?? 0) > 150
								) {
									annotationPixels += 1;
								}
								if (
									y > compositorCanvas.height * 0.78 &&
									(pixel[0] ?? 255) < 35 &&
									(pixel[1] ?? 255) < 45 &&
									(pixel[2] ?? 255) < 70
								) {
									badgePixels += 1;
								}
							}
						}
						const badgePixel = context.getImageData(
							Math.min(16, compositorCanvas.width - 1),
							Math.max(0, compositorCanvas.height - 18),
							1,
							1,
						).data;
						if (
							(badgePixel[0] ?? 255) < 90 &&
							(badgePixel[1] ?? 255) < 110 &&
							(badgePixel[2] ?? 255) < 140
						) {
							badgePixels += 1;
						}
						const regionColors = [0.005, 0.505].map((fraction) => {
							const pixel = context.getImageData(
								Math.floor(compositorCanvas.width * fraction),
								Math.floor(compositorCanvas.height * 0.26),
								1,
								1,
							).data;
							return `${Math.round((pixel[0] ?? 0) / 24)}:${Math.round((pixel[1] ?? 0) / 24)}:${Math.round((pixel[2] ?? 0) / 24)}`;
						});
						canvas = {
							width: compositorCanvas.width,
							height: compositorCanvas.height,
							coloredPixels,
							annotationPixels,
							badgePixels,
							distinctRegionColors: new Set(regionColors).size,
						};
					}
				}
				return {
					configuration,
					snapshot: snapshotValue(current),
					metadata,
					knownMetadata,
					chunkIndexes,
					chunkSizes,
					canvas,
					originalTracks: sourcesRef.current.flatMap((source) =>
						[source.input.videoTrack, ...(source.input.audioTracks ?? [])]
							.filter((track): track is MediaStreamTrack => Boolean(track))
							.map((track) => ({
								kind: track.kind,
								readyState: track.readyState,
							})),
					),
					resourceMetrics: { ...resourceMetrics },
				};
			},
			validateFrameSources: async () => {
				const sessionId = "acceptance-session";
				const loadFrame = async (source: string) => {
					const iframe = document.createElement("iframe");
					iframe.src = source;
					iframe.style.position = "fixed";
					iframe.style.left = "-10000px";
					document.body.appendChild(iframe);
					await new Promise<void>((resolve, reject) => {
						iframe.addEventListener("load", () => resolve(), { once: true });
						iframe.addEventListener(
							"error",
							() => reject(new Error("Frame load failed")),
							{ once: true },
						);
					});
					return iframe;
				};
				const sameOriginFrame = await loadFrame(`/frame?session=${sessionId}`);
				const sameOriginHandle = createSharedBrowserFrameHandle({
					iframe: sameOriginFrame,
					sessionId,
					connectionState: "connected",
				});
				const crossOriginFrame = await loadFrame(
					`${location.protocol}//localhost:${location.port}/frame?session=${sessionId}`,
				);
				const crossOriginHandle = createSharedBrowserFrameHandle({
					iframe: crossOriginFrame,
					sessionId,
					connectionState: "connected",
				});
				const result = {
					sameOrigin: Boolean(sameOriginHandle?.getCanvas()),
					crossOriginRejected: crossOriginHandle === null,
					dimensions: sameOriginHandle?.getDimensions() ?? null,
				};
				sameOriginFrame.remove();
				crossOriginFrame.remove();
				return result;
			},
			simulateLimits: async () => {
				let materializationBlocked = false;
				try {
					assertBlobMaterializationAllowed(MAX_BLOB_MATERIALIZATION_BYTES + 1);
				} catch {
					materializationBlocked = true;
				}
				let releaseAppend: () => void = () => undefined;
				const delayedStore: RecordingChunkStore = {
					initialize: async () => undefined,
					append: async () =>
						new Promise<void>((resolve) => {
							releaseAppend = resolve;
						}),
					finalize: async () => undefined,
					getMetadata: async () => null,
					async *iterate() {},
					delete: async () => undefined,
				};
				const queue = new BoundedChunkWriteQueue(delayedStore, 4);
				const first = queue.enqueue("simulated", {
					index: 0,
					blob: new Blob(["1234"]),
					size: 4,
					createdAt: 1,
				});
				let backpressureBlocked = false;
				try {
					await queue.enqueue("simulated", {
						index: 1,
						blob: new Blob(["1"]),
						size: 1,
						createdAt: 2,
					});
				} catch {
					backpressureBlocked = true;
				}
				releaseAppend();
				await first;
				return {
					materializationBlocked,
					calculatedCap: calculateIndexedDbRecordingCap({
						quota: 1_000_000,
						usage: 100_000,
					}),
					backpressureBlocked,
				};
			},
			dispatchPageHide: async () => {
				window.dispatchEvent(new PageTransitionEvent("pagehide"));
				await new Promise((resolve) => setTimeout(resolve, 100));
			},
			unmount: async () => {
				rootHandle.unmount();
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { ...resourceMetrics };
			},
			reset: async () => {
				await recordingRef.current?.cancel();
				for (const [recordingId, store] of storesRef.current)
					await store.delete(recordingId);
				storesRef.current.clear();
			},
		};
		window.recordingHarness = api;
		document.body.dataset.harnessReady = "true";
	}, [configuration, resourceMetrics, runtimeSupport]);

	return (
		<main>
			<h1>Ollashare recording acceptance</h1>
			<output data-testid="recording-state">{recording.state}</output>
			<output data-testid="recording-id">{recording.recordingId}</output>
			<output data-testid="local-recording-support">
				{runtimeSupport.supported
					? "Local recording supported"
					: runtimeSupport.message}
			</output>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Recording harness root is missing");
const rootHandle = createRoot(root);
rootHandle.render(<Harness />);
