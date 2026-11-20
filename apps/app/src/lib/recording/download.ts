import {
	type RecordingChunkStore,
	type RecordingStreamWriter,
	assertBlobMaterializationAllowed,
	materializeRecordingBlob,
} from "./chunk-store";

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
	"video/webm": "webm",
	"video/mp4": "mp4",
};

export function recordingExtensionForMime(mimeType: string): string {
	const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return MIME_EXTENSIONS[normalized] ?? "webm";
}

export function sanitizeRecordingFilename(
	name: string,
	mimeType: string,
	fallback = "ollashare-recording",
): string {
	const extension = recordingExtensionForMime(mimeType);
	const withoutExtension = name.trim().replace(/\.(webm|mp4)$/i, "");
	const sanitized = Array.from(withoutExtension.normalize("NFKC"))
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 || '<>:"/\\|?*'.includes(character)
				? "-"
				: character;
		})
		.join("")
		.replace(/[. ]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	const base = sanitized || fallback;
	return `${base}.${extension}`;
}

export interface RecordingDownloadOptions {
	store: RecordingChunkStore;
	recordingId: string;
	mimeType: string;
	filename: string;
	writer?: RecordingStreamWriter;
	document?: Pick<Document, "createElement" | "body">;
	urlApi?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
}

export async function downloadRecording(
	options: RecordingDownloadOptions,
): Promise<{ filename: string; bytes: number; streamed: boolean }> {
	const metadata = await options.store.getMetadata(options.recordingId);
	if (!metadata) throw new Error("Recording metadata was not found");
	const filename = sanitizeRecordingFilename(
		options.filename,
		options.mimeType,
	);
	if (options.writer) {
		try {
			for await (const chunk of options.store.iterate(options.recordingId)) {
				await options.writer.write(
					new Uint8Array(await chunk.blob.arrayBuffer()),
				);
			}
			await options.writer.close();
			return { filename, bytes: metadata.totalBytes, streamed: true };
		} catch (error) {
			await options.writer.abort?.(error);
			throw error;
		}
	}

	assertBlobMaterializationAllowed(metadata.totalBytes);
	const blob = await materializeRecordingBlob(
		options.store,
		options.recordingId,
		options.mimeType,
	);
	const documentApi = options.document ?? globalThis.document;
	const urlApi = options.urlApi ?? globalThis.URL;
	if (!documentApi || !urlApi)
		throw new Error("Browser download APIs are unavailable");
	const objectUrl = urlApi.createObjectURL(blob);
	try {
		const link = documentApi.createElement("a");
		link.href = objectUrl;
		link.download = filename;
		link.rel = "noopener";
		link.style.display = "none";
		documentApi.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		setTimeout(() => urlApi.revokeObjectURL(objectUrl), 0);
	}
	return { filename, bytes: blob.size, streamed: false };
}
