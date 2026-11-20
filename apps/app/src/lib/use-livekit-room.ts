"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ConnectionState,
	type LocalTrackPublication,
	type RemoteParticipant,
	type RemoteTrack,
	type RemoteTrackPublication,
	Room,
	type RoomConnectOptions,
	RoomEvent,
	Track,
	type TrackPublishOptions,
	VideoPreset,
} from "livekit-client";
import { buildRtcConfiguration } from "./ice";
import type { StreamingResolution } from "./media-profiles";
import {
	resolveAdaptiveScreenLayers,
	resolveOfferedMediaFps,
	resolveStreamingProfile,
} from "./media-profiles";
import { enforcePublishedVideoFps } from "./mira-webrtc";

export interface LiveKitTrackInfo {
	id: string;
	participantIdentity: string;
	participantName: string;
	source: Track.Source;
	track: Track;
	isLocal: boolean;
}

export interface LiveKitScreenAudioTrackInfo extends LiveKitTrackInfo {
	source: Track.Source.ScreenShareAudio;
	mediaStreamTrack: MediaStreamTrack | null;
}

export interface ScreenShareCaptureOptions {
	resolution?: StreamingResolution | string;
	fps?: number;
	audio?: boolean;
	bitrateKbps?: number;
	codec?: "AV1" | "VP9" | "H.264";
}

export interface BuildLiveKitConnectOptionsParams {
	rtcConfig?: RTCConfiguration;
	autoSubscribe?: boolean;
}

/**
 * Builds LiveKit RoomConnectOptions wired with RFC 8656 / RFC 7635 TURN ICE servers.
 */
export function buildLiveKitConnectOptions(
	params?: BuildLiveKitConnectOptionsParams,
): RoomConnectOptions {
	return {
		autoSubscribe: params?.autoSubscribe ?? true,
		rtcConfig: params?.rtcConfig ?? buildRtcConfiguration(),
	};
}

export interface UseLiveKitRoomOptions {
	roomCode?: string | null;
	serverUrl?: string | null;
	token?: string | null;
	enabled?: boolean;
	heartbeatIntervalMs?: number;
	rtcConfig?: RTCConfiguration;
	onConnected?: () => void;
	onHeartbeat?: () => void;
	onDisconnected?: (reason?: unknown) => void;
	onError?: (err: Error) => void;
	onTokenExpiring?: () => void;
	tokenRefreshIntervalMs?: number;
}

/**
 * Maps high-level resolution and FPS options into public LiveKit 2.22.4 options.
 */
export function mapScreenCaptureOptions(opts?: ScreenShareCaptureOptions) {
	const profile = resolveStreamingProfile(opts?.resolution, opts?.fps);
	return {
		audio: opts?.audio ?? true,
		resolution: {
			width: profile.width,
			height: profile.height,
			frameRate: profile.fps,
		},
		contentHint: "detail" as const,
	};
}

async function enforceLocalScreenShareFps(
	room: Room,
	fps: number,
): Promise<boolean> {
	const publication = room.localParticipant.getTrackPublication(
		Track.Source.ScreenShare,
	) as LocalTrackPublication | undefined;
	const localTrack = publication?.videoTrack;
	return enforcePublishedVideoFps(
		localTrack?.mediaStreamTrack ?? null,
		localTrack?.sender ? [localTrack.sender] : [],
		fps,
	);
}

export function mapScreenPublishOptions(
	opts?: ScreenShareCaptureOptions,
): TrackPublishOptions {
	const profile = resolveStreamingProfile(opts?.resolution, opts?.fps);
	const fps = resolveOfferedMediaFps(profile.fps, 60);
	const codec =
		opts?.codec === "AV1" ? "av1" : opts?.codec === "VP9" ? "vp9" : "h264";
	const adaptiveLayers = resolveAdaptiveScreenLayers(
		profile.resolution,
		fps,
	).map(
		(layer) =>
			new VideoPreset({
				width: layer.width,
				height: layer.height,
				maxBitrate: layer.bitrateKbps * 1000,
				maxFramerate: layer.fps,
			}),
	);
	return {
		videoCodec: codec,
		simulcast: adaptiveLayers.length > 0,
		screenShareEncoding: {
			maxBitrate: (opts?.bitrateKbps ?? profile.bitrateKbps) * 1000,
			maxFramerate: profile.fps,
		},
		screenShareSimulcastLayers: adaptiveLayers,
		degradationPreference: "maintain-resolution",
	};
}

/**
 * Filter tracks by source (e.g. screen_share or camera)
 */
export function filterTracksBySource(
	tracks: LiveKitTrackInfo[],
	source: Track.Source,
): LiveKitTrackInfo[] {
	return tracks.filter((t) => t.source === source);
}

