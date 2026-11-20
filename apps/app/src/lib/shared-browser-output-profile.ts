import type { MediaDimensions } from "./media-profiles";

export const SHARED_BROWSER_OUTPUT_RESOLUTIONS = [
	"1080p",
	"720p",
	"360p",
] as const;
export type SharedBrowserOutputResolution =
	(typeof SHARED_BROWSER_OUTPUT_RESOLUTIONS)[number];

export interface SharedBrowserOutputProfile extends MediaDimensions {
	resolution: SharedBrowserOutputResolution;
}

const SHARED_BROWSER_OUTPUT_PROFILES: Readonly<
	Record<SharedBrowserOutputResolution, SharedBrowserOutputProfile>
> = {
	"1080p": { resolution: "1080p", width: 1920, height: 1080 },
	"720p": { resolution: "720p", width: 1280, height: 720 },
	"360p": { resolution: "360p", width: 640, height: 360 },
};

export function resolveSharedBrowserOutputProfile(
	resolution: unknown,
	fallback: SharedBrowserOutputResolution = "1080p",
): SharedBrowserOutputProfile {
	if (
		typeof resolution === "string" &&
		SHARED_BROWSER_OUTPUT_RESOLUTIONS.includes(
			resolution as SharedBrowserOutputResolution,
		)
	) {
		return SHARED_BROWSER_OUTPUT_PROFILES[
			resolution as SharedBrowserOutputResolution
		];
	}
	return SHARED_BROWSER_OUTPUT_PROFILES[fallback];
}
