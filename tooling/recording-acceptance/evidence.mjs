import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_FFPROBE_TIMEOUT_MS = 120_000;

export const FFPROBE_METADATA_ARGUMENTS = [
	"-v",
	"error",
	"-show_entries",
	"format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,nb_frames",
	"-of",
	"json",
];

export async function probeArtifactMetadata({
	ffprobePath,
	filePath,
	execFileAsync,
	timeoutMs = DEFAULT_FFPROBE_TIMEOUT_MS,
}) {
	if (!ffprobePath) return null;
	try {
		const { stdout } = await execFileAsync(
			ffprobePath,
			[...FFPROBE_METADATA_ARGUMENTS, filePath],
			{ maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
		);
		return JSON.parse(stdout);
	} catch (error) {
		const details = [
			error instanceof Error ? error.message : String(error),
			error?.code ? `code=${error.code}` : null,
			error?.signal ? `signal=${error.signal}` : null,
			error?.killed ? "killed=true" : null,
		].filter(Boolean);
		throw new Error(
			`ffprobe metadata probe failed after a ${timeoutMs}ms timeout budget: ${details.join(", ")}`,
			{ cause: error },
		);
	}
}

export function sha256File(filePath, fsImpl = fs) {
	const hash = createHash("sha256");
	hash.update(fsImpl.readFileSync(filePath));
	return hash.digest("hex");
}

function writeAtomicJson(filePath, value, fsImpl) {
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
	fsImpl.renameSync(temporaryPath, filePath);
}

export function finalizeAcceptanceEvidence({
	outputDirectory,
	summary,
	cleanupPaths = [],
	fsImpl = fs,
}) {
	fsImpl.mkdirSync(outputDirectory, { recursive: true });
	const summaryPath = path.join(outputDirectory, "summary.json");
	const resourceMetricsPath = path.join(
		outputDirectory,
		"resource-metrics.json",
	);
	const checksumsPath = path.join(outputDirectory, "checksums.sha256");
	const artifactChecksums = [];

	try {
		for (const artifact of summary.artifacts ?? []) {
			if (!artifact.path || !fsImpl.existsSync(artifact.path)) continue;
			artifact.sha256 = sha256File(artifact.path, fsImpl);
			artifactChecksums.push({ path: artifact.path, sha256: artifact.sha256 });
		}

		writeAtomicJson(resourceMetricsPath, summary.soakMetrics ?? [], fsImpl);
		writeAtomicJson(summaryPath, summary, fsImpl);

		const checksumRows = [
			`${sha256File(summaryPath, fsImpl)}  summary.json`,
			`${sha256File(resourceMetricsPath, fsImpl)}  resource-metrics.json`,
			...artifactChecksums.map(
				(entry) => `${entry.sha256}  ${path.basename(entry.path)}`,
			),
		];
		fsImpl.writeFileSync(checksumsPath, `${checksumRows.join("\n")}\n`);
		return {
			summaryPath,
			resourceMetricsPath,
			checksumsPath,
			artifactChecksums,
		};
	} finally {
		for (const cleanupPath of cleanupPaths) {
			fsImpl.rmSync(cleanupPath, { force: true });
		}
	}
}