export function mapLiveKitScreenAudioTracks(
	tracks: LiveKitTrackInfo[],
): LiveKitScreenAudioTrackInfo[] {
	return tracks
		.filter(
			(
				track,
			): track is LiveKitTrackInfo & {
				source: Track.Source.ScreenShareAudio;
			} => track.source === Track.Source.ScreenShareAudio,
		)
		.map((track) => ({
			...track,
			mediaStreamTrack: track.track.mediaStreamTrack ?? null,
		}));
}

export function resolveLiveKitDataSenderIdentity(
	participant: Readonly<{ identity?: string }> | undefined,
	packetIdentity: string | undefined,
): string | undefined {
	const participantIdentity = participant?.identity || undefined;
	const dataPacketIdentity = packetIdentity || undefined;
	if (
		participantIdentity &&
		dataPacketIdentity &&
		participantIdentity !== dataPacketIdentity
	)
		return undefined;
	return participantIdentity ?? dataPacketIdentity;
}

/**
 * React hook to manage a connection to a LiveKit SFU media room.
 */
export function useLiveKitRoom({
	roomCode,
	serverUrl,
	token,
	enabled = true,
	heartbeatIntervalMs = 0,
	tokenRefreshIntervalMs = 12 * 60 * 1000,
	rtcConfig,
	onConnected,
	onHeartbeat,
	onDisconnected,
	onError,
	onTokenExpiring,
}: UseLiveKitRoomOptions) {
	const [connectionState, setConnectionState] = useState<ConnectionState>(
		ConnectionState.Disconnected,
	);
	const [tracks, setTracks] = useState<LiveKitTrackInfo[]>([]);
	const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
	const [isSharingScreen, setIsSharingScreen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const roomRef = useRef<Room | null>(null);
	const connectedTokenRef = useRef<string | null>(null);

	const callbacksRef = useRef({
		onConnected,
		onHeartbeat,
		onDisconnected,
		onError,
		onTokenExpiring,
	});
	useEffect(() => {
		callbacksRef.current = {
			onConnected,
			onHeartbeat,
			onDisconnected,
			onError,
			onTokenExpiring,
		};
	});

	const disconnect = useCallback(() => {
		if (roomRef.current) {
			roomRef.current.disconnect();
			roomRef.current = null;
			connectedTokenRef.current = null;
		}
		setConnectionState(ConnectionState.Disconnected);
		setTracks([]);
		setParticipants([]);
		setIsSharingScreen(false);
	}, []);

	const setupRoomListeners = useCallback((room: Room) => {
		room.on(
			RoomEvent.TrackSubscribed,
			(
				track: RemoteTrack,
				publication: RemoteTrackPublication,
				participant: RemoteParticipant,
			) => {
				const trackId =
					track.sid || `${participant.identity}-${publication.trackSid}`;
				setTracks((prev) => {
					if (prev.some((t) => t.id === trackId)) return prev;
					return [
						...prev,
						{
							id: trackId,
							participantIdentity: participant.identity,
							participantName: participant.name || participant.identity,
							source: publication.source,
							track,
							isLocal: false,
						},
					];
				});
			},
		);

		room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
			setTracks((prev) => prev.filter((t) => t.id !== track.sid));
		});

		room.on(
			RoomEvent.LocalTrackPublished,
			(publication: LocalTrackPublication) => {
				if (!publication.track) return;
				const track = publication.track;
				const trackId = track.sid || `local-${publication.source}`;
				setTracks((prev) => {
					if (prev.some((t) => t.id === trackId)) return prev;
					return [
						...prev,
						{
							id: trackId,
							participantIdentity: room.localParticipant.identity || "local",
							participantName: room.localParticipant.name || "You",
							source: publication.source,
							track,
							isLocal: true,
						},
					];
				});
				if (publication.source === Track.Source.ScreenShare) {
					setIsSharingScreen(true);
				}
			},
		);

		room.on(
			RoomEvent.LocalTrackUnpublished,
			(publication: LocalTrackPublication) => {
				setTracks((prev) => prev.filter((t) => t.id !== publication.trackSid));
				if (publication.source === Track.Source.ScreenShare) {
					setIsSharingScreen(false);
				}
			},
		);

		room.on(RoomEvent.ParticipantConnected, () => {
			setParticipants(Array.from(room.remoteParticipants.values()));
		});

		room.on(
			RoomEvent.ParticipantDisconnected,
			(participant: RemoteParticipant) => {
				setParticipants(Array.from(room.remoteParticipants.values()));
				setTracks((prev) =>
					prev.filter((t) => t.participantIdentity !== participant.identity),
				);
			},
		);

		room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
			setConnectionState(state);
		});

		room.on(RoomEvent.Disconnected, (reason?: unknown) => {
			setConnectionState(ConnectionState.Disconnected);
			setTracks([]);
			setParticipants([]);
			setIsSharingScreen(false);
			callbacksRef.current.onDisconnected?.(reason);
		});
	}, []);

	const startScreenShare = useCallback(
		async (opts?: ScreenShareCaptureOptions, publishToken?: string) => {
			const captureOpts = mapScreenCaptureOptions(opts);
			const publishOpts = mapScreenPublishOptions(opts);
			let room = roomRef.current;

			// If room is not yet connected, wait up to 10s for active connection to complete (BUG 1 fix)
			if (!room || room.state !== ConnectionState.Connected) {
				const deadline = Date.now() + 10000;
				while (Date.now() < deadline) {
					room = roomRef.current;
					if (room && room.state === ConnectionState.Connected) {
						break;
					}
					if (room && room.state === ConnectionState.Disconnected) {
						break;
					}
					await new Promise((r) => setTimeout(r, 100));
				}
			}

			// Runtime permission grants (upgradeViewerToSharer) are applied to the
			// live SFU session server-side; give the client a brief window to receive
			// the ParticipantPermissionsChanged signal before the first publish
			// attempt so the common path never needs the reconnect fallback below.
			if (
				room &&
				room.state === ConnectionState.Connected &&
				publishToken &&
				room.localParticipant.permissions?.canPublish === false
			) {
				const grantDeadline = Date.now() + 1500;
				while (
					Date.now() < grantDeadline &&
					room.localParticipant.permissions?.canPublish === false
				) {
					await new Promise((r) => setTimeout(r, 50));
				}
			}

			// Fast path: publish on the current session. With server-side permission
			// grants this succeeds without any disconnect/reconnect — zero churn for
			// other participants and no same-identity session race (a fast re-join
			// could otherwise make viewers miss the new TrackSubscribed).
			if (room && room.state === ConnectionState.Connected) {
				try {
					await room.localParticipant.setScreenShareEnabled(
						true,
						captureOpts,
						publishOpts,
					);
					await enforceLocalScreenShareFps(
						room,
						resolveStreamingProfile(opts?.resolution, opts?.fps).fps,
					);
					setIsSharingScreen(true);
					return;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (!publishToken || !/insufficient permissions/i.test(message)) {
						throw err;
					}
					console.warn(
						"[livekit] publish denied on the current session — falling back to reconnect with publish token",
					);
				}
			}

			// Fallback: reconnect with the publish token, then publish. Only reached
			// when the runtime grant could not be applied to the live session (e.g.
			// the participant was momentarily absent from the SFU).
			if (publishToken && serverUrl) {
				if (room) {
					room.disconnect();
					roomRef.current = null;
				}
				setConnectionState(ConnectionState.Connecting);
				const newRoom = new Room({
					adaptiveStream: true,
					dynacast: true,
				});
				roomRef.current = newRoom;
				connectedTokenRef.current = publishToken;
				setupRoomListeners(newRoom);
				const connectOptions = buildLiveKitConnectOptions({ rtcConfig });
				await newRoom.connect(serverUrl, publishToken, connectOptions);
				setConnectionState(ConnectionState.Connected);
				setParticipants(Array.from(newRoom.remoteParticipants.values()));
				callbacksRef.current.onConnected?.();
				room = newRoom;
			}

			if (!room || room.state !== ConnectionState.Connected) {
				throw new Error("LiveKit room is not connected");
			}
			await room.localParticipant.setScreenShareEnabled(
				true,
				captureOpts,
				publishOpts,
			);
			await enforceLocalScreenShareFps(
				room,
				resolveStreamingProfile(opts?.resolution, opts?.fps).fps,
			);
			setIsSharingScreen(true);
		},
		[serverUrl, rtcConfig, setupRoomListeners],
	);

	const updateScreenShareFps = useCallback(async (fps: number) => {
		const room = roomRef.current;
		if (!room || room.state !== ConnectionState.Connected) return false;
		return enforceLocalScreenShareFps(
			room,
			resolveStreamingProfile(undefined, fps).fps,
		);
	}, []);

	const stopScreenShare = useCallback(async () => {
		const room = roomRef.current;
		if (!room) return;
		await room.localParticipant.setScreenShareEnabled(false);
		setIsSharingScreen(false);
	}, []);

	// Periodic heartbeat while connected (maps LiveKit presence to Convex pingViewer)
	useEffect(() => {
		if (
			connectionState !== ConnectionState.Connected ||
			heartbeatIntervalMs <= 0
		)
			return;
		const interval = setInterval(() => {
			callbacksRef.current.onHeartbeat?.();
		}, heartbeatIntervalMs);
		return () => clearInterval(interval);
	}, [connectionState, heartbeatIntervalMs]);

	// Token expiration watchdog (proactive renewal before 15m JWT TTL expiration)
	useEffect(() => {
		if (connectionState !== ConnectionState.Connected || !token) return;
		const timer = setTimeout(() => {
			callbacksRef.current.onTokenExpiring?.();
		}, tokenRefreshIntervalMs);
		return () => clearTimeout(timer);
	}, [connectionState, token, tokenRefreshIntervalMs]);

	const tokenRef = useRef(token);
	tokenRef.current = token;

	// In-place token refresh (Issue V2-4b & Residual Audit 1):
	// Dedicated effect for token renewal that updates internal token storage without
	// tearing down the WebRTC connection or triggering room disconnect cleanup.
	// This eliminates the multi-second video freeze and tile dropping during routine token renewal.
	//
	// CAUTION: This accesses internal properties ((room as any).engine.token and
	// (room as any).engine.client.token) because livekit-client@2.22.4 has no public
	// room.updateToken() API (the LiveKit wire protocol SignalRequest has no client->server
	// token refresh message; only SignalResponse carries server->client refreshToken).
	// To prevent silent breaking changes on upgrade, livekit-client is hard-pinned to
	// exactly "2.22.4" (no caret ^) in apps/app/package.json. Do NOT upgrade livekit-client
	// without verifying these internal property paths or migrating to a public updateToken() API.
	useEffect(() => {
		if (!token) return;
		if (connectedTokenRef.current === token) return;
		const room = roomRef.current;
		if (room && room.state === ConnectionState.Connected) {
			if ((room as any).engine) {
				(room as any).engine.token = token;
				if ((room as any).engine.client) {
					(room as any).engine.client.token = token;
				}
			}
			connectedTokenRef.current = token;
		}
	}, [token]);

	useEffect(() => {
		if (!enabled || !serverUrl || !roomCode || !token) {
			if (roomRef.current) {
				disconnect();
			}
			return;
		}

		// Skip redundant reconnection if already connected to this token or room is already active
		if (
			roomRef.current &&
			(connectedTokenRef.current === token ||
				roomRef.current.state === ConnectionState.Connected)
		) {
			return;
		}

		let isCancelled = false;

		if (roomRef.current) {
			roomRef.current.disconnect();
			roomRef.current = null;
		}

		const room = new Room({
			adaptiveStream: true,
			dynacast: true,
		});
		roomRef.current = room;
		connectedTokenRef.current = token;

		setConnectionState(ConnectionState.Connecting);
		setError(null);

		setupRoomListeners(room);

		const connectOptions = buildLiveKitConnectOptions({ rtcConfig });
		room
			.connect(serverUrl, token, connectOptions)
			.then(() => {
				if (isCancelled) {
					room.disconnect();
					return;
				}
				setConnectionState(ConnectionState.Connected);
				setParticipants(Array.from(room.remoteParticipants.values()));
				callbacksRef.current.onConnected?.();
			})
			.catch((err: Error) => {
				if (isCancelled) return;
				setError(err.message);
				setConnectionState(ConnectionState.Disconnected);
				callbacksRef.current.onError?.(err);
			});

		return () => {
			isCancelled = true;
			room.disconnect();
			if (roomRef.current === room) {
				roomRef.current = null;
				connectedTokenRef.current = null;
			}
		};
	}, [enabled, serverUrl, roomCode, rtcConfig, disconnect, setupRoomListeners]);

	// Expose WebRTC stats extractor for telemetry, observability & soak harnesses
	const getStats = useCallback(async () => {
		const room = roomRef.current;
		if (!room) return null;
		try {
			const engine = (room as any).engine;
			const pubPC = engine?.pcManager?.publisher || engine?.publisher?.pc;
			const subPC = engine?.pcManager?.subscriber || engine?.subscriber?.pc;
			return {
				publisher: pubPC ? await pubPC.getStats() : null,
				subscriber: subPC ? await subPC.getStats() : null,
			};
		} catch {
			return null;
		}
	}, []);

	// Expose active room on window for test harness diagnostics in dev/test
	useEffect(() => {
		if (typeof window !== "undefined") {
			(window as any).__livekitRoom = roomRef.current;
		}
	}, [connectionState]);

	const screenTracks = useMemo(
		() => filterTracksBySource(tracks, Track.Source.ScreenShare),
		[tracks],
	);
	const screenAudioTracks = useMemo(
		() => mapLiveKitScreenAudioTracks(tracks),
		[tracks],
	);

	return {
		room: roomRef.current,
		connectionState,
		isConnected: connectionState === ConnectionState.Connected,
		isConnecting: connectionState === ConnectionState.Connecting,
		isSharingScreen,
		participants,
		tracks,
		screenTracks,
		screenAudioTracks,
		error,
		startScreenShare,
		updateScreenShareFps,
		stopScreenShare,
		disconnect,
		getStats,
	};
}
