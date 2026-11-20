import type { ResolvedRecordingProfile } from "../media-profiles";
import type { RecordingSourceSnapshot } from "./source-registry";

export type RecordingLayoutMode = "focused" | "grid";

export interface RecordingRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface RecordingLayoutInput {
	mode: RecordingLayoutMode;
	focusedSourceId?: string | null;
}

export interface RecordingCompositorFrame {
	source: RecordingSourceSnapshot;
	tileRect: RecordingRect;
	imageRect: RecordingRect;
}

export interface CanvasCompositorOptions {
	profile: Pick<ResolvedRecordingProfile, "width" | "height" | "fps">;
	layout?: RecordingLayoutInput;
	background?: string;
	createCanvas?: () => HTMLCanvasElement;
	now?: () => number;
	setTimer?: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	onFrame?: (
		context: CanvasRenderingContext2D,
		frames: readonly RecordingCompositorFrame[],
	) => void;
}

export function calculateLetterboxRect(
	sourceWidth: number,
	sourceHeight: number,
	target: RecordingRect,
): RecordingRect {
	if (
		sourceWidth <= 0 ||
		sourceHeight <= 0 ||
		target.width <= 0 ||
		target.height <= 0
	) {
		return { ...target };
	}
	const scale = Math.min(
		target.width / sourceWidth,
		target.height / sourceHeight,
	);
	const width = sourceWidth * scale;
	const height = sourceHeight * scale;
	return {
		x: target.x + (target.width - width) / 2,
		y: target.y + (target.height - height) / 2,
		width,
		height,
	};
}

export function calculateRecordingLayout(
	width: number,
	height: number,
	sourceIds: readonly string[],
	layout: RecordingLayoutInput,
): Map<string, RecordingRect> {
	const result = new Map<string, RecordingRect>();
	if (sourceIds.length === 0) return result;
	if (layout.mode === "focused") {
		const focusedId =
			(layout.focusedSourceId && sourceIds.includes(layout.focusedSourceId)
				? layout.focusedSourceId
				: sourceIds[0]) ?? sourceIds[0];
		if (focusedId) result.set(focusedId, { x: 0, y: 0, width, height });
		return result;
	}

	const columns = Math.ceil(Math.sqrt(sourceIds.length));
	const rows = Math.ceil(sourceIds.length / columns);
	const cellWidth = width / columns;
	const cellHeight = height / rows;
	sourceIds.forEach((id, index) => {
		const column = index % columns;
		const row = Math.floor(index / columns);
		result.set(id, {
			x: column * cellWidth,
			y: row * cellHeight,
			width: cellWidth,
			height: cellHeight,
		});
	});
	return result;
}

function defaultCanvas(): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.setAttribute("aria-hidden", "true");
	canvas.style.position = "fixed";
	canvas.style.left = "-10000px";
	canvas.style.top = "-10000px";
	canvas.style.pointerEvents = "none";
	return canvas;
}

function sourceDimensions(source: RecordingSourceSnapshot): {
	width: number;
	height: number;
} {
	const canvasDimensions = source.canvasSource?.getDimensions();
	if (canvasDimensions?.width && canvasDimensions.height)
		return canvasDimensions;
	const video = source.videoElement;
	if (video && video.videoWidth > 0 && video.videoHeight > 0) {
		return { width: video.videoWidth, height: video.videoHeight };
	}
	const settings = source.videoTrack?.getSettings?.() ?? {};
	return { width: settings.width ?? 16, height: settings.height ?? 9 };
}

/** Exact-profile canvas renderer for deterministic local recording composition. */
export class CanvasCompositor {
	readonly canvas: HTMLCanvasElement;
	readonly context: CanvasRenderingContext2D;
	private readonly fps: 25 | 30 | 60;
	private readonly frameIntervalMs: number;
	private readonly background: string;
	private readonly now: () => number;
	private readonly setTimer: CanvasCompositorOptions["setTimer"];
	private readonly clearTimer: CanvasCompositorOptions["clearTimer"];
	private readonly onFrame?: CanvasCompositorOptions["onFrame"];
	private sources: readonly RecordingSourceSnapshot[] = [];
	private layout: RecordingLayoutInput;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private paused = false;
	private nextFrameAt = 0;
	private lastFrames: readonly RecordingCompositorFrame[] = [];

	constructor(options: CanvasCompositorOptions) {
		if (![25, 30, 60].includes(options.profile.fps)) {
			throw new Error("Recording compositor supports 25, 30, or 60 FPS");
		}
		this.canvas = (options.createCanvas ?? defaultCanvas)();
		this.canvas.width = options.profile.width;
		this.canvas.height = options.profile.height;
		const context = this.canvas.getContext("2d", { alpha: false });
		if (!context) throw new Error("2D canvas recording is unavailable");
		this.context = context;
		this.fps = options.profile.fps as 25 | 30 | 60;
		this.frameIntervalMs = 1000 / this.fps;
		this.background = options.background ?? "#080b12";
		this.layout = options.layout ?? { mode: "grid" };
		this.now = options.now ?? (() => performance.now());
		this.setTimer =
			options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
		this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
		this.onFrame = options.onFrame;
	}

	setSources(sources: readonly RecordingSourceSnapshot[]): void {
		this.sources = [...sources].sort((left, right) =>
			left.id.localeCompare(right.id),
		);
	}

	setLayout(layout: RecordingLayoutInput): void {
		this.layout = { ...layout };
	}

