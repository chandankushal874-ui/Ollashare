export type RecordingSourceStatus = "active" | "reconnecting" | "ended";

export interface RecordingSourceOwner {
	id: string;
	name: string;
	isLocal?: boolean;
}

export interface RecordingCanvasFrameSource {
	getCanvas(): HTMLCanvasElement | null;
	getDimensions(): { width: number; height: number } | null;
}

export interface RecordingSourceInput {
	id: string;
	owner: RecordingSourceOwner;
	videoTrack?: MediaStreamTrack;
	canvasSource?: RecordingCanvasFrameSource;
	audioTracks?: readonly MediaStreamTrack[];
	status?: RecordingSourceStatus;
}

export interface RecordingSourceSnapshot {
	id: string;
	owner: Readonly<RecordingSourceOwner>;
	status: RecordingSourceStatus;
	originalVideoTrackId: string | null;
	originalAudioTrackIds: readonly string[];
	videoTrack: MediaStreamTrack | null;
	audioTracks: readonly MediaStreamTrack[];
	videoElement: HTMLVideoElement | null;
	canvasSource: RecordingCanvasFrameSource | null;
	updatedAt: number;
}

export type RecordingSourceRegistryEvent =
	| { type: "added"; source: RecordingSourceSnapshot }
	| { type: "replaced"; source: RecordingSourceSnapshot }
	| { type: "status"; source: RecordingSourceSnapshot }
	| { type: "removed"; sourceId: string };

export interface RecordingSourceRegistryDependencies {
	createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
	createVideoElement?: () => HTMLVideoElement;
	now?: () => number;
}

interface RegisteredSource {
	id: string;
	owner: RecordingSourceOwner;
	status: RecordingSourceStatus;
	originalVideoTrack: MediaStreamTrack | null;
	originalAudioTracks: MediaStreamTrack[];
	videoTrack: MediaStreamTrack | null;
	audioTracks: MediaStreamTrack[];
	videoElement: HTMLVideoElement | null;
	canvasSource: RecordingCanvasFrameSource | null;
	updatedAt: number;
	removeEndedListener: () => void;
}

function defaultCreateVideoElement(): HTMLVideoElement {
	const video = document.createElement("video");
	video.muted = true;
	video.autoplay = true;
	video.playsInline = true;
	video.setAttribute("aria-hidden", "true");
	video.style.position = "fixed";
	video.style.width = "1px";
	video.style.height = "1px";
	video.style.opacity = "0";
	video.style.pointerEvents = "none";
	video.style.left = "-10000px";
	video.style.top = "-10000px";
	return video;
}

function cloneTrack(track: MediaStreamTrack): MediaStreamTrack {
	const clone = track.clone();
	clone.enabled = track.enabled;
	return clone;
}

/**
 * Owns recorder-only clones of screen-share tracks and hidden video sinks.
 * Original application sharing tracks are observed but are never stopped.
 */
export class RecordingSourceRegistry {
	private readonly sources = new Map<string, RegisteredSource>();
	private readonly listeners = new Set<
		(event: RecordingSourceRegistryEvent) => void
	>();
	private readonly createMediaStream: (
		tracks: MediaStreamTrack[],
	) => MediaStream;
	private readonly createVideoElement: () => HTMLVideoElement;
	private readonly now: () => number;
	private closed = false;

	constructor(dependencies: RecordingSourceRegistryDependencies = {}) {
		this.createMediaStream =
			dependencies.createMediaStream ?? ((tracks) => new MediaStream(tracks));
		this.createVideoElement =
			dependencies.createVideoElement ?? defaultCreateVideoElement;
		this.now = dependencies.now ?? Date.now;
	}

	subscribe(
		listener: (event: RecordingSourceRegistryEvent) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): RecordingSourceSnapshot[] {
		return Array.from(this.sources.values(), (source) => this.snapshot(source));
	}

	get(sourceId: string): RecordingSourceSnapshot | undefined {
		const source = this.sources.get(sourceId);
		return source ? this.snapshot(source) : undefined;
	}

	add(input: RecordingSourceInput): RecordingSourceSnapshot {
		this.assertOpen();
		if (this.sources.has(input.id)) return this.replace(input.id, input);
		const source = this.createRegisteredSource(input);
		this.sources.set(input.id, source);
		const snapshot = this.snapshot(source);
		this.emit({ type: "added", source: snapshot });
		return snapshot;
	}

