import { describe, expect, it, vi } from "vitest";
import {
	annotationPointToCanvas,
	drawAnnotationStroke,
} from "./annotation-renderer";
import { RecordingAudioMixer } from "./audio-mixer";
import {
	CanvasCompositor,
	calculateLetterboxRect,
	calculateRecordingLayout,
} from "./canvas-compositor";
import {
	BoundedChunkWriteQueue,
	InMemoryRecordingChunkStore,
	MAX_BLOB_MATERIALIZATION_BYTES,
	calculateIndexedDbRecordingCap,
	materializeRecordingBlob,
} from "./chunk-store";
import { LocalRecordingController } from "./controller";
import {
	recordingExtensionForMime,
	sanitizeRecordingFilename,
} from "./download";
import { RecordingSourceRegistry } from "./source-registry";

class FakeTrack extends EventTarget {
	readonly kind: "video" | "audio";
	readonly id: string;
	enabled = true;
	readyState: MediaStreamTrackState = "live";
	stop = vi.fn(() => {
		this.readyState = "ended";
	});

	constructor(id: string, kind: "video" | "audio") {
		super();
		this.id = id;
		this.kind = kind;
	}

	clone(): MediaStreamTrack {
		return new FakeTrack(
			`${this.id}-clone`,
			this.kind,
		) as unknown as MediaStreamTrack;
	}

	getSettings(): MediaTrackSettings {
		return this.kind === "video" ? { width: 1920, height: 1080 } : {};
	}

	end(): void {
		this.readyState = "ended";
		this.dispatchEvent(new Event("ended"));
	}
}

function fakeVideoElement() {
	return {
		muted: false,
		autoplay: false,
		playsInline: false,
		srcObject: null,
		style: {},
		setAttribute: vi.fn(),
		play: vi.fn(async () => undefined),
		pause: vi.fn(),
		remove: vi.fn(),
		readyState: 4,
		videoWidth: 1920,
		videoHeight: 1080,
	} as unknown as HTMLVideoElement;
}

class FakeRecorder extends EventTarget {
	state: RecordingState = "inactive";
	start = vi.fn((_timeslice: number) => {
		this.state = "recording";
	});
	pause = vi.fn(() => {
		this.state = "paused";
	});
	resume = vi.fn(() => {
		this.state = "recording";
	});
	stop = vi.fn(() => {
		this.state = "inactive";
		queueMicrotask(() => this.dispatchEvent(new Event("stop")));
	});

	chunk(value: string): void {
		this.dispatchEvent(
			Object.assign(new Event("dataavailable"), {
				data: new Blob([value], { type: "video/webm" }),
			}),
		);
	}
}

function fakeMediaStream(tracks: MediaStreamTrack[] = []) {
	return {
		getTracks: () => tracks,
		getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
		getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
	} as unknown as MediaStream;
}

describe("recording source registry", () => {
	it("clones, replaces, observes end, and never stops originals", () => {
		const original = new FakeTrack("screen-1", "video");
		const replacement = new FakeTrack("screen-2", "video");
		const registry = new RecordingSourceRegistry({
			createVideoElement: fakeVideoElement,
			createMediaStream: fakeMediaStream,
			now: () => 1,
		});
		const first = registry.add({
			id: "source",
			owner: { id: "u", name: "Alice" },
			videoTrack: original as unknown as MediaStreamTrack,
		});
		expect(first.videoTrack).not.toBe(original);
		original.end();
		expect(registry.get("source")?.status).toBe("ended");
		const cloneStop = first.videoTrack?.stop as ReturnType<typeof vi.fn>;
		registry.replace("source", {
			owner: { id: "u", name: "Alice" },
			videoTrack: replacement as unknown as MediaStreamTrack,
		});
		expect(cloneStop).toHaveBeenCalledOnce();
		expect(original.stop).not.toHaveBeenCalled();
		registry.close();
		expect(replacement.stop).not.toHaveBeenCalled();
	});
	it("accepts guarded canvas frames as video-only sources", () => {
		const sourceCanvas = {
			width: 1920,
			height: 1080,
		} as HTMLCanvasElement;
		const registry = new RecordingSourceRegistry({
			createVideoElement: fakeVideoElement,
			createMediaStream: fakeMediaStream,
		});
		const source = registry.add({
			id: "shared-browser",
			owner: { id: "browser", name: "Shared Browser" },
			canvasSource: {
				getCanvas: () => sourceCanvas,
				getDimensions: () => ({ width: 1920, height: 1080 }),
			},
		});
		expect(source.videoTrack).toBeNull();
		expect(source.videoElement).toBeNull();
		expect(source.canvasSource?.getCanvas()).toBe(sourceCanvas);
		expect(() =>
			registry.add({
				id: "invalid-audio",
				owner: { id: "browser", name: "Shared Browser" },
				canvasSource: {
					getCanvas: () => sourceCanvas,
					getDimensions: () => ({ width: 1920, height: 1080 }),
				},
				audioTracks: [
					new FakeTrack("microphone", "audio") as unknown as MediaStreamTrack,
				],
			}),
		).toThrow(/video only/);
		registry.close();
	});
});

