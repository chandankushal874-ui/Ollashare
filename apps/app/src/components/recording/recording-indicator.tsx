"use client";

export interface ActiveRecordingAwareness {
	state: "recording" | "paused" | "preparing" | "stopping" | string;
	target: string;
	profile: {
		resolution: string;
		fps: number;
		audioIncluded: boolean;
	};
}

export function RecordingIndicator({
	active,
}: {
	active: ActiveRecordingAwareness | null | undefined;
}) {
	if (!active) return null;
	const paused = active.state === "paused";
	const target =
		active.target === "shared-browser"
			? "Shared Browser"
			: active.target === "grid"
				? "Screen grid"
				: "Focused screen";
	return (
		<div
			role="status"
			aria-live="polite"
			data-recording-indicator={paused ? "paused" : "recording"}
			className={`fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[75] -translate-x-1/2 rounded-full border px-3 py-2 text-xs font-bold shadow-xl backdrop-blur-md ${paused ? "border-amber-300/50 bg-amber-950/90 text-amber-100" : "border-red-300/50 bg-red-950/90 text-red-100"}`}
		>
			<span
				className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${paused ? "bg-amber-400" : "animate-pulse bg-red-500"}`}
			/>
			{paused ? "Recording paused" : "Recording"} · {target} ·{" "}
			{active.profile.resolution} / {active.profile.fps} fps
		</div>
	);
}
