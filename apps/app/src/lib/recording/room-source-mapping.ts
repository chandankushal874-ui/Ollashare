import type { AnnotationStroke } from "../annotation-types";
import type { RecordingSourceInput } from "./source-registry";
import type { LocalRecordingAnnotations } from "./use-local-recording";

export interface RoomRecordingScreenSource {
	id: string;
	deviceName: string;
	ownerId: string;
	ownerName: string;
	stream: MediaStream | null;
	liveKitTrack?: { mediaStreamTrack?: MediaStreamTrack | null } | null;
	isLive: boolean;
}

export interface RoomRecordingScreenAudioSource {
	participantIdentity: string;
	mediaStreamTrack: MediaStreamTrack | null;
}

export function mapRoomRecordingSources(
	screenSources: readonly RoomRecordingScreenSource[],
	liveKitScreenAudioTracks: readonly RoomRecordingScreenAudioSource[] = [],
): RecordingSourceInput[] {
	const liveKitAudioByOwner = new Map<string, MediaStreamTrack[]>();
	for (const audio of liveKitScreenAudioTracks) {
		if (!audio.mediaStreamTrack || audio.mediaStreamTrack.kind !== "audio")
			continue;
		const tracks = liveKitAudioByOwner.get(audio.participantIdentity) ?? [];
		tracks.push(audio.mediaStreamTrack);
		liveKitAudioByOwner.set(audio.participantIdentity, tracks);
	}
	return screenSources
		.map((source): RecordingSourceInput | null => {
			const videoTrack =
				source.liveKitTrack?.mediaStreamTrack ??
				source.stream?.getVideoTracks()[0] ??
				null;
			if (!videoTrack || videoTrack.kind !== "video") return null;
			const streamAudio = source.stream?.getAudioTracks() ?? [];
			const liveKitAudio = liveKitAudioByOwner.get(source.ownerId) ?? [];
			const audioTracks = Array.from(
				new Map(
					[...streamAudio, ...liveKitAudio]
						.filter((track) => track.kind === "audio")
						.map((track) => [track.id, track] as const),
				).values(),
			);
			return {
				id: source.id,
				owner: {
					id: source.ownerId,
					name: source.ownerName || source.deviceName || "Participant",
				},
				videoTrack,
				audioTracks,
				status:
					videoTrack.readyState === "ended"
						? "ended"
						: source.isLive
							? "active"
							: "reconnecting",
			};
		})
		.filter((source): source is RecordingSourceInput => source !== null)
		.sort((left, right) => left.id.localeCompare(right.id));
}

export function buildRoomRecordingAnnotations(
	sourceIds: readonly string[],
	committed: Readonly<Record<string, readonly AnnotationStroke[]>> = {},
	drafts: Readonly<Record<string, AnnotationStroke | null>> = {},
): LocalRecordingAnnotations {
	return Object.fromEntries(
		sourceIds.map((sourceId) => [
			sourceId,
			{ committed: committed[sourceId] ?? [], draft: drafts[sourceId] ?? null },
		]),
	);
}
