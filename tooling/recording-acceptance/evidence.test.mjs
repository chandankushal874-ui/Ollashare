import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DEFAULT_FFPROBE_TIMEOUT_MS,
	FFPROBE_METADATA_ARGUMENTS,
	finalizeAcceptanceEvidence,
	probeArtifactMetadata,
} from "./evidence.mjs";

test("metadata probing omits full frame counting and uses the realistic timeout", async () => {
	let invocation;
	const probe = await probeArtifactMetadata({
		ffprobePath: "/usr/bin/ffprobe",
		filePath: "/tmp/recording.webm",
		execFileAsync: async (executable, arguments_, options) => {
			invocation = { executable, arguments_, options };
			return {
				stdout: JSON.stringify({
					format: { format_name: "matroska,webm", duration: "1800.0" },
					streams: [],
				}),
			};
		},
	});

	assert.equal(invocation.executable, "/usr/bin/ffprobe");
	assert.deepEqual(invocation.arguments_, [
		...FFPROBE_METADATA_ARGUMENTS,
		"/tmp/recording.webm",
	]);
	assert.equal(invocation.arguments_.includes("-count_frames"), false);
	assert.equal(invocation.options.timeout, DEFAULT_FFPROBE_TIMEOUT_MS);
	assert.equal(probe.format.duration, "1800.0");
});

test("metadata probing reports timeout termination clearly", async () => {
	const timeout = Object.assign(new Error("Command timed out"), {
		code: "ETIMEDOUT",
		signal: "SIGTERM",
		killed: true,
	});
	await assert.rejects(
		probeArtifactMetadata({
			ffprobePath: "/usr/bin/ffprobe",
			filePath: "/tmp/recording.webm",
			timeoutMs: 3210,
			execFileAsync: async () => {
				throw timeout;
			},
		}),
		(error) => {
			assert.match(error.message, /3210ms timeout budget/);
			assert.match(error.message, /ETIMEDOUT/);
			assert.match(error.message, /SIGTERM/);
			assert.match(error.message, /killed=true/);
			return true;
		},
	);
});

test("summary, resource metrics, and checksums finalize before cleanup after a probe failure", () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "mira-recording-evidence-"),
	);
	const artifactPath = path.join(directory, "recording.webm");
	fs.writeFileSync(artifactPath, "valid-media-placeholder");
	const summary = {
		failed: 1,
		artifacts: [
			{
				path: artifactPath,
				bytes: fs.statSync(artifactPath).size,
				probe: null,
				probeError:
					"ffprobe metadata probe failed after a 120000ms timeout budget",
			},
		],
		soakMetrics: [
			{
				renderedFrames: 52_500,
				expectedFrames: 54_000,
				frameRatio: 52_500 / 54_000,
			},
		],
	};

	try {
		const finalized = finalizeAcceptanceEvidence({
			outputDirectory: directory,
			summary,
			cleanupPaths: [artifactPath],
		});
		assert.equal(fs.existsSync(artifactPath), false);
		assert.equal(fs.existsSync(finalized.summaryPath), true);
		assert.equal(fs.existsSync(finalized.resourceMetricsPath), true);
		assert.equal(fs.existsSync(finalized.checksumsPath), true);

		const retainedSummary = JSON.parse(
			fs.readFileSync(finalized.summaryPath, "utf8"),
		);
		assert.match(retainedSummary.artifacts[0].probeError, /ffprobe metadata/);
		assert.match(retainedSummary.artifacts[0].sha256, /^[a-f0-9]{64}$/);
		assert.match(
			fs.readFileSync(finalized.checksumsPath, "utf8"),
			/recording\.webm/,
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
