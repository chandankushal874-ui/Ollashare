import {
	BoundedChunkWriteQueue,
	MAX_RECORDING_DURATION_MS,
	type RecordingChunkStore,
	type RecordingStreamWriter,
} from "./chunk-store";
import { downloadRecording } from "./download";

export type LocalRecordingState =
	| "idle"
	| "preparing"
	| "recording"
	| "paused"
	| "stopping"
	| "ready"
	| "downloading"
	| "completed"
	| "failed"
	| "cancelled";

export interface LocalRecordingSnapshot {
	state: LocalRecordingState;
	recordingId: string;
	mimeType: string;
	durationMs: number;
	sizeBytes: number;
	chunkCount: number;
	error: Error | null;
}

export interface PreparedRecordingStream {
	stream: MediaStream;
	cleanup?: () => void | Promise<void>;
}

export interface LocalRecordingControllerOptions {
	recordingId: string;
	mimeType: string;
	store: RecordingChunkStore;
	prepareStream: () => Promise<PreparedRecordingStream>;
	filename?: string;
	videoBitsPerSecond?: number;
	audioBitsPerSecond?: number;
	timesliceMs?: number;
	maxDurationMs?: number;
	allSourcesEndedGraceMs?: number;
	createMediaRecorder?: (
		stream: MediaStream,
		options: MediaRecorderOptions,
	) => MediaRecorder;
	now?: () => number;
	setTimer?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	download?: typeof downloadRecording;
}

function errorFromEvent(event: Event): Error {
	const recorderEvent = event as Event & { error?: DOMException };
	return recorderEvent.error ?? new Error("MediaRecorder failed");
}

export class LocalRecordingController {
	private readonly listeners = new Set<
		(snapshot: LocalRecordingSnapshot) => void
	>();
	private readonly queue: BoundedChunkWriteQueue;
	private readonly now: () => number;
	private readonly setTimer: NonNullable<
		LocalRecordingControllerOptions["setTimer"]
	>;
	private readonly clearTimer: NonNullable<
		LocalRecordingControllerOptions["clearTimer"]
	>;
	private readonly createMediaRecorder: NonNullable<
		LocalRecordingControllerOptions["createMediaRecorder"]
	>;
	private readonly runDownload: typeof downloadRecording;
	private state: LocalRecordingState = "idle";
	private error: Error | null = null;
	private recorder: MediaRecorder | null = null;
	private prepared: PreparedRecordingStream | null = null;
	private mimeType: string;
	private chunkCount = 0;
	private sizeBytes = 0;
	private startedAt = 0;
	private pausedAt = 0;
	private totalPausedMs = 0;
	private stoppedAt = 0;
	private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
	private allSourcesEndedTimer: ReturnType<typeof setTimeout> | null = null;
	private cleanupPromise: Promise<void> | null = null;
	private startPromise: Promise<LocalRecordingSnapshot> | null = null;
	private stopPromise: Promise<LocalRecordingSnapshot> | null = null;
	private stopResolve: ((snapshot: LocalRecordingSnapshot) => void) | null =
		null;
	private downloadPromise: Promise<LocalRecordingSnapshot> | null = null;
	private cancellationRequested = false;
	private finalizing = false;

	constructor(private readonly options: LocalRecordingControllerOptions) {
		this.mimeType = options.mimeType;
		this.queue = new BoundedChunkWriteQueue(options.store);
		this.now = options.now ?? Date.now;
		this.setTimer =
			options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
		this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
		this.createMediaRecorder =
			options.createMediaRecorder ??
			((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions));
		this.runDownload = options.download ?? downloadRecording;
	}

	get snapshot(): LocalRecordingSnapshot {
		return {
			state: this.state,
			recordingId: this.options.recordingId,
			mimeType: this.mimeType,
			durationMs: this.durationMs(),
			sizeBytes: this.sizeBytes,
			chunkCount: this.chunkCount,
			error: this.error,
		};
	}