	getFrames(): readonly RecordingCompositorFrame[] {
		return this.lastFrames;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.paused = false;
		this.nextFrameAt = this.now();
		this.schedule();
	}

	pause(): void {
		if (!this.running || this.paused) return;
		this.paused = true;
		this.cancelTimer();
	}

	resume(): void {
		if (!this.running || !this.paused) return;
		this.paused = false;
		this.nextFrameAt = this.now();
		this.schedule();
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		this.paused = false;
		this.cancelTimer();
	}

	drawFrame(): readonly RecordingCompositorFrame[] {
		const context = this.context;
		context.save();
		context.fillStyle = this.background;
		context.fillRect(0, 0, this.canvas.width, this.canvas.height);
		const visibleSources =
			this.layout.mode === "focused"
				? this.sources.filter(
						(source) =>
							source.id === this.layout.focusedSourceId ||
							(!this.layout.focusedSourceId && source === this.sources[0]),
					)
				: this.sources;
		const layout = calculateRecordingLayout(
			this.canvas.width,
			this.canvas.height,
			visibleSources.map((source) => source.id),
			this.layout,
		);
		const frames: RecordingCompositorFrame[] = [];
		for (const source of visibleSources) {
			const tileRect = layout.get(source.id);
			if (!tileRect) continue;
			context.save();
			context.beginPath();
			context.rect(tileRect.x, tileRect.y, tileRect.width, tileRect.height);
			context.clip();
			const dimensions = sourceDimensions(source);
			const imageRect = calculateLetterboxRect(
				dimensions.width,
				dimensions.height,
				tileRect,
			);
			const canvas = source.canvasSource?.getCanvas() ?? null;
			const drawable = canvas ?? source.videoElement;
			const ready = canvas
				? canvas.width > 0 && canvas.height > 0
				: Boolean(source.videoElement && source.videoElement.readyState >= 2);
			if (source.status === "active" && drawable && ready) {
				context.drawImage(
					drawable,
					imageRect.x,
					imageRect.y,
					imageRect.width,
					imageRect.height,
				);
			} else {
				this.drawSlate(
					tileRect,
					source.status === "ended" ? "Source ended" : "Reconnecting…",
				);
			}
			this.drawBadge(tileRect, source.owner.name, source.status);
			context.restore();
			frames.push({ source, tileRect, imageRect });
		}
		if (visibleSources.length === 0) {
			this.drawSlate(
				{ x: 0, y: 0, width: this.canvas.width, height: this.canvas.height },
				"Waiting for a screen share",
			);
		}
		context.restore();
		this.lastFrames = frames;
		this.onFrame?.(context, frames);
		return frames;
	}

	captureStream(): MediaStream {
		const capture = this.canvas.captureStream;
		if (typeof capture !== "function")
			throw new Error("Canvas captureStream is unavailable");
		return capture.call(this.canvas, this.fps);
	}

	close(): void {
		this.stop();
		this.canvas.remove?.();
		this.sources = [];
		this.lastFrames = [];
	}

	private schedule(): void {
		if (!this.running || this.paused) return;
		const current = this.now();
		if (current >= this.nextFrameAt) {
			this.drawFrame();
			const elapsedFrames = Math.max(
				1,
				Math.floor((current - this.nextFrameAt) / this.frameIntervalMs) + 1,
			);
			this.nextFrameAt += elapsedFrames * this.frameIntervalMs;
		}
		const delay = Math.max(0, this.nextFrameAt - this.now());
		this.timer = this.setTimer?.(() => this.schedule(), delay) ?? null;
	}

	private cancelTimer(): void {
		if (this.timer === null) return;
		this.clearTimer?.(this.timer);
		this.timer = null;
	}

	private drawSlate(rect: RecordingRect, message: string): void {
		const context = this.context;
		context.fillStyle = "#111827";
		context.fillRect(rect.x, rect.y, rect.width, rect.height);
		context.fillStyle = "#cbd5e1";
		context.font = `${Math.max(16, Math.round(rect.height * 0.035))}px system-ui, sans-serif`;
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(
			message,
			rect.x + rect.width / 2,
			rect.y + rect.height / 2,
		);
	}

	private drawBadge(
		rect: RecordingRect,
		name: string,
		status: RecordingSourceSnapshot["status"],
	): void {
		const context = this.context;
		const label = status === "active" ? name : `${name} · ${status}`;
		const fontSize = Math.max(14, Math.round(this.canvas.height * 0.022));
		context.font = `600 ${fontSize}px system-ui, sans-serif`;
		const paddingX = Math.round(fontSize * 0.65);
		const badgeHeight = Math.round(fontSize * 1.8);
		const badgeWidth = Math.min(
			rect.width - 16,
			Math.ceil(context.measureText(label).width + paddingX * 2),
		);
		context.fillStyle = "rgba(2, 6, 23, 0.78)";
		context.fillRect(
			rect.x + 8,
			rect.y + rect.height - badgeHeight - 8,
			badgeWidth,
			badgeHeight,
		);
		context.fillStyle = status === "active" ? "#f8fafc" : "#fbbf24";
		context.textAlign = "left";
		context.textBaseline = "middle";
		context.fillText(
			label,
			rect.x + 8 + paddingX,
			rect.y + rect.height - badgeHeight / 2 - 8,
			Math.max(0, badgeWidth - paddingX * 2),
		);
	}
}