describe("canvas geometry", () => {
	it("builds deterministic focused/grid layouts and letterboxes", () => {
		expect(
			calculateRecordingLayout(1920, 1080, ["b", "a"], { mode: "grid" }).get(
				"a",
			),
		).toEqual({
			x: 960,
			y: 0,
			width: 960,
			height: 1080,
		});
		expect(
			calculateRecordingLayout(1280, 720, ["a", "b"], {
				mode: "focused",
				focusedSourceId: "b",
			}).has("a"),
		).toBe(false);
		expect(
			calculateLetterboxRect(4, 3, { x: 0, y: 0, width: 1920, height: 1080 }),
		).toEqual({
			x: 240,
			y: 0,
			width: 1440,
			height: 1080,
		});
	});
	it("uses exact profile dimensions and deterministic frame scheduling", () => {
		const context = {
			save: vi.fn(),
			restore: vi.fn(),
			fillRect: vi.fn(),
			fillText: vi.fn(),
			measureText: vi.fn(() => ({ width: 100 })),
			beginPath: vi.fn(),
			rect: vi.fn(),
			clip: vi.fn(),
			fillStyle: "",
			font: "",
			textAlign: "start",
			textBaseline: "alphabetic",
			drawImage: vi.fn(),
		} as unknown as CanvasRenderingContext2D;
		const canvas = {
			width: 0,
			height: 0,
			style: {},
			setAttribute: vi.fn(),
			getContext: vi.fn(() => context),
			remove: vi.fn(),
		} as unknown as HTMLCanvasElement;
		const scheduled: number[] = [];
		const compositor = new CanvasCompositor({
			profile: { width: 1280, height: 720, fps: 25 },
			createCanvas: () => canvas,
			now: () => 0,
			setTimer: (_callback, delay) => {
				scheduled.push(delay);
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
		});
		compositor.start();
		expect(canvas.width).toBe(1280);
		expect(canvas.height).toBe(720);
		expect(scheduled).toEqual([40]);
		compositor.stop();
	});

	it("draws a connected canvas frame and invokes annotation composition", () => {
		const context = {
			save: vi.fn(),
			restore: vi.fn(),
			fillRect: vi.fn(),
			fillText: vi.fn(),
			measureText: vi.fn(() => ({ width: 100 })),
			beginPath: vi.fn(),
			rect: vi.fn(),
			clip: vi.fn(),
			drawImage: vi.fn(),
			fillStyle: "",
			font: "",
			textAlign: "start",
			textBaseline: "alphabetic",
		} as unknown as CanvasRenderingContext2D;
		const outputCanvas = {
			width: 0,
			height: 0,
			style: {},
			setAttribute: vi.fn(),
			getContext: vi.fn(() => context),
			remove: vi.fn(),
		} as unknown as HTMLCanvasElement;
		const sourceCanvas = { width: 1920, height: 1080 } as HTMLCanvasElement;
		const onFrame = vi.fn();
		const compositor = new CanvasCompositor({
			profile: { width: 640, height: 360, fps: 30 },
			createCanvas: () => outputCanvas,
			onFrame,
		});
		compositor.setSources([
			{
				id: "shared-browser",
				owner: { id: "browser", name: "Shared Browser" },
				status: "active",
				originalVideoTrackId: null,
				originalAudioTrackIds: [],
				videoTrack: null,
				audioTracks: [],
				videoElement: null,
				canvasSource: {
					getCanvas: () => sourceCanvas,
					getDimensions: () => ({ width: 1920, height: 1080 }),
				},
				updatedAt: 1,
			},
		]);
		compositor.drawFrame();
		expect(context.drawImage).toHaveBeenCalledWith(
			sourceCanvas,
			0,
			0,
			640,
			360,
		);
		expect(onFrame).toHaveBeenCalledOnce();
	});
});

describe("annotation rendering", () => {
	it("maps normalized points and uses existing highlighter style", () => {
		expect(
			annotationPointToCanvas(
				{ u: 0.5, v: 0.25 },
				{ x: 10, y: 20, width: 200, height: 100 },
			),
		).toEqual({ x: 110, y: 45 });
		const context = {
			save: vi.fn(),
			restore: vi.fn(),
			beginPath: vi.fn(),
			rect: vi.fn(),
			clip: vi.fn(),
			moveTo: vi.fn(),
			quadraticCurveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
			arc: vi.fn(),
			fill: vi.fn(),
			globalAlpha: 1,
			globalCompositeOperation: "source-over",
			strokeStyle: "",
			fillStyle: "",
			lineWidth: 0,
			lineCap: "butt",
			lineJoin: "miter",
		} as unknown as CanvasRenderingContext2D;
		drawAnnotationStroke(
			context,
			{
				id: "s",
				authorId: "u",
				authorName: "A",
				targetType: "screen",
				targetId: "x",
				color: "#ff0000",
				width: 4,
				tool: "highlighter",
				points: [
					{ u: 0, v: 0 },
					{ u: 1, v: 1 },
				],
				createdAt: 1,
			},
			{ x: 0, y: 0, width: 1920, height: 1080 },
		);
		expect(context.globalAlpha).toBe(0.35);
		expect(context.lineWidth).toBe(8);
		expect(context.stroke).toHaveBeenCalledOnce();
	});
});

describe("chunk storage", () => {
	it("orders chunks, applies caps, and bounds queued memory", async () => {
		const store = new InMemoryRecordingChunkStore();
		await store.initialize({
			recordingId: "r",
			mimeType: "video/webm",
			createdAt: 1,
			updatedAt: 1,
			chunkCount: 0,
			totalBytes: 0,
			status: "writing",
		});
		const queue = new BoundedChunkWriteQueue(store, 4);
		await queue.enqueue("r", {
			index: 0,
			blob: new Blob(["ab"]),
			size: 2,
			createdAt: 2,
		});
		await queue.enqueue("r", {
			index: 1,
			blob: new Blob(["cd"]),
			size: 2,
			createdAt: 3,
		});
		await queue.flush();
		expect((await store.getMetadata("r"))?.totalBytes).toBe(4);
		expect(
			await materializeRecordingBlob(store, "r", "video/webm"),
		).toHaveProperty("size", 4);
		expect(
			calculateIndexedDbRecordingCap({ quota: 10_000, usage: 2_000 }),
		).toBe(4_800);
		await expect(
			queue.enqueue("r", {
				index: 2,
				blob: new Blob(["12345"]),
				size: 5,
				createdAt: 4,
			}),
		).rejects.toThrow(/backpressure/);
		await store.initialize({
			recordingId: "large",
			mimeType: "video/webm",
			createdAt: 1,
			updatedAt: 1,
			chunkCount: 0,
			totalBytes: MAX_BLOB_MATERIALIZATION_BYTES + 1,
			status: "ready",
		});
		await expect(
			materializeRecordingBlob(store, "large", "video/webm"),
		).rejects.toThrow(/too large/);
	});
});

describe("recording controller", () => {
	it("guards transitions, persists chunks, pauses, resumes, and stops idempotently", async () => {
		const recorder = new FakeRecorder();
		let now = 100;
		const store = new InMemoryRecordingChunkStore();
		const cleanup = vi.fn();
		const controller = new LocalRecordingController({
			recordingId: "r",
			mimeType: "video/webm",
			store,
			prepareStream: async () => ({ stream: fakeMediaStream(), cleanup }),
			createMediaRecorder: () => recorder as unknown as MediaRecorder,
			now: () => now,
			setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
			clearTimer: vi.fn(),
		});
		const startA = controller.start();
		const startB = controller.start();
		expect(startA).toBe(startB);
		await startA;
		recorder.chunk("abc");
		controller.pause();
		now = 200;
		controller.resume();
		now = 300;
		const stopA = controller.stop();
		const stopB = controller.stop();
		expect(stopA).toBe(stopB);
		await stopA;
		expect(controller.snapshot).toMatchObject({
			state: "ready",
			sizeBytes: 3,
			chunkCount: 1,
			durationMs: 100,
		});
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("retains ready data until explicit download or discard", async () => {
		const recorder = new FakeRecorder();
		const store = new InMemoryRecordingChunkStore();
		const download = vi.fn(async () => ({
			filename: "recording.webm",
			bytes: 3,
			streamed: true,
		}));
		const controller = new LocalRecordingController({
			recordingId: "retained",
			mimeType: "video/webm",
			store,
			prepareStream: async () => ({ stream: fakeMediaStream() }),
			createMediaRecorder: () => recorder as unknown as MediaRecorder,
			download,
		});
		await controller.start();
		recorder.chunk("abc");
		await controller.stop();
		expect(controller.snapshot.state).toBe("ready");
		expect(await store.getMetadata("retained")).not.toBeNull();
		expect((await controller.start()).state).toBe("ready");
		expect(await store.getMetadata("retained")).not.toBeNull();
		await controller.download({
			write: async () => undefined,
			close: async () => undefined,
		});
		expect(download).toHaveBeenCalledOnce();
		expect(controller.snapshot.state).toBe("completed");
		expect(await store.getMetadata("retained")).toBeNull();

		const discardRecorder = new FakeRecorder();
		const discardController = new LocalRecordingController({
			recordingId: "discarded",
			mimeType: "video/webm",
			store,
			prepareStream: async () => ({ stream: fakeMediaStream() }),
			createMediaRecorder: () => discardRecorder as unknown as MediaRecorder,
		});
		await discardController.start();
		discardRecorder.chunk("xyz");
		await discardController.stop();
		expect(await store.getMetadata("discarded")).not.toBeNull();
		await discardController.cancel();
		expect(discardController.snapshot.state).toBe("cancelled");
		expect(await store.getMetadata("discarded")).toBeNull();
	});

	it("moves to failed on recorder errors and cleans up once", async () => {
		const recorder = new FakeRecorder();
		const store = new InMemoryRecordingChunkStore();
		const cleanup = vi.fn();
		const controller = new LocalRecordingController({
			recordingId: "error",
			mimeType: "video/webm",
			store,
			prepareStream: async () => ({ stream: fakeMediaStream(), cleanup }),
			createMediaRecorder: () => recorder as unknown as MediaRecorder,
		});
		await controller.start();
		recorder.dispatchEvent(
			Object.assign(new Event("error"), { error: new DOMException("encoder") }),
		);
		await vi.waitFor(() => expect(controller.snapshot.state).toBe("failed"));
		expect(controller.snapshot.error?.message).toContain("encoder");
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("cancels and auto-stops after all sources remain ended", async () => {
		vi.useFakeTimers();
		const recorder = new FakeRecorder();
		const store = new InMemoryRecordingChunkStore();
		const controller = new LocalRecordingController({
			recordingId: "r2",
			mimeType: "video/webm",
			store,
			prepareStream: async () => ({ stream: fakeMediaStream() }),
			createMediaRecorder: () => recorder as unknown as MediaRecorder,
			allSourcesEndedGraceMs: 10_000,
		});
		await controller.start();
		controller.setSourceStatuses(["ended"]);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.resolve();
		expect(controller.snapshot.state).toBe("ready");
		await controller.cancel();
		expect(controller.snapshot.state).toBe("cancelled");
		vi.useRealTimers();
	});
});

describe("download metadata", () => {
	it("sanitizes filenames and derives extensions from actual MIME", () => {
		expect(recordingExtensionForMime("video/mp4;codecs=h264")).toBe("mp4");
		expect(sanitizeRecordingFilename("  Demo: room?.webm ", "video/mp4")).toBe(
			"Demo- room-.mp4",
		);
	});
});

describe("audio mixer", () => {
	it("deduplicates original IDs, never connects speakers, and cleans up clones", async () => {
		const destination = {
			stream: fakeMediaStream([
				new FakeTrack("mixed", "audio") as unknown as MediaStreamTrack,
			]),
		};
		const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
		const gainNode = {
			gain: { value: 0 },
			connect: vi.fn(),
			disconnect: vi.fn(),
		};
		const context = {
			state: "running",
			destination: { speaker: true },
			createMediaStreamDestination: vi.fn(() => destination),
			createMediaStreamSource: vi.fn(() => sourceNode),
			createGain: vi.fn(() => gainNode),
			resume: vi.fn(),
			close: vi.fn(async () => undefined),
		};
		const mixer = new RecordingAudioMixer({
			createAudioContext: () => context as unknown as AudioContext,
			createMediaStream: fakeMediaStream,
		});
		const original = new FakeTrack("audio-1", "audio");
		expect(
			await mixer.add({
				sourceId: "s",
				track: original as unknown as MediaStreamTrack,
			}),
		).toBe(true);
		expect(
			await mixer.add({
				sourceId: "s",
				track: original as unknown as MediaStreamTrack,
			}),
		).toBe(false);
		expect(gainNode.connect).toHaveBeenCalledWith(destination);
		expect(gainNode.connect).not.toHaveBeenCalledWith(context.destination);
		expect(mixer.removeSource("s")).toBe(1);
		await mixer.close();
		expect(context.close).toHaveBeenCalledOnce();
		expect(original.stop).not.toHaveBeenCalled();
	});
});
