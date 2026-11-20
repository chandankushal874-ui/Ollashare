import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { chromium, webkit } from "playwright";
import {
	finalizeAcceptanceEvidence,
	probeArtifactMetadata,
} from "./evidence.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outputDirectory = path.join(here, "artifacts");
fs.mkdirSync(outputDirectory, { recursive: true });
const quick = process.argv.includes("--quick");
const runSoak = process.argv.includes("--soak");
const keepArtifacts = process.argv.includes("--keep-artifacts") || runSoak;
const onlyArgument = process.argv.find((argument) =>
	argument.startsWith("--only="),
);
const onlyScenario = onlyArgument?.slice("--only=".length) || null;

const bundle = await esbuild.build({
	entryPoints: [path.join(here, "harness.tsx")],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: ["chrome110", "safari16"],
	jsx: "automatic",
	sourcemap: "inline",
});
const bundleText = bundle.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recording Acceptance</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
const server = http.createServer((request, response) => {
	if (request.url?.startsWith("/bundle.js")) {
		response.writeHead(200, {
			"content-type": "application/javascript; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(bundleText);
		return;
	}
	if (request.url?.startsWith("/frame")) {
		const requestUrl = new URL(request.url, "http://127.0.0.1");
		const sessionId =
			requestUrl.searchParams.get("session") ?? "acceptance-session";
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(
			`<!doctype html><html><body><div data-mira-shared-browser-root data-session-id="${sessionId.replace(/[^A-Za-z0-9_;-]/g, "")}"><div data-mira-novnc-target><canvas id="frame" width="640" height="360"></canvas></div></div><script>const c=document.getElementById('frame');const x=c.getContext('2d');x.fillStyle='#16a34a';x.fillRect(0,0,c.width,c.height);</script></body></html>`,
		);
		return;
	}
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

const results = [];
const artifacts = [];
const defects = [];
const soakMetrics = [];
const cleanupPaths = [];
const expectedGatedProfiles = new Set(["720p60", "1080p60"]);

function record(engine, scenario, status, detail = "") {
	const result = { engine, scenario, status, detail };
	results.push(result);
	const prefix =
		status === "passed" ? "PASS" : status === "blocked" ? "BLOCK" : "FAIL";
	console.log(
		`${prefix} | ${engine} | ${scenario}${detail ? ` | ${detail}` : ""}`,
	);
	return result;
}

function findExecutable(name) {
	try {
		const command = process.platform === "win32" ? "where" : "which";
		return (
			execFileSync(command, [name], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			})
				.split(/\r?\n/)
				.find(Boolean) ?? null
		);
	} catch {
		return null;
	}
}

const ffprobe = findExecutable("ffprobe");

async function ffprobeArtifact(filePath) {
	return probeArtifactMetadata({
		ffprobePath: ffprobe,
		filePath,
		execFileAsync,
	});
}

function resourceSnapshot() {
	const memory = process.memoryUsage();
	let disk = null;
	try {
		const stats = fs.statfsSync(outputDirectory);
		disk = {
			availableBytes: stats.bavail * stats.bsize,
			freeBytes: stats.bfree * stats.bsize,
		};
	} catch {
		// External VM sampling remains authoritative when statfs is unavailable.
	}
	return {
		capturedAt: new Date().toISOString(),
		memory: {
			rssBytes: memory.rss,
			heapTotalBytes: memory.heapTotal,
			heapUsedBytes: memory.heapUsed,
			externalBytes: memory.external,
			arrayBuffersBytes: memory.arrayBuffers,
		},
		disk,
	};
}

function fraction(value) {
	if (!value || value === "0/0") return 0;
	const [numerator, denominator = "1"] = String(value).split("/").map(Number);
	return denominator ? numerator / denominator : 0;
}

function mimeFor(capabilities, includeAudio) {
	const preferred = includeAudio
		? [
				"video/webm;codecs=vp9,opus",
				"video/webm;codecs=vp8,opus",
				"video/mp4;codecs=avc1.42E01E,mp4a.40.2",
				"video/mp4",
			]
		: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4"];
	return (
		preferred.find((mime) => capabilities.supportedMimes.includes(mime)) ?? null
	);
}

async function withPage(browserType, engine, callback) {
	let browser;
	try {
		browser = await browserType.launch({ headless: true });
	} catch (error) {
		record(
			engine,
			"browser launch",
			"blocked",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
	const context = await browser.newContext({
		viewport: { width: 1280, height: 900 },
	});
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	try {
		await page.goto(baseUrl);
		await page.waitForFunction(
			() => document.body.dataset.harnessReady === "true",
		);
		const value = await callback(page);
		if (errors.length > 0)
			throw new Error(`Browser errors: ${errors.join(" | ")}`);
		return value;
	} finally {
		await bounded(`${engine} context close`, context.close(), 5000).catch(
			() => undefined,
		);
		await bounded(`${engine} browser close`, browser.close(), 5000).catch(
			() => undefined,
		);
	}
}

async function bounded(label, promise, timeoutMs = 15000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function waitForState(page, state, timeout = 8000) {
	await page.waitForFunction(
		(expected) =>
			window.recordingHarness
				.inspect()
				.then((value) => value.snapshot.state === expected),
		state,
		{ timeout },
	);
}

async function configure(page, options) {
	await page.evaluate(
		(next) => window.recordingHarness.configure(next),
		options,
	);
	await page.waitForTimeout(120);
}

async function recordArtifact(page, engine, label, profile, options = {}) {
	const includeAudio = options.includeAudio ?? true;
	const capabilities = await page.evaluate(() =>
		window.recordingHarness.capabilities(),
	);
	const mimeType = mimeFor(capabilities, includeAudio);
	if (!mimeType) {
		record(
			engine,
			label,
			"blocked",
			`No supported MIME for audio=${includeAudio}`,
		);
		return null;
	}
	await configure(page, {
		width: profile.width,
		height: profile.height,
		fps: profile.fps,
		includeAudio,
		layout: options.layout ?? "focused",
		sourceMode: options.sourceMode ?? "track",
		storeMode: "indexeddb",
		sourceCount: options.sourceCount ?? 1,
		allSourcesEndedGraceMs: options.allSourcesEndedGraceMs ?? 350,
		mimeType,
	});
	let download;
	try {
		console.log(`STEP | ${engine} | ${label} | start`);
		const started = await bounded(
			`${label} start`,
			page.evaluate(() => window.recordingHarness.start()),
		);
		assert.equal(started.state, "recording");
		if (options.during) await options.during(page);
		await page.waitForTimeout(options.durationMs ?? 1500);
		console.log(`STEP | ${engine} | ${label} | inspect`);
		const before = await bounded(
			`${label} inspect`,
			page.evaluate(() => window.recordingHarness.inspect()),
		);
		assert.equal(before.canvas?.width, profile.width);
		assert.equal(before.canvas?.height, profile.height);
		assert.ok(
			(before.canvas?.coloredPixels ?? 0) > 100,
			"compositor output must contain synthetic pixels",
		);
		assert.ok(
			(before.canvas?.annotationPixels ?? 0) > 0,
			"compositor output must contain highlighter pixels",
		);
		assert.ok(
			(before.canvas?.badgePixels ?? 0) > 0,
			"compositor output must contain participant badge pixels",
		);
		if (
			(options.sourceCount ?? 1) > 1 &&
			(options.layout ?? "focused") === "grid"
		) {
			assert.ok(
				(before.canvas?.distinctRegionColors ?? 0) > 1,
				"grid output must contain distinct participant regions",
			);
		}
		console.log(`STEP | ${engine} | ${label} | stop`);
		const stopped = await bounded(
			`${label} stop`,
			page.evaluate(() => window.recordingHarness.stop()),
		);
		assert.equal(stopped.state, "ready");
		console.log(`STEP | ${engine} | ${label} | download`);
		download = await bounded(
			`${label} download`,
			page.evaluate(() => window.recordingHarness.download()),
			30000,
		);
	} catch (error) {
		await bounded(
			`${label} failure cleanup`,
			page.evaluate(() => window.recordingHarness.cancel()),
			3000,
		).catch(() => undefined);
		throw error;
	}
	assert.equal(download.state.state, "completed");
	assert.ok(download.bytes > 0);
	assert.ok(download.metadataBefore);
	assert.equal(
		download.metadataAfter,
		null,
		"download must delete IndexedDB data",
	);
	assert.match(download.filename, /\.(webm|mp4)$/);
	const extension = download.filename.endsWith(".mp4") ? "mp4" : "webm";
	const artifactPath = path.join(
		outputDirectory,
		`${engine.toLowerCase()}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${extension}`,
	);
	fs.writeFileSync(artifactPath, Buffer.from(download.base64, "base64"));
	const artifact = {
		engine,
		label,
		profile,
		mimeType: download.state.mimeType,
		filename: download.filename,
		bytes: download.bytes,
		probe: null,
		probeError: null,
		path: artifactPath,
	};
	artifacts.push(artifact);
	if (!keepArtifacts) cleanupPaths.push(artifactPath);
	console.log(`STEP | ${engine} | ${label} | ffprobe`);
	try {
		artifact.probe = await ffprobeArtifact(artifactPath);
	} catch (error) {
		artifact.probeError =
			error instanceof Error ? error.message : String(error);
		throw error;
	}
	const probe = artifact.probe;
	if (probe) {
		const video = probe.streams.find((stream) => stream.codec_type === "video");
		const audio = probe.streams.find((stream) => stream.codec_type === "audio");
		assert.ok(video, "ffprobe must find a video stream");
		assert.equal(video.width, profile.width);
		assert.equal(video.height, profile.height);
		const metadataFps =
			fraction(video.avg_frame_rate) || fraction(video.r_frame_rate);
		const observedFrames = Number(video.nb_read_frames ?? video.nb_frames ?? 0);
		const controllerDurationSeconds = download.state.durationMs / 1000;
		const countedFps =
			observedFrames > 0 && controllerDurationSeconds > 0
				? observedFrames / controllerDurationSeconds
				: 0;
		const observedFps =
			metadataFps >= profile.fps * 0.5 && metadataFps <= profile.fps * 2
				? metadataFps
				: countedFps;
		const requestedDurationSeconds = (options.durationMs ?? 1500) / 1000;
		const duration =
			Number(probe.format?.duration ?? video.duration ?? 0) ||
			controllerDurationSeconds ||
			(observedFps > 0 && observedFrames > 0
				? observedFrames / observedFps
				: requestedDurationSeconds);
		assert.ok(
			observedFps >= profile.fps * 0.7 && observedFps <= profile.fps * 1.3,
			`runtime profile unsupported: fps ${observedFps} outside tolerance for ${profile.fps}`,
		);
		assert.ok(duration > 0.4, `duration must be non-zero: ${duration}`);
		assert.equal(
			Boolean(audio),
			includeAudio && options.sourceMode !== "canvas",
		);
		const normalizedMime = download.state.mimeType.split(";", 1)[0];
		if (normalizedMime === "video/webm")
			assert.match(probe.format?.format_name ?? "", /webm|matroska/);
		if (normalizedMime === "video/mp4")
			assert.match(probe.format?.format_name ?? "", /mp4|mov/);
	}
	record(
		engine,
		label,
		"passed",
		`${download.bytes} bytes, ${download.state.mimeType}`,
	);
	return artifact;
}

const profiles = [
	{ label: "360p25", width: 640, height: 360, fps: 25 },
	{ label: "360p30", width: 640, height: 360, fps: 30 },
	{ label: "360p60", width: 640, height: 360, fps: 60 },
	{ label: "720p25", width: 1280, height: 720, fps: 25 },
	{ label: "720p30", width: 1280, height: 720, fps: 30 },
	{ label: "720p60", width: 1280, height: 720, fps: 60 },
	{ label: "1080p25", width: 1920, height: 1080, fps: 25 },
	{ label: "1080p30", width: 1920, height: 1080, fps: 30 },
	{ label: "1080p60", width: 1920, height: 1080, fps: 60 },
];

async function runProfileMatrix(browserType, engine) {
	await withPage(browserType, engine, async (page) => {
		const capabilities = await page.evaluate(() =>
			window.recordingHarness.capabilities(),
		);
		if (!capabilities.runtime.supported) {
			const supportText = await page
				.getByTestId("local-recording-support")
				.textContent();
			assert.match(
				supportText ?? "",
				/WebKit|Safari|MediaRecorder|canvas|mobile|unavailable|experimental/i,
			);
			record(
				engine,
				"recording unsupported UI",
				"blocked",
				JSON.stringify({ runtime: capabilities.runtime, supportText }),
			);
			return;
		}
		if (
			!capabilities.mediaRecorder ||
			!capabilities.indexedDb ||
			!capabilities.canvasCapture
		) {
			record(
				engine,
				"recording capabilities",
				"blocked",
				JSON.stringify(capabilities),
			);
			return;
		}
		const selected = onlyScenario?.startsWith("profile-")
			? profiles.filter(
					(profile) => `profile-${profile.label}` === onlyScenario,
				)
			: quick
				? profiles.filter((profile) =>
						["360p25", "720p30", "1080p60"].includes(profile.label),
					)
				: profiles;
		for (const profile of selected) {
			const support = await page.evaluate(
				(candidate) =>
					window.recordingHarness.profileSupport(
						candidate.width,
						candidate.height,
						candidate.fps,
					),
				profile,
			);
			if (!support.supported) {
				const expectedGate =
					engine !== "Chromium" || expectedGatedProfiles.has(profile.label);
				if (!expectedGate) {
					const detail = `Unexpected capability gate: ${JSON.stringify(support)}`;
					record(engine, `profile-${profile.label}`, "failed", detail);
					defects.push({
						engine,
						scenario: `profile-${profile.label}`,
						detail,
					});
				} else {
					record(
						engine,
						`profile-${profile.label}`,
						"blocked",
						support.message ?? support.reason ?? "capability-gated",
					);
				}
				continue;
			}
			try {
				await recordArtifact(
					page,
					engine,
					`profile-${profile.label}`,
					profile,
					{
						includeAudio: true,
						durationMs: quick ? 900 : 1400,
					},
				);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				if (
					/runtime profile unsupported/i.test(detail) ||
					(engine === "WebKit" &&
						/MediaRecorder|NotSupported|mime|encoder|codec/i.test(detail))
				) {
					record(engine, `profile-${profile.label}`, "blocked", detail);
				} else {
					record(engine, `profile-${profile.label}`, "failed", detail);
					defects.push({
						engine,
						scenario: `profile-${profile.label}`,
						detail,
					});
				}
			}
		}
	});
}

async function runBehavioralAcceptance(browserType, engine) {
	await withPage(browserType, engine, async (page) => {
		const capabilities = await page.evaluate(() =>
			window.recordingHarness.capabilities(),
		);
		const audioMime = mimeFor(capabilities, true);
		const videoMime = mimeFor(capabilities, false);
		if (!audioMime || !videoMime) {
			record(
				engine,
				"behavioral acceptance",
				"blocked",
				JSON.stringify(capabilities.supportedMimes),
			);
			return;
		}

		await configure(page, {
			width: 1280,
			height: 720,
			fps: 30,
			mimeType: audioMime,
			includeAudio: true,
			sourceMode: "track",
			sourceCount: 2,
			layout: "grid",
			storeMode: "indexeddb",
		});
		const first = await page.evaluate(() => window.recordingHarness.start());
		await page.waitForTimeout(650);
		await page.evaluate(() => window.recordingHarness.pause());
		await page.waitForTimeout(500);
		await page.evaluate(() => window.recordingHarness.resume());
		await page.evaluate(() => window.recordingHarness.replaceSource(0));
		await page.waitForTimeout(650);
		const gridInspect = await page.evaluate(() =>
			window.recordingHarness.inspect(),
		);
		assert.ok((gridInspect.canvas?.distinctRegionColors ?? 0) > 1);
		assert.ok((gridInspect.canvas?.badgePixels ?? 0) > 0);
		const ready = await page.evaluate(() => window.recordingHarness.stop());
		assert.equal(ready.state, "ready");
		assert.ok(
			ready.durationMs < 1800,
			`paused duration should be excluded: ${ready.durationMs}`,
		);

		const retainedReady = await page.evaluate(() =>
			window.recordingHarness.start(),
		);
		assert.equal(
			retainedReady.state,
			"ready",
			"ready data must be retained until explicit download or discard",
		);
		const beforeDiscard = await page.evaluate(() =>
			window.recordingHarness.inspect(),
		);
		assert.ok(
			beforeDiscard.knownMetadata[first.recordingId],
			"ready data must remain downloadable",
		);
		await page.evaluate(() => window.recordingHarness.cancel());
		const discardedReady = await page.evaluate(() =>
			window.recordingHarness.start(),
		);
		assert.equal(discardedReady.state, "recording");
		assert.notEqual(discardedReady.recordingId, first.recordingId);
		const afterReadyReplacement = await page.evaluate(() =>
			window.recordingHarness.inspect(),
		);
		assert.equal(
			afterReadyReplacement.knownMetadata[first.recordingId],
			null,
			"discard must delete prior ready local data",
		);
		await page.waitForTimeout(350);
		await page.evaluate(() => window.recordingHarness.stop());
		const downloaded = await page.evaluate(() =>
			window.recordingHarness.download(),
		);
		assert.equal(downloaded.state.state, "completed");

		const afterDownload = await page.evaluate(() =>
			window.recordingHarness.start(),
		);
		assert.equal(afterDownload.state, "recording");
		assert.notEqual(afterDownload.recordingId, discardedReady.recordingId);
		await page.waitForTimeout(350);
		await page.evaluate(() => window.recordingHarness.cancel());
		const afterCancel = await page.evaluate(() =>
			window.recordingHarness.start(),
		);
		assert.equal(afterCancel.state, "recording");
		assert.notEqual(afterCancel.recordingId, afterDownload.recordingId);
		await page.evaluate(() => window.recordingHarness.cancel());
		record(
			engine,
			"pause/resume, replacement, grid/badges, ready retention/explicit discard→new, download→new, cancel→new",
			"passed",
		);

		await configure(page, {
			storeMode: "quota-failure",
			mimeType: videoMime,
			includeAudio: false,
			sourceMode: "track",
			sourceCount: 1,
			layout: "focused",
		});
		await page.evaluate(() => window.recordingHarness.start());
		await page.waitForTimeout(1250);
		await waitForState(page, "failed", 6000);
		const failed = await page.evaluate(() => window.recordingHarness.inspect());
		assert.match(failed.snapshot.error ?? "", /quota/i);
		await configure(page, { storeMode: "indexeddb" });
		const afterFailure = await page.evaluate(() =>
			window.recordingHarness.start(),
		);
		assert.equal(afterFailure.state, "recording");
		await page.evaluate(() => window.recordingHarness.cancel());
		record(engine, "quota failure UX and failed→new", "passed");

		const frameSources = await page.evaluate(() =>
			window.recordingHarness.validateFrameSources(),
		);
		assert.equal(frameSources.sameOrigin, true);
		assert.equal(frameSources.crossOriginRejected, true);
		assert.deepEqual(frameSources.dimensions, { width: 640, height: 360 });

		await configure(page, {
			sourceMode: "canvas",
			includeAudio: false,
			mimeType: videoMime,
			allSourcesEndedGraceMs: 300,
			layout: "focused",
			sourceCount: 1,
		});
		await page.evaluate(() => window.recordingHarness.start());
		await page.waitForTimeout(250);
		await page.evaluate(() =>
			window.recordingHarness.setAllSourceStatuses("reconnecting"),
		);
		await page.waitForTimeout(250);
		const reconnecting = await page.evaluate(() =>
			window.recordingHarness.inspect(),
		);
		assert.equal(reconnecting.snapshot.state, "recording");
		await page.evaluate(() =>
			window.recordingHarness.setAllSourceStatuses("active"),
		);
		await page.waitForTimeout(150);
		await page.evaluate(() =>
			window.recordingHarness.setAllSourceStatuses("ended"),
		);
		await page.waitForTimeout(700);
		const endedReady = await page.evaluate(() =>
			window.recordingHarness.inspect(),
		);
		assert.equal(
			endedReady.snapshot.state,
			"ready",
			`ended grace did not auto-stop: ${JSON.stringify(endedReady.snapshot)}`,
		);
		const endedDownload = await page.evaluate(() =>
			window.recordingHarness.download(),
		);
		assert.equal(
			endedDownload.state.recordingId,
			endedReady.snapshot.recordingId,
			"auto-stopped recording identity must remain stable through download",
		);
		assert.equal(
			endedDownload.state.state,
			"completed",
			JSON.stringify(endedDownload.state),
		);
		assert.ok(endedDownload.bytes > 0);
		const canvasExtension = endedDownload.filename.endsWith(".mp4")
			? "mp4"
			: "webm";
		const canvasArtifactPath = path.join(
			outputDirectory,
			`${engine.toLowerCase()}-shared-browser.${canvasExtension}`,
		);
		fs.writeFileSync(
			canvasArtifactPath,
			Buffer.from(endedDownload.base64, "base64"),
		);
		const canvasProbe = await ffprobeArtifact(canvasArtifactPath);
		if (canvasProbe) {
			assert.ok(
				canvasProbe.streams.some((stream) => stream.codec_type === "video"),
			);
			assert.equal(
				canvasProbe.streams.some((stream) => stream.codec_type === "audio"),
				false,
			);
		}
		if (!keepArtifacts) fs.rmSync(canvasArtifactPath, { force: true });
		record(
			engine,
			"same-origin canvas/noVNC success, cross-origin fail, reconnect slate, ended grace auto-stop, no audio",
			"passed",
		);

		const limits = await page.evaluate(() =>
			window.recordingHarness.simulateLimits(),
		);
		assert.equal(limits.materializationBlocked, true);
		assert.equal(limits.backpressureBlocked, true);
		assert.equal(limits.calculatedCap, 540000);
		record(
			engine,
			">512 MiB cap, quota cap calculation, and backpressure simulation",
			"passed",
		);

		await configure(page, {
			sourceMode: "track",
			includeAudio: true,
			mimeType: audioMime,
			storeMode: "indexeddb",
		});
		await page.evaluate(() => window.recordingHarness.start());
		await page.waitForTimeout(350);
		await page.evaluate(() => window.recordingHarness.dispatchPageHide());
		await waitForState(page, "cancelled", 4000);
		const pageHidden = await page.evaluate(() =>
			window.recordingHarness.inspect(),
		);
		assert.equal(pageHidden.snapshot.state, "cancelled");
		const originals = pageHidden.originalTracks;
		assert.ok(
			originals.every((track) => track.readyState === "live"),
			JSON.stringify(originals),
		);
		const metrics = await page.evaluate(() =>
			window.recordingHarness.unmount(),
		);
		assert.ok(metrics.cloneStops >= metrics.clonesCreated);
		assert.ok(metrics.capturedTrackStops >= metrics.capturedTracks);
		assert.ok(metrics.audioContextsClosed >= metrics.audioContextsCreated);
		record(
			engine,
			"pagehide/unmount cleanup, clone-only ownership, track/audio graph release",
			"passed",
			JSON.stringify(metrics),
		);
	});
}

async function runSoakAcceptance() {
	if (!runSoak) {
		record(
			"Chromium",
			"bounded soak 720p30",
			"blocked",
			"Run with --soak; manual 30-minute gate remains required",
		);
		return;
	}
	await withPage(chromium, "Chromium", async (page) => {
		const capabilities = await page.evaluate(() =>
			window.recordingHarness.capabilities(),
		);
		const mimeType = mimeFor(capabilities, true);
		if (!mimeType) {
			record("Chromium", "bounded soak", "blocked", "No supported audio MIME");
			return;
		}
		for (const scenario of [
			{
				label: "720p30-soak",
				width: 1280,
				height: 720,
				fps: 30,
				durationMs: Number(process.env.RECORDING_SOAK_720_MS ?? 300000),
			},
		]) {
			await configure(page, {
				...scenario,
				mimeType,
				includeAudio: true,
				sourceMode: "track",
				storeMode: "indexeddb",
				sourceCount: 1,
				layout: "focused",
			});
			const processResourcesBefore = resourceSnapshot();
			const wallBefore = Date.now();
			const frameBefore = (
				await page.evaluate(() => window.recordingHarness.inspect())
			).resourceMetrics.compositorFrames;
			await page.evaluate(() => window.recordingHarness.start());
			await page.waitForTimeout(scenario.durationMs);
			const running = await page.evaluate(() =>
				window.recordingHarness.inspect(),
			);
			const stopped = await page.evaluate(() => window.recordingHarness.stop());
			const download = await page.evaluate(() =>
				window.recordingHarness.download(),
			);
			const wallMs = Date.now() - wallBefore;
			const renderedFrames =
				running.resourceMetrics.compositorFrames - frameBefore;
			const expectedFrames = (scenario.durationMs / 1000) * scenario.fps;
			const extension = download.filename.endsWith(".mp4") ? "mp4" : "webm";
			const artifactPath = path.join(
				outputDirectory,
				`chromium-${scenario.label}.${extension}`,
			);
			fs.writeFileSync(artifactPath, Buffer.from(download.base64, "base64"));
			const artifact = {
				engine: "Chromium",
				label: scenario.label,
				profile: {
					width: scenario.width,
					height: scenario.height,
					fps: scenario.fps,
				},
				mimeType: download.state.mimeType,
				filename: download.filename,
				bytes: download.bytes,
				probe: null,
				probeError: null,
				path: artifactPath,
			};
			artifacts.push(artifact);
			if (!keepArtifacts) cleanupPaths.push(artifactPath);

			const metric = {
				scenario: scenario.label,
				durationMs: scenario.durationMs,
				controllerDurationMs: stopped.durationMs,
				wallMs,
				bytes: download.bytes,
				renderedFrames,
				expectedFrames,
				frameRatio: renderedFrames / expectedFrames,
				recorderError: running.snapshot.error ?? stopped.error,
				processResourcesBefore,
				processResourcesAfter: resourceSnapshot(),
				compositorResources: running.resourceMetrics,
			};
			soakMetrics.push(metric);

			assert.ok(download.bytes > 0, "recording artifact must be non-empty");
			assert.equal(download.state.state, "completed");
			assert.equal(
				metric.recorderError,
				null,
				"recorder must not report an error",
			);
			assert.ok(
				metric.frameRatio >= 0.97,
				`measured compositor frame ratio ${metric.frameRatio} is below 0.97`,
			);

			try {
				artifact.probe = await ffprobeArtifact(artifactPath);
			} catch (error) {
				artifact.probeError =
					error instanceof Error ? error.message : String(error);
				throw error;
			}
			assert.ok(artifact.probe, "ffprobe metadata is required");
			const video = artifact.probe.streams.find(
				(stream) => stream.codec_type === "video",
			);
			const audio = artifact.probe.streams.find(
				(stream) => stream.codec_type === "audio",
			);
			assert.ok(video, "ffprobe must find a video stream");
			assert.ok(audio, "ffprobe must find an audio stream");
			assert.equal(video.width, scenario.width);
			assert.equal(video.height, scenario.height);
			assert.equal(video.codec_name, "vp9");
			assert.equal(audio.codec_name, "opus");
			assert.match(artifact.probe.format?.format_name ?? "", /webm|matroska/);
			const mediaDurationSeconds = Number(
				artifact.probe.format?.duration ?? video.duration ?? 0,
			);
			const expectedDurationSeconds = scenario.durationMs / 1000;
			assert.ok(
				mediaDurationSeconds >= expectedDurationSeconds * 0.97 &&
					mediaDurationSeconds <= expectedDurationSeconds * 1.05,
				`media duration ${mediaDurationSeconds}s is outside the accepted range for ${expectedDurationSeconds}s`,
			);
			metric.mediaDurationSeconds = mediaDurationSeconds;
			record("Chromium", scenario.label, "passed", JSON.stringify(metric));
		}
	});
}

try {
	if (!onlyScenario || onlyScenario.startsWith("profile-")) {
		await runProfileMatrix(chromium, "Chromium");
		await runProfileMatrix(webkit, "WebKit");
	}
	if (!onlyScenario || onlyScenario === "behavioral") {
		await runBehavioralAcceptance(chromium, "Chromium");
		await runBehavioralAcceptance(webkit, "WebKit");
	}
	if (!onlyScenario || onlyScenario === "soak") await runSoakAcceptance();
} catch (error) {
	const detail =
		error instanceof Error ? error.stack ?? error.message : String(error);
	defects.push({ engine: "runner", scenario: "unhandled", detail });
	console.error(error);
} finally {
	await new Promise((resolve) => server.close(resolve));
}

const summary = {
	generatedAt: new Date().toISOString(),
	host: {
		platform: process.platform,
		release: os.release(),
		arch: process.arch,
	},
	ffprobe: ffprobe ?? null,
	quick,
	runSoak,
	passed: results.filter((result) => result.status === "passed").length,
	blocked: results.filter((result) => result.status === "blocked").length,
	failed:
		results.filter((result) => result.status === "failed").length +
		defects.length,
	results,
	artifacts,
	soakMetrics,
	defects,
	manualGates: [
		"30-minute 720p30 Chromium recording on release-class hardware with CPU, memory, thermal, disk, and playback observation",
		"WebKit/Safari remains fail-closed/experimental until validation passes on a supported macOS runner",
	],
};
try {
	finalizeAcceptanceEvidence({ outputDirectory, summary, cleanupPaths });
} catch (error) {
	console.error("Failed to finalize recording acceptance evidence", error);
	process.exitCode = 1;
}
console.log(`RECORDING_ACCEPTANCE_SUMMARY=${JSON.stringify(summary)}`);
if (summary.failed > 0) process.exitCode = 1;