	subscribe(listener: (snapshot: LocalRecordingSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	start(): Promise<LocalRecordingSnapshot> {
		if (this.startPromise && ["idle", "preparing"].includes(this.state))
			return this.startPromise;
		if (this.state !== "idle") return Promise.resolve(this.snapshot);
		this.startPromise = this.startInternal();
		return this.startPromise;
	}

	pause(): LocalRecordingSnapshot {
		if (this.state === "paused") return this.snapshot;
		if (this.state !== "recording" || !this.recorder) return this.snapshot;
		this.recorder.pause();
		this.pausedAt = this.now();
		this.transition("paused");
		return this.snapshot;
	}

	resume(): LocalRecordingSnapshot {
		if (this.state === "recording") return this.snapshot;
		if (this.state !== "paused" || !this.recorder) return this.snapshot;
		this.recorder.resume();
		this.totalPausedMs += Math.max(0, this.now() - this.pausedAt);
		this.pausedAt = 0;
		this.transition("recording");
		return this.snapshot;
	}

	stop(): Promise<LocalRecordingSnapshot> {
		if (this.stopPromise) return this.stopPromise;
		if (["ready", "completed", "failed", "cancelled"].includes(this.state)) {
			return Promise.resolve(this.snapshot);
		}
		if (this.state === "idle") return Promise.resolve(this.snapshot);
		this.stopPromise = new Promise((resolve) => {
			this.stopResolve = resolve;
		});
		if (this.state === "preparing") {
			this.cancellationRequested = true;
			return this.stopPromise;
		}
		this.transition("stopping");
		this.clearLifecycleTimers();
		try {
			if (this.recorder?.state !== "inactive") this.recorder?.stop();
			else void this.finalizeAfterStop();
		} catch (error) {
			void this.fail(error);
		}
		return this.stopPromise;
	}

	async cancel(): Promise<LocalRecordingSnapshot> {
		if (this.state === "cancelled") return this.snapshot;
		this.cancellationRequested = true;
		if (["recording", "paused", "stopping", "preparing"].includes(this.state)) {
			await this.stop();
		} else {
			await this.options.store.delete(this.options.recordingId);
			await this.cleanupOnce();
			this.transition("cancelled");
		}
		return this.snapshot;
	}

	download(writer?: RecordingStreamWriter): Promise<LocalRecordingSnapshot> {
		if (this.downloadPromise) return this.downloadPromise;
		if (this.state === "completed") return Promise.resolve(this.snapshot);
		if (this.state !== "ready") return Promise.resolve(this.snapshot);
		this.downloadPromise = this.downloadInternal(writer).finally(() => {
			this.downloadPromise = null;
		});
		return this.downloadPromise;
	}

	/** Starts/cancels the 10-second ended slate based on current logical source states. */
	setSourceStatuses(
		statuses: readonly ("active" | "reconnecting" | "ended")[],
	): void {
		if (!["recording", "paused"].includes(this.state)) return;
		const allEnded =
			statuses.length === 0 || statuses.every((status) => status === "ended");
		if (!allEnded) {
			if (this.allSourcesEndedTimer !== null) {
				this.clearTimer(this.allSourcesEndedTimer);
				this.allSourcesEndedTimer = null;
			}
			return;
		}
		if (this.allSourcesEndedTimer !== null) return;
		this.allSourcesEndedTimer = this.setTimer(() => {
			this.allSourcesEndedTimer = null;
			void this.stop();
		}, this.options.allSourcesEndedGraceMs ?? 10_000);
	}

	private async startInternal(): Promise<LocalRecordingSnapshot> {
		this.transition("preparing");
		const createdAt = this.now();
		try {
			await this.options.store.initialize({
				recordingId: this.options.recordingId,
				mimeType: this.options.mimeType,
				createdAt,
				updatedAt: createdAt,
				chunkCount: 0,
				totalBytes: 0,
				status: "writing",
			});
			this.prepared = await this.options.prepareStream();
			if (this.cancellationRequested) {
				await this.options.store.delete(this.options.recordingId);
				await this.cleanupOnce();
				this.transition("cancelled");
				this.resolveStop();
				return this.snapshot;
			}
			const recorderOptions: MediaRecorderOptions = {
				mimeType: this.options.mimeType,
				videoBitsPerSecond: this.options.videoBitsPerSecond,
				audioBitsPerSecond: this.options.audioBitsPerSecond,
			};
			this.recorder = this.createMediaRecorder(
				this.prepared.stream,
				recorderOptions,
			);
			this.mimeType = this.recorder.mimeType || this.options.mimeType;
			this.recorder.addEventListener("dataavailable", this.onDataAvailable);
			this.recorder.addEventListener("error", this.onRecorderError);
			this.recorder.addEventListener("stop", this.onRecorderStop);
			this.startedAt = this.now();
			this.recorder.start(this.options.timesliceMs ?? 1000);
			this.transition("recording");
			this.maxDurationTimer = this.setTimer(
				() => void this.stop(),
				this.options.maxDurationMs ?? MAX_RECORDING_DURATION_MS,
			);
			return this.snapshot;
		} catch (error) {
			await this.fail(error);
			return this.snapshot;
		}
	}

	private readonly onDataAvailable = (event: BlobEvent): void => {
		if (!event.data || event.data.size === 0 || this.finalizing) return;
		const chunk = {
			index: this.chunkCount,
			blob: event.data,
			size: event.data.size,
			createdAt: this.now(),
		};
		this.chunkCount += 1;
		this.sizeBytes += chunk.size;
		this.emit();
		void this.queue.enqueue(this.options.recordingId, chunk).catch((error) => {
			void this.fail(error);
		});
	};

	private readonly onRecorderError = (event: Event): void => {
		void this.fail(errorFromEvent(event));
	};

	private readonly onRecorderStop = (): void => {
		void this.finalizeAfterStop();
	};

	private async finalizeAfterStop(): Promise<void> {
		if (this.finalizing) return;
		this.finalizing = true;
		this.stoppedAt = this.now();
		try {
			await this.queue.flush();
			if (this.cancellationRequested) {
				await this.options.store.delete(this.options.recordingId);
				this.transition("cancelled");
			} else {
				await this.options.store.finalize(this.options.recordingId, "ready");
				this.transition("ready");
			}
		} catch (error) {
			await this.fail(error);
		} finally {
			await this.cleanupOnce();
			this.resolveStop();
		}
	}

	private async fail(error: unknown): Promise<void> {
		if (this.state === "failed") return;
		this.finalizing = true;
		this.error = error instanceof Error ? error : new Error(String(error));
		this.clearLifecycleTimers();
		try {
			if (this.recorder?.state !== "inactive") this.recorder?.stop();
		} catch {
			// Continue failure finalization when the recorder itself is unusable.
		}
		try {
			await this.options.store.finalize(this.options.recordingId, "failed");
		} catch {
			// Preserve the primary recorder/storage error.
		}
		await this.cleanupOnce();
		this.transition("failed");
		this.resolveStop();
	}

	private async downloadInternal(
		writer?: RecordingStreamWriter,
	): Promise<LocalRecordingSnapshot> {
		this.transition("downloading");
		try {
			await this.runDownload({
				store: this.options.store,
				recordingId: this.options.recordingId,
				mimeType: this.mimeType,
				filename: this.options.filename ?? "ollashare-recording",
				writer,
			});
			await this.options.store.delete(this.options.recordingId);
			this.transition("completed");
		} catch (error) {
			this.error = error instanceof Error ? error : new Error(String(error));
			this.transition("ready");
		}
		return this.snapshot;
	}

	private durationMs(): number {
		if (!this.startedAt) return 0;
		const end =
			this.stoppedAt || (this.state === "paused" ? this.pausedAt : this.now());
		return Math.max(0, end - this.startedAt - this.totalPausedMs);
	}

	private async cleanupOnce(): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		this.cleanupPromise = (async () => {
			this.clearLifecycleTimers();
			if (this.recorder) {
				this.recorder.removeEventListener(
					"dataavailable",
					this.onDataAvailable,
				);
				this.recorder.removeEventListener("error", this.onRecorderError);
				this.recorder.removeEventListener("stop", this.onRecorderStop);
			}
			for (const track of this.prepared?.stream.getTracks() ?? []) track.stop();
			await this.prepared?.cleanup?.();
		})();
		return this.cleanupPromise;
	}

	private clearLifecycleTimers(): void {
		if (this.maxDurationTimer !== null) this.clearTimer(this.maxDurationTimer);
		if (this.allSourcesEndedTimer !== null)
			this.clearTimer(this.allSourcesEndedTimer);
		this.maxDurationTimer = null;
		this.allSourcesEndedTimer = null;
	}

	private transition(state: LocalRecordingState): void {
		this.state = state;
		this.emit();
	}

	private emit(): void {
		const snapshot = this.snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}

	private resolveStop(): void {
		this.stopResolve?.(this.snapshot);
		this.stopResolve = null;
	}
}
