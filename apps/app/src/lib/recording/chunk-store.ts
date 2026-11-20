export const MAX_CHUNK_QUEUE_BYTES = 64 * 1024 * 1024;
export const MAX_INDEXED_DB_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BLOB_MATERIALIZATION_BYTES = 512 * 1024 * 1024;
export const MAX_RECORDING_DURATION_MS = 2 * 60 * 60 * 1000;

export interface RecordingChunkMetadata {
	recordingId: string;
	mimeType: string;
	createdAt: number;
	updatedAt: number;
	chunkCount: number;
	totalBytes: number;
	status: "writing" | "ready" | "cancelled" | "failed";
}

export interface RecordingChunk {
	index: number;
	blob: Blob;
	size: number;
	createdAt: number;
}

export interface RecordingChunkStore {
	initialize(metadata: RecordingChunkMetadata): Promise<void>;
	append(recordingId: string, chunk: RecordingChunk): Promise<void>;
	finalize(
		recordingId: string,
		status?: RecordingChunkMetadata["status"],
	): Promise<void>;
	getMetadata(recordingId: string): Promise<RecordingChunkMetadata | null>;
	iterate(recordingId: string): AsyncIterable<RecordingChunk>;
	delete(recordingId: string): Promise<void>;
}

export interface RecordingStreamWriter {
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
	abort?(reason?: unknown): Promise<void>;
}

export function calculateIndexedDbRecordingCap(
	estimate: Pick<StorageEstimate, "quota" | "usage">,
): number {
	const quota = Math.max(0, estimate.quota ?? 0);
	const usage = Math.max(0, estimate.usage ?? 0);
	const available = Math.max(0, quota - usage);
	return Math.floor(Math.min(MAX_INDEXED_DB_BYTES, available * 0.6));
}

export async function estimateIndexedDbRecordingCap(
	storageManager: Pick<StorageManager, "estimate"> | undefined = globalThis
		.navigator?.storage,
): Promise<number> {
	if (!storageManager?.estimate) return 0;
	try {
		return calculateIndexedDbRecordingCap(await storageManager.estimate());
	} catch {
		return 0;
	}
}

export function assertBlobMaterializationAllowed(totalBytes: number): void {
	if (totalBytes > MAX_BLOB_MATERIALIZATION_BYTES) {
		throw new Error("Recording is too large for bounded Blob materialization");
	}
}

export async function materializeRecordingBlob(
	store: RecordingChunkStore,
	recordingId: string,
	mimeType: string,
): Promise<Blob> {
	const metadata = await store.getMetadata(recordingId);
	const totalBytes = metadata?.totalBytes ?? 0;
	assertBlobMaterializationAllowed(totalBytes);
	const chunks: Blob[] = [];
	let observedBytes = 0;
	for await (const chunk of store.iterate(recordingId)) {
		observedBytes += chunk.size;
		assertBlobMaterializationAllowed(observedBytes);
		chunks.push(chunk.blob);
	}
	return new Blob(chunks, { type: mimeType });
}

export class BoundedChunkWriteQueue {
	private pendingBytes = 0;
	private tail = Promise.resolve();
	private failed: unknown = null;

	constructor(
		private readonly store: RecordingChunkStore,
		readonly maxPendingBytes = MAX_CHUNK_QUEUE_BYTES,
	) {}

	get bytesPending(): number {
		return this.pendingBytes;
	}

	enqueue(recordingId: string, chunk: RecordingChunk): Promise<void> {
		if (this.failed) return Promise.reject(this.failed);
		if (
			chunk.size > this.maxPendingBytes ||
			this.pendingBytes + chunk.size > this.maxPendingBytes
		) {
			return Promise.reject(
				new Error("Recording chunk persistence backpressure limit exceeded"),
			);
		}
		this.pendingBytes += chunk.size;
		const write = this.tail.then(() => this.store.append(recordingId, chunk));
		this.tail = write
			.catch((error) => {
				this.failed = error;
			})
			.then(() => {
				this.pendingBytes -= chunk.size;
			});
		return write;
	}

	async flush(): Promise<void> {
		await this.tail;
		if (this.failed) throw this.failed;
	}
}

export class InMemoryRecordingChunkStore implements RecordingChunkStore {
	private readonly metadata = new Map<string, RecordingChunkMetadata>();
	private readonly chunks = new Map<string, RecordingChunk[]>();

	async initialize(metadata: RecordingChunkMetadata): Promise<void> {
		this.metadata.set(metadata.recordingId, { ...metadata });
		this.chunks.set(metadata.recordingId, []);
	}

	async append(recordingId: string, chunk: RecordingChunk): Promise<void> {
		const metadata = this.metadata.get(recordingId);
		const chunks = this.chunks.get(recordingId);
		if (!metadata || !chunks)
			throw new Error("Recording chunk store is not initialized");
		if (chunk.index !== chunks.length)
			throw new Error("Recording chunks must be appended in order");
		chunks.push({ ...chunk });
		metadata.chunkCount += 1;
		metadata.totalBytes += chunk.size;
		metadata.updatedAt = chunk.createdAt;
	}

	async finalize(
		recordingId: string,
		status: RecordingChunkMetadata["status"] = "ready",
	): Promise<void> {
		const metadata = this.metadata.get(recordingId);
		if (!metadata) return;
		metadata.status = status;
		metadata.updatedAt = Date.now();
	}

