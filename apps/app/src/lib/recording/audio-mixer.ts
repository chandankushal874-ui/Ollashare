export interface RecordingAudioInput {
	/** Stable logical source id; track identity is still deduplicated by original track id. */
	sourceId: string;
	track: MediaStreamTrack;
	gain?: number;
}

export interface AudioMixerDependencies {
	createAudioContext?: () => AudioContext;
	createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

interface MixedInput {
	sourceId: string;
	originalTrack: MediaStreamTrack;
	clonedTrack: MediaStreamTrack;
	sourceNode: MediaStreamAudioSourceNode;
	gainNode: GainNode;
	removeEndedListener: () => void;
}

/**
 * Mixes cloned screen-share audio into a recorder-only destination. The graph is
 * deliberately never connected to AudioContext.destination, preventing feedback.
 */
export class RecordingAudioMixer {
	private readonly createAudioContext: () => AudioContext;
	private readonly createMediaStream: (
		tracks: MediaStreamTrack[],
	) => MediaStream;
	private readonly inputs = new Map<string, MixedInput>();
	private context: AudioContext | null = null;
	private destination: MediaStreamAudioDestinationNode | null = null;
	private closed = false;

	constructor(dependencies: AudioMixerDependencies = {}) {
		this.createAudioContext =
			dependencies.createAudioContext ?? (() => new AudioContext());
		this.createMediaStream =
			dependencies.createMediaStream ?? ((tracks) => new MediaStream(tracks));
	}

	/** Must be called from a user gesture before recording starts. */
	async initializeFromUserGesture(): Promise<MediaStream> {
		this.assertOpen();
		if (!this.context) {
			this.context = this.createAudioContext();
			this.destination = this.context.createMediaStreamDestination();
		}
		if (this.context.state === "suspended") await this.context.resume();
		const destination = this.destination;
		if (!destination)
			throw new Error("Recording audio destination was not created");
		return destination.stream;
	}

	get stream(): MediaStream | null {
		return this.destination?.stream ?? null;
	}

	get size(): number {
		return this.inputs.size;
	}

	async add(input: RecordingAudioInput): Promise<boolean> {
		if (input.track.kind !== "audio" || input.track.readyState === "ended")
			return false;
		await this.initializeFromUserGesture();
		if (this.inputs.has(input.track.id)) return false;
		const clonedTrack = input.track.clone();
		const context = this.context;
		const destination = this.destination;
		if (!context || !destination)
			throw new Error("Recording audio mixer is not initialized");
		const sourceNode = context.createMediaStreamSource(
			this.createMediaStream([clonedTrack]),
		);
		const gainNode = context.createGain();
		gainNode.gain.value = Math.max(0, Math.min(4, input.gain ?? 1));
		sourceNode.connect(gainNode);
		gainNode.connect(destination);
		const onEnded = () => this.removeByTrackId(input.track.id);
		input.track.addEventListener("ended", onEnded);
		this.inputs.set(input.track.id, {
			sourceId: input.sourceId,
			originalTrack: input.track,
			clonedTrack,
			sourceNode,
			gainNode,
			removeEndedListener: () =>
				input.track.removeEventListener("ended", onEnded),
		});
		return true;
	}

	async replaceSource(
		sourceId: string,
		tracks: readonly MediaStreamTrack[],
	): Promise<void> {
		this.removeSource(sourceId);
		for (const track of tracks) await this.add({ sourceId, track });
	}

	removeByTrackId(trackId: string): boolean {
		const input = this.inputs.get(trackId);
		if (!input) return false;
		this.inputs.delete(trackId);
		this.disposeInput(input);
		return true;
	}

	removeSource(sourceId: string): number {
		let removed = 0;
		for (const [trackId, input] of this.inputs) {
			if (input.sourceId !== sourceId) continue;
			this.inputs.delete(trackId);
			this.disposeInput(input);
			removed += 1;
		}
		return removed;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const input of this.inputs.values()) this.disposeInput(input);
		this.inputs.clear();
		for (const track of this.destination?.stream.getTracks() ?? [])
			track.stop();
		this.destination = null;
		const context = this.context;
		this.context = null;
		if (context && context.state !== "closed") await context.close();
	}

	private disposeInput(input: MixedInput): void {
		input.removeEndedListener();
		try {
			input.sourceNode.disconnect();
			input.gainNode.disconnect();
		} catch {
			// Disconnection is idempotent in modern browsers but mocks may throw.
		}
		input.clonedTrack.stop();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Recording audio mixer is closed");
	}
}
