import { describe, expect, it } from "vitest";
import { resolveSharedBrowserOutputProfile } from "./shared-browser-output-profile";

describe("shared browser output profiles", () => {
	it("resolves client-side canvas/recording dimensions", () => {
		expect(resolveSharedBrowserOutputProfile("360p")).toEqual({
			resolution: "360p",
			width: 640,
			height: 360,
		});
		expect(resolveSharedBrowserOutputProfile("720p")).toMatchObject({
			width: 1280,
			height: 720,
		});
		expect(resolveSharedBrowserOutputProfile("1080p")).toMatchObject({
			width: 1920,
			height: 1080,
		});
	});

	it("defaults unknown output preferences without changing a source runtime", () => {
		expect(resolveSharedBrowserOutputProfile("4K")).toMatchObject({
			resolution: "1080p",
			width: 1920,
			height: 1080,
		});
	});
});
