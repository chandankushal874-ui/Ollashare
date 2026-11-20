"use client";

import { createPortal } from "react-dom";
import type { RecordingTarget } from "./recording-controls";

export interface RecordingConsentDialogProps {
	open: boolean;
	portalTarget?: HTMLElement | null;
	target: RecordingTarget;
	includeAudio: boolean;
	audioAvailable: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function RecordingConsentDialog({
	open,
	portalTarget,
	target,
	includeAudio,
	audioAvailable,
	onConfirm,
	onCancel,
}: RecordingConsentDialogProps) {
	if (!open || !portalTarget) return null;
	const sharedBrowser = target === "shared-browser";
	const dialog = (
		<div
			role="presentation"
			className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm"
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="local-recording-consent-title"
				className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-950 p-5 text-white shadow-2xl"
			>
				<h2 id="local-recording-consent-title" className="text-lg font-bold">
					Start local recording?
				</h2>
				<p className="mt-2 text-sm leading-6 text-slate-300">
					The recording is encoded and stored only in this host browser. It is
					not uploaded by this feature.
				</p>
				<ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-slate-300">
					<li>
						{sharedBrowser
							? "The connected Shared Browser video canvas will be recorded."
							: target === "grid"
								? "All available shared screens in the deterministic grid will be recorded."
								: "The focused shared screen will be recorded; focus changes may change the source."}
					</li>
					<li>
						Visible committed annotations and in-progress draft annotations are
						included.
					</li>
					<li>
						Source owner names and active/reconnecting/ended status labels are
						included.
					</li>
					<li>
						{sharedBrowser
							? "Shared Browser recording is video only."
							: includeAudio && audioAvailable
								? "Available screen-share audio is included. Participant microphones are not claimed or added."
								: "No audio will be included. Participant microphones are not claimed or added."}
					</li>
				</ul>
				<div className="mt-5 flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-4 text-sm font-semibold text-slate-200 hover:bg-slate-800"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className="min-h-11 rounded-lg border border-red-400/40 bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-500"
					>
						Confirm and start
					</button>
				</div>
			</div>
		</div>
	);
	return createPortal(dialog, portalTarget);
}
