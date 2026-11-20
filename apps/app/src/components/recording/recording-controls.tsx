"use client";

import type {
	OfferedMediaFps,
	RecordingResolution,
} from "@/lib/media-profiles";
import type { LocalRecordingState } from "@/lib/recording/controller";
import { CircleStop, Download, Pause, Play, Radio, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";

export type RecordingTarget = "focused" | "grid" | "shared-browser";

export interface RecordingControlsProps {
	isHost: boolean;
	compact?: boolean;
	sourceAvailable: boolean;
	portalTarget?: HTMLElement | null;
	target: RecordingTarget;
	onTargetChange: (target: RecordingTarget) => void;
	sharedBrowserAvailable: boolean;
	resolution: RecordingResolution;
	onResolutionChange: (resolution: RecordingResolution) => void;
	allow360p: boolean;
	fps: OfferedMediaFps;
	onFpsChange: (fps: OfferedMediaFps) => void;
	includeAudio: boolean;
	onIncludeAudioChange: (include: boolean) => void;
	audioAvailable: boolean;
	state: LocalRecordingState;
	durationMs: number;
	sizeBytes: number;
	mimeType: string;
	sourceSummary: string;
	warning?: string | null;
	error?: string | null;
	recordingAvailable: boolean;
	profileSupported: boolean;
	profileMessage?: string | null;
	unsupportedMessage?: string | null;
	isFpsSupported: (fps: OfferedMediaFps) => boolean;
	onStart: () => void;
	onPause: () => void;
	onResume: () => void;
	onStop: () => void;
	onCancel: () => void;
	onDownload: () => void;
}

function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	return hours > 0
		? [hours, minutes, remainder]
				.map((value) => String(value).padStart(2, "0"))
				.join(":")
		: [minutes, remainder]
				.map((value) => String(value).padStart(2, "0"))
				.join(":");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const controlClass =
	"inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45";
const selectClass =
	"min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs text-white outline-none focus:border-sky-400";

export function RecordingControls(props: RecordingControlsProps) {
	if (!props.isHost || !props.portalTarget) return null;
	const active = ["preparing", "recording", "paused", "stopping"].includes(
		props.state,
	);
	const keepVisible =
		active || ["ready", "downloading", "failed"].includes(props.state);
	if (!props.sourceAvailable && !keepVisible) return null;

	if (props.compact) {
		return createPortal(
			<section
				aria-label="Local recording availability"
				className="shrink-0 border-t border-amber-400/30 bg-slate-950 px-3 py-2 text-xs font-medium text-amber-200"
			>
				Local recording downloads are unsupported on mobile/compact layouts in
				this release. Use a supported desktop Chromium browser.
			</section>,
			props.portalTarget,
		);
	}

	const canConfigure =
		!active && props.state !== "downloading" && props.recordingAvailable;
	const canStart =
		props.recordingAvailable &&
		props.profileSupported &&
		["idle", "completed", "cancelled", "failed"].includes(props.state);
	const audioDisabled =
		props.target === "shared-browser" || !props.audioAvailable;

	const controls = (
		<section
			aria-label="Local recording controls"
			data-local-recording-controls
			data-full-view-recording-controls
			className="flex w-full shrink-0 flex-col gap-2 border-t border-slate-700 bg-slate-900/95 px-3 py-2 text-white shadow-[0_-10px_30px_rgba(0,0,0,0.22)] backdrop-blur-xl"
		>
			<div className="flex min-w-0 flex-wrap items-end gap-2">
				<div className="mr-1 flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3">
					<span
						className={`h-2.5 w-2.5 rounded-full ${active ? "animate-pulse bg-red-500" : "bg-sky-400"}`}
					/>
					<div>
						<p className="whitespace-nowrap text-xs font-bold">
							Record & Download
						</p>
						<p className="font-mono text-[10px] text-slate-400">
							{formatDuration(props.durationMs)} ·{" "}
							{formatBytes(props.sizeBytes)}
						</p>
					</div>
				</div>

				<label className="grid shrink-0 gap-0.5 text-[10px] font-medium text-slate-400">
					Capture
					<select
						aria-label="Recording target"
						value={props.target}
						disabled={!canConfigure}
						onChange={(event) =>
							props.onTargetChange(event.target.value as RecordingTarget)
						}
						className={`${selectClass} w-36`}
					>
						<option value="focused">Focused screen</option>
						<option value="grid">Screen grid</option>
						{props.sharedBrowserAvailable && (
							<option value="shared-browser">Shared Browser</option>
						)}
					</select>
				</label>

				<label className="grid shrink-0 gap-0.5 text-[10px] font-medium text-slate-400">
					Quality
					<select
						aria-label="Recording resolution"
						value={props.resolution}
						disabled={!canConfigure}
						onChange={(event) =>
							props.onResolutionChange(
								event.target.value as RecordingResolution,
							)
						}
						className={`${selectClass} w-24`}
					>
						<option value="1080p">1080p</option>
						<option value="720p">720p</option>
						{props.allow360p && <option value="360p">360p</option>}
					</select>
				</label>

				<label className="grid shrink-0 gap-0.5 text-[10px] font-medium text-slate-400">
					FPS
					<select
						aria-label="Recording frame rate"
						value={props.fps}
						disabled={!canConfigure}
						onChange={(event) =>
							props.onFpsChange(Number(event.target.value) as OfferedMediaFps)
						}
						className={`${selectClass} w-20`}
					>
						<option value={25} disabled={!props.isFpsSupported(25)}>
							25
						</option>
						<option value={30} disabled={!props.isFpsSupported(30)}>
							30
						</option>
						<option value={60} disabled={!props.isFpsSupported(60)}>
							60
						</option>
					</select>
				</label>

				<label className="flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 text-[11px] text-slate-300">
					<input
						type="checkbox"
						checked={props.includeAudio && !audioDisabled}
						disabled={!canConfigure || audioDisabled}
						onChange={(event) =>
							props.onIncludeAudioChange(event.target.checked)
						}
					/>
					{props.target === "shared-browser"
						? "Video only"
						: props.audioAvailable
							? "Screen audio"
							: "No screen audio"}
				</label>

				<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
					{canStart && (
						<button
							type="button"
							onClick={props.onStart}
							className={`${controlClass} border-red-400/50 bg-red-600 text-white hover:bg-red-500`}
						>
							<Radio className="h-4 w-4" />
							{props.state === "idle" ? "Record" : "Record new"}
						</button>
					)}
					{props.state === "recording" && (
						<button
							type="button"
							onClick={props.onPause}
							className={`${controlClass} border-amber-400/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25`}
						>
							<Pause className="h-4 w-4" /> Pause
						</button>
					)}
					{props.state === "paused" && (
						<button
							type="button"
							onClick={props.onResume}
							className={`${controlClass} border-emerald-400/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25`}
						>
							<Play className="h-4 w-4" /> Resume
						</button>
					)}
					{active && (
						<>
							<button
								type="button"
								onClick={props.onStop}
								disabled={props.state === "stopping"}
								className={`${controlClass} border-slate-600 bg-slate-800 text-white hover:bg-slate-700`}
							>
								<CircleStop className="h-4 w-4" /> Stop
							</button>
							<button
								type="button"
								onClick={props.onCancel}
								className={`${controlClass} border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20`}
							>
								<Trash2 className="h-4 w-4" /> Cancel
							</button>
						</>
					)}
					{props.state === "ready" && (
						<>
							<button
								type="button"
								onClick={props.onDownload}
								className={`${controlClass} border-sky-400/40 bg-sky-500 text-white hover:bg-sky-400`}
							>
								<Download className="h-4 w-4" /> Download locally
							</button>
							<button
								type="button"
								onClick={props.onCancel}
								className={`${controlClass} border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20`}
							>
								<Trash2 className="h-4 w-4" /> Discard
							</button>
						</>
					)}
				</div>
			</div>

			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400">
				<span>{props.sourceSummary}</span>
				<span className="truncate" title={props.mimeType}>
					MIME: {props.mimeType || "Not selected"}
				</span>
				<span>Stored locally until download or cancel.</span>
				{props.unsupportedMessage && (
					<span role="status" className="font-semibold text-amber-300">
						{props.unsupportedMessage}
					</span>
				)}
				{props.profileMessage && (
					<span role="status" className="font-semibold text-amber-300">
						{props.profileMessage}
					</span>
				)}
				{props.warning && (
					<span role="status" className="font-medium text-amber-300">
						{props.warning}
					</span>
				)}
				{props.error && (
					<span role="alert" className="font-semibold text-red-300">
						{props.error}
					</span>
				)}
			</div>
		</section>
	);

	return createPortal(controls, props.portalTarget);
}