	async getMetadata(
		recordingId: string,
	): Promise<RecordingChunkMetadata | null> {
		const metadata = this.metadata.get(recordingId);
		return metadata ? { ...metadata } : null;
	}

	async *iterate(recordingId: string): AsyncIterable<RecordingChunk> {
		for (const chunk of this.chunks.get(recordingId) ?? []) yield { ...chunk };
	}

	async delete(recordingId: string): Promise<void> {
		this.metadata.delete(recordingId);
		this.chunks.delete(recordingId);
	}
}

interface IndexedDbChunkRow {
	recordingId: string;
	index: number;
	blob: Blob;
	size: number;
	createdAt: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

export class IndexedDbRecordingChunkStore implements RecordingChunkStore {
	private databasePromise: Promise<IDBDatabase> | null = null;

	constructor(
		private readonly indexedDb: IDBFactory = indexedDB,
		private readonly databaseName = "mira-local-recordings-v1",
	) {}

	async initialize(metadata: RecordingChunkMetadata): Promise<void> {
		const database = await this.database();
		const transaction = database.transaction(
			["recordings", "chunks"],
			"readwrite",
		);
		transaction.objectStore("recordings").put(metadata);
		const index = transaction.objectStore("chunks").index("by_recording");
		const cursorRequest = index.openKeyCursor(
			IDBKeyRange.only(metadata.recordingId),
		);
		cursorRequest.onsuccess = () => {
			const cursor = cursorRequest.result;
			if (!cursor) return;
			transaction.objectStore("chunks").delete(cursor.primaryKey);
			cursor.continue();
		};
		await transactionComplete(transaction);
	}

	async append(recordingId: string, chunk: RecordingChunk): Promise<void> {
		const database = await this.database();
		const transaction = database.transaction(
			["recordings", "chunks"],
			"readwrite",
		);
		const metadataStore = transaction.objectStore("recordings");
		const metadata = (await requestResult(metadataStore.get(recordingId))) as
			| RecordingChunkMetadata
			| undefined;
		if (!metadata) {
			transaction.abort();
			throw new Error("Recording chunk store is not initialized");
		}
		if (chunk.index !== metadata.chunkCount) {
			transaction.abort();
			throw new Error("Recording chunks must be appended in order");
		}
		const row: IndexedDbChunkRow = { recordingId, ...chunk };
		transaction.objectStore("chunks").add(row);
		metadataStore.put({
			...metadata,
			chunkCount: metadata.chunkCount + 1,
			totalBytes: metadata.totalBytes + chunk.size,
			updatedAt: chunk.createdAt,
		});
		await transactionComplete(transaction);
	}

	async finalize(
		recordingId: string,
		status: RecordingChunkMetadata["status"] = "ready",
	): Promise<void> {
		const database = await this.database();
		const transaction = database.transaction("recordings", "readwrite");
		const store = transaction.objectStore("recordings");
		const metadata = (await requestResult(store.get(recordingId))) as
			| RecordingChunkMetadata
			| undefined;
		if (metadata) store.put({ ...metadata, status, updatedAt: Date.now() });
		await transactionComplete(transaction);
	}

	async getMetadata(
		recordingId: string,
	): Promise<RecordingChunkMetadata | null> {
		const database = await this.database();
		const transaction = database.transaction("recordings", "readonly");
		const result = (await requestResult(
			transaction.objectStore("recordings").get(recordingId),
		)) as RecordingChunkMetadata | undefined;
		return result ?? null;
	}

	async *iterate(recordingId: string): AsyncIterable<RecordingChunk> {
		const database = await this.database();
		const transaction = database.transaction("chunks", "readonly");
		const index = transaction.objectStore("chunks").index("by_recording_index");
		const range = IDBKeyRange.bound(
			[recordingId, 0],
			[recordingId, Number.MAX_SAFE_INTEGER],
		);
		const rows = (await requestResult(
			index.getAll(range),
		)) as IndexedDbChunkRow[];
		for (const row of rows.sort((left, right) => left.index - right.index)) {
			yield {
				index: row.index,
				blob: row.blob,
				size: row.size,
				createdAt: row.createdAt,
			};
		}
	}

	async delete(recordingId: string): Promise<void> {
		const database = await this.database();
		const transaction = database.transaction(
			["recordings", "chunks"],
			"readwrite",
		);
		transaction.objectStore("recordings").delete(recordingId);
		const index = transaction.objectStore("chunks").index("by_recording");
		const request = index.openKeyCursor(IDBKeyRange.only(recordingId));
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			transaction.objectStore("chunks").delete(cursor.primaryKey);
			cursor.continue();
		};
		await transactionComplete(transaction);
	}

	private database(): Promise<IDBDatabase> {
		if (this.databasePromise) return this.databasePromise;
		this.databasePromise = new Promise((resolve, reject) => {
			const request = this.indexedDb.open(this.databaseName, 1);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains("recordings")) {
					database.createObjectStore("recordings", { keyPath: "recordingId" });
				}
				if (!database.objectStoreNames.contains("chunks")) {
					const chunks = database.createObjectStore("chunks", {
						keyPath: ["recordingId", "index"],
					});
					chunks.createIndex("by_recording", "recordingId", { unique: false });
					chunks.createIndex("by_recording_index", ["recordingId", "index"], {
						unique: true,
					});
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(request.error ?? new Error("IndexedDB open failed"));
		});
		return this.databasePromise;
	}
}
