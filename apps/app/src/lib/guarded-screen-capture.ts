import type { LocalParticipant } from "livekit-client";

export function stopCapturedStream(stream: MediaStream) {
    stream.getTracks().forEach((track) => track.stop());
}

/** Check access again after the native picker, before any stream can publish. */
export async function captureDisplayIfAllowed(
    allowed: () => boolean,
    options: DisplayMediaStreamOptions,
): Promise<MediaStream | null> {
    if (!allowed()) return null;
    const stream = await navigator.mediaDevices.getDisplayMedia(options);
    if (!allowed()) {
        stopCapturedStream(stream);
        return null;
    }
    return stream;
}

/** LiveKit's setScreenShareEnabled captures AND publishes internally. Split the
 * supported SDK APIs to enforce the same post-picker guard as the mesh path. */
export async function publishScreenIfAllowed(
    participant: LocalParticipant,
    options: Parameters<LocalParticipant["createScreenTracks"]>[0],
    allowed: () => boolean,
) {
    if (!allowed()) throw new Error("Screen sharing is no longer allowed.");
    const tracks = await participant.createScreenTracks(options);
    try {
        for (const track of tracks) {
            if (!allowed()) throw new Error("Screen sharing is no longer allowed.");
            await participant.publishTrack(track, { source: track.source });
            if (!allowed()) throw new Error("Screen sharing is no longer allowed.");
        }
    } catch (error) {
        tracks.forEach((track) => track.stop());
        await Promise.allSettled(tracks.map((track) => participant.unpublishTrack(track)));
        throw error;
    }
}