	replace(
		sourceId: string,
		input: Omit<RecordingSourceInput, "id"> & { id?: string },
	): RecordingSourceSnapshot {
		this.assertOpen();
		const previous = this.sources.get(sourceId);
		const stableId = input.id ?? sourceId;
		if (stableId !== sourceId)
			throw new Error("A recording source id cannot change during replacement");
		const replacement = this.createRegisteredSource({ ...input, id: sourceId });
		this.sources.set(sourceId, replacement);
		if (previous) this.disposeRegisteredSource(previous);
		const snapshot = this.snapshot(replacement);
		this.emit({ type: previous ? "replaced" : "added", source: snapshot });
		return snapshot;
	}

	setStatus(
		sourceId: string,
		status: RecordingSourceStatus,
	): RecordingSourceSnapshot | undefined {
		const source = this.sources.get(sourceId);
		if (!source || source.status === status)
			return source ? this.snapshot(source) : undefined;
		source.status = status;
		source.updatedAt = this.now();
		const snapshot = this.snapshot(source);
		this.emit({ type: "status", source: snapshot });
		return snapshot;
	}

	remove(sourceId: string): boolean {
		const source = this.sources.get(sourceId);
		if (!source) return false;
		this.sources.delete(sourceId);
		this.disposeRegisteredSource(source);
		this.emit({ type: "removed", sourceId });
		return true;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const source of this.sources.values())
			this.disposeRegisteredSource(source);
		this.sources.clear();
		this.listeners.clear();
	}

	private createRegisteredSource(
		input: RecordingSourceInput,
	): RegisteredSource {
		if (Boolean(input.videoTrack) === Boolean(input.canvasSource)) {
			throw new Error(
				"Recording sources require exactly one video track or canvas source",
			);
		}
		if (input.videoTrack && input.videoTrack.kind !== "video")
			throw new Error("Recording track sources require a video track");
		if (input.canvasSource && (input.audioTracks?.length ?? 0) > 0)
			throw new Error("Canvas recording sources are video only");
		const originalAudioTracks = (input.audioTracks ?? []).filter(
			(track) => track.kind === "audio",
		);
		const videoTrack = input.videoTrack ? cloneTrack(input.videoTrack) : null;
		const audioTracks = originalAudioTracks.map(cloneTrack);
		const videoElement = videoTrack ? this.createVideoElement() : null;
		if (videoElement && videoTrack) {
			videoElement.muted = true;
			videoElement.autoplay = true;
			videoElement.playsInline = true;
			videoElement.srcObject = this.createMediaStream([videoTrack]);
			const playResult = videoElement.play?.();
			if (playResult && typeof playResult.catch === "function")
				playResult.catch(() => undefined);
		}

		const onEnded = () => this.setStatus(input.id, "ended");
		input.videoTrack?.addEventListener("ended", onEnded);
		return {
			id: input.id,
			owner: { ...input.owner },
			status:
				input.status ??
				(input.videoTrack?.readyState === "ended" ? "ended" : "active"),
			originalVideoTrack: input.videoTrack ?? null,
			originalAudioTracks,
			videoTrack,
			audioTracks,
			videoElement,
			canvasSource: input.canvasSource ?? null,
			updatedAt: this.now(),
			removeEndedListener: () =>
				input.videoTrack?.removeEventListener("ended", onEnded),
		};
	}

	private disposeRegisteredSource(source: RegisteredSource): void {
		source.removeEndedListener();
		for (const track of [source.videoTrack, ...source.audioTracks])
			track?.stop();
		try {
			source.videoElement?.pause?.();
			if (source.videoElement) source.videoElement.srcObject = null;
			source.videoElement?.remove?.();
		} catch {
			// Detached synthetic test elements and older browsers may reject sink cleanup.
		}
	}

	private snapshot(source: RegisteredSource): RecordingSourceSnapshot {
		return Object.freeze({
			id: source.id,
			owner: Object.freeze({ ...source.owner }),
			status: source.status,
			originalVideoTrackId: source.originalVideoTrack?.id ?? null,
			originalAudioTrackIds: Object.freeze(
				source.originalAudioTracks.map((track) => track.id),
			),
			videoTrack: source.videoTrack,
			audioTracks: Object.freeze([...source.audioTracks]),
			videoElement: source.videoElement,
			canvasSource: source.canvasSource,
			updatedAt: source.updatedAt,
		});
	}

	private emit(event: RecordingSourceRegistryEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Recording source registry is closed");
	}
}
