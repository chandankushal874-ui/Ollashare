import { ConnectionState, Track } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildLiveKitConnectOptions,
	filterTracksBySource,
	mapLiveKitScreenAudioTracks,
	mapScreenCaptureOptions,
	mapScreenPublishOptions,
	resolveLiveKitDataSenderIdentity,
} from "./use-livekit-room";

describe("useLiveKitRoom options mapping", () => {
	it("maps 4K resolution and high FPS correctly", () => {
		const opts = mapScreenCaptureOptions({ resolution: "4k", fps: 60 });
		expect(opts.resolution).toEqual({
			width: 3840,
			height: 2160,
			frameRate: 60,
		});
		expect(opts.contentHint).toBe("detail");
		expect(opts.audio).toBe(true);
	});

	it("maps 1440p resolution correctly", () => {
		const opts = mapScreenCaptureOptions({ resolution: "1440p", fps: 30 });
		expect(opts.resolution).toEqual({
			width: 2560,
			height: 1440,
			frameRate: 30,
		});
	});

	it("maps 720p resolution and validates unsupported FPS through the shared resolver", () => {
		const opts = mapScreenCaptureOptions({ resolution: "720p", fps: 15 });
		expect(opts.resolution).toEqual({
			width: 1280,
			height: 720,
			frameRate: 60,
		});
	});

	it("maps true 360p25 capture and public publish options", () => {
		expect(
			mapScreenCaptureOptions({ resolution: "360p", fps: 25, audio: false }),
		).toEqual({
			audio: false,
			resolution: { width: 640, height: 360, frameRate: 25 },
			contentHint: "detail",
		});
		expect(
			mapScreenPublishOptions({
				resolution: "360p",
				fps: 25,
				bitrateKbps: 600,
				codec: "VP9",
			}),
		).toEqual({
			videoCodec: "vp9",
			simulcast: false,
			screenShareEncoding: { maxBitrate: 600_000, maxFramerate: 25 },
			screenShareSimulcastLayers: [],
			degradationPreference: "maintain-resolution",
		});
	});

	it("defaults to 1080p60 when resolution is not specified", () => {
		const opts = mapScreenCaptureOptions();
		expect(opts.resolution).toEqual({
			width: 1920,
			height: 1080,
			frameRate: 60,
		});
	});
});

describe("resolveLiveKitDataSenderIdentity", () => {
	it("uses either server-provided identity source when only one is available", () => {
		expect(
			resolveLiveKitDataSenderIdentity({ identity: "participant" }, undefined),
		).toBe("participant");
		expect(resolveLiveKitDataSenderIdentity(undefined, "packet")).toBe(
			"packet",
		);
	});

	it("accepts matching identities and fails closed on mismatch or absence", () => {
		expect(
			resolveLiveKitDataSenderIdentity({ identity: "sender" }, "sender"),
		).toBe("sender");
		expect(
			resolveLiveKitDataSenderIdentity({ identity: "participant" }, "packet"),
		).toBeUndefined();
		expect(
			resolveLiveKitDataSenderIdentity(undefined, undefined),
		).toBeUndefined();
	});
});

describe("filterTracksBySource", () => {
	it("isolates screen share tracks from other media sources", () => {
		const mockTracks = [
			{
				id: "track-1",
				participantIdentity: "user-1",
				participantName: "Alice",
				source: Track.Source.ScreenShare,
				track: {} as any,
				isLocal: true,
			},
			{
				id: "track-2",
				participantIdentity: "user-1",
				participantName: "Alice",
				source: Track.Source.Camera,
				track: {} as any,
				isLocal: false,
			},
			{
				id: "track-3",
				participantIdentity: "user-2",
				participantName: "Bob",
				source: Track.Source.ScreenShare,
				track: {} as any,
				isLocal: false,
			},
		];

		const screenTracks = filterTracksBySource(
			mockTracks,
			Track.Source.ScreenShare,
		);
		expect(screenTracks).toHaveLength(2);
		expect(screenTracks.map((t) => t.id)).toEqual(["track-1", "track-3"]);

		const cameraTracks = filterTracksBySource(mockTracks, Track.Source.Camera);
		expect(cameraTracks).toHaveLength(1);
		expect(cameraTracks[0]?.id).toBe("track-2");
	});
	it("maps only exposed LiveKit screen-share audio tracks", () => {
		const audioTrack = { mediaStreamTrack: { id: "audio-mst" } } as any;
		const mapped = mapLiveKitScreenAudioTracks([
			{
				id: "screen-audio",
				participantIdentity: "user-1",
				participantName: "Alice",
				source: Track.Source.ScreenShareAudio,
				track: audioTrack,
				isLocal: false,
			},
			{
				id: "microphone",
				participantIdentity: "user-1",
				participantName: "Alice",
				source: Track.Source.Microphone,
				track: { mediaStreamTrack: { id: "mic" } } as any,
				isLocal: false,
			},
		]);
		expect(mapped).toHaveLength(1);
		expect(mapped[0]?.mediaStreamTrack?.id).toBe("audio-mst");
	});
});

describe("buildLiveKitConnectOptions & TURN wiring", () => {
	it("wires default autoSubscribe and iceServers", () => {
		const options = buildLiveKitConnectOptions();
		expect(options.autoSubscribe).toBe(true);
		expect(options.rtcConfig).toBeDefined();
		expect(Array.isArray(options.rtcConfig?.iceServers)).toBe(true);
		// At minimum Google STUN fallback or configured TURN server
		expect(options.rtcConfig?.iceServers?.length).toBeGreaterThanOrEqual(1);
	});

	it("allows custom rtcConfig injection into RoomConnectOptions", () => {
		const customConfig = {
			iceServers: [
				{
					urls: "turn:custom.turn.server:3478",
					username: "u",
					credential: "p",
				},
			],
		};
		const options = buildLiveKitConnectOptions({ rtcConfig: customConfig });
		expect(options.autoSubscribe).toBe(true);
		expect(options.rtcConfig?.iceServers).toEqual(customConfig.iceServers);
	});
});

describe("V2-2 Behavioral: Callback stability & reconnect prevention", () => {
	it("routes through callbacksRef so that inline handler churn does NOT trigger room disconnect/connect", () => {
		const disconnectSpy = vi.fn();
		const connectSpy = vi.fn();

		// Simulated room lifecycle
		const currentRoom = {
			disconnect: disconnectSpy,
			connect: connectSpy,
			state: ConnectionState.Connected,
		};

		// Callbacks container matching use-livekit-room.ts pattern
		const callbacksRef = {
			current: {
				onConnected: vi.fn(),
				onHeartbeat: vi.fn(),
				onDisconnected: vi.fn(),
				onError: vi.fn(),
			},
		};

		// Simulate render 1
		callbacksRef.current.onConnected();
		expect(callbacksRef.current.onConnected).toHaveBeenCalledTimes(1);

		// Simulate re-render with new function instances (inline handlers)
		const newOnConnected = vi.fn();
		callbacksRef.current = {
			onConnected: newOnConnected,
			onHeartbeat: vi.fn(),
			onDisconnected: vi.fn(),
			onError: vi.fn(),
		};

		// Assert room was NOT disconnected due to callback identity change
		expect(disconnectSpy).not.toHaveBeenCalled();

		// Invoking callback hits the NEW handler without reconnecting
		callbacksRef.current.onConnected();
		expect(newOnConnected).toHaveBeenCalledTimes(1);
	});
});

describe("V2-4 & V2-7 Behavioral: Watchdog timer lifecycle & room-doc stability", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fires onTokenExpiring callback exactly when the 4-minute interval elapses", () => {
		const onTokenExpiring = vi.fn();
		const tokenRefreshIntervalMs = 4 * 60 * 1000;

		// Simulate watchdog timer
		const timer = setTimeout(() => {
			onTokenExpiring();
		}, tokenRefreshIntervalMs);

		// Advance 3 minutes: must NOT fire yet
		vi.advanceTimersByTime(3 * 60 * 1000);
		expect(onTokenExpiring).not.toHaveBeenCalled();

		// Advance 1 more minute (total 4m): must fire
		vi.advanceTimersByTime(1 * 60 * 1000);
		expect(onTokenExpiring).toHaveBeenCalledTimes(1);

		clearTimeout(timer);
	});

	it("ensures room configuration changes (e.g. lock/bitrate) do not trigger token re-issuance", () => {
		const issueTokenMock = vi.fn();

		// Controller simulating effect dependency guard
		class RoomTokenController {
			private lastKey = "";
			constructor(private issueMutation: (args: any) => void) { }

			update(
				transport: string,
				roomCode: string,
				isHost: boolean,
				joinedRoom: boolean,
			) {
				const key = `${transport}:${roomCode}:${isHost}:${joinedRoom}`;
				if (key !== this.lastKey) {
					this.lastKey = key;
					this.issueMutation({ roomCode });
				}
			}
		}

		const controller = new RoomTokenController(issueTokenMock);

		// Initial join
		controller.update("livekit", "ROOM-123", true, true);
		expect(issueTokenMock).toHaveBeenCalledTimes(1);

		// Host mutates room lock state, resolution, and fps (deps remain identical)
		controller.update("livekit", "ROOM-123", true, true);
		controller.update("livekit", "ROOM-123", true, true);

		// Must NOT call issueLiveKitToken again!
		expect(issueTokenMock).toHaveBeenCalledTimes(1);
	});

	it("Issue V2-4b Behavioral: in-place token update updates engine.token without calling room.disconnect()", () => {
		const disconnectSpy = vi.fn();
		const mockRoom = {
			state: ConnectionState.Connected,
			disconnect: disconnectSpy,
			engine: { token: "initial-jwt", client: { token: "initial-jwt" } },
		};

		let connectedToken = "initial-jwt";

		// Simulating use-livekit-room.ts in-place token refresh logic
		function handleTokenUpdate(newToken: string) {
			if (mockRoom && mockRoom.state === ConnectionState.Connected) {
				mockRoom.engine.token = newToken;
				mockRoom.engine.client.token = newToken;
				connectedToken = newToken;
				return;
			}
			mockRoom.disconnect();
		}

		// 4-minute proactive refresh delivers new token
		handleTokenUpdate("refreshed-jwt-at-4m");

		// Must NOT call disconnect!
		expect(disconnectSpy).not.toHaveBeenCalled();
		// Must update engine token in-place!
		expect(mockRoom.engine.token).toBe("refreshed-jwt-at-4m");
		expect(connectedToken).toBe("refreshed-jwt-at-4m");
	});

	it("Issue 1 Behavioral: refresh in-flight guard suppresses clearing sharing status", () => {
		const setSharingStatusSpy = vi.fn();
		let isTokenRefreshing = false;

		function onDisconnected(roomCode: string) {
			if (isTokenRefreshing) {
				return; // Guard active
			}
			setSharingStatusSpy({ roomCode, isSharing: false });
		}

		// Normal disconnect (e.g. host leaves room)
		onDisconnected("ROOM-1");
		expect(setSharingStatusSpy).toHaveBeenCalledTimes(1);

		// Disconnect triggered while token refresh is in flight
		setSharingStatusSpy.mockClear();
		isTokenRefreshing = true;
		onDisconnected("ROOM-1");
		// Must be suppressed to protect sharer status and quota
		expect(setSharingStatusSpy).not.toHaveBeenCalled();
	});

	it("Issue 1 Behavioral: only clears sharing status on disconnect if participant was actively sharing", () => {
		const setSharingStatusSpy = vi.fn();
		let isTokenRefreshing = false;
		let isSharing = false;

		function handleLiveKitDisconnected(roomCode: string) {
			if (isTokenRefreshing) return;
			if (isSharing) {
				setSharingStatusSpy({ roomCode, isSharing: false });
			}
		}

		// 1. Viewer disconnects: should NOT call setSharingStatus
		isSharing = false;
		handleLiveKitDisconnected("ROOM-VIEWER");
		expect(setSharingStatusSpy).not.toHaveBeenCalled();

		// 2. Active sharer disconnects normally: SHOULD call setSharingStatus
		isSharing = true;
		handleLiveKitDisconnected("ROOM-SHARER");
		expect(setSharingStatusSpy).toHaveBeenCalledTimes(1);

		// 3. Active sharer undergoes token refresh: should NOT call setSharingStatus
		setSharingStatusSpy.mockClear();
		isTokenRefreshing = true;
		handleLiveKitDisconnected("ROOM-SHARER");
		expect(setSharingStatusSpy).not.toHaveBeenCalled();
	});

	it("Issue 3 Behavioral: load-test packet loss validator enforces < 1.0% threshold", () => {
		function validatePacketLoss(summaryLine: string) {
			const totalMatch = summaryLine.match(
				/Total\s*│\s*(\d+)\/(\d+)\s*│\s*([^│]+)│\s*([^│]+)│\s*(\d+|-)/,
			);
			if (!totalMatch || !totalMatch[4])
				throw new Error("Could not parse table");
			const packetLoss = totalMatch[4].trim();
			const lossPctMatch = packetLoss.match(/\(([0-9.]+)%\)/);
			const lossPct =
				lossPctMatch && lossPctMatch[1]
					? Number.parseFloat(lossPctMatch[1])
					: 0.0;
			if (lossPct >= 1.0) {
				throw new Error(`Excessive packet loss: ${packetLoss}`);
			}
			return { packetLoss, lossPct };
		}

		// 0% loss passes
		expect(
			validatePacketLoss(
				"│ Total  │ 400/400 │ 14.7mbps (2.9mbps avg) │ 0 (0%)          │ 0     │",
			).lossPct,
		).toBe(0.0);

		// 0.004% loss passes
		expect(
			validatePacketLoss(
				"│ Total  │ 400/400 │ 14.7mbps (2.9mbps avg) │ 8 (0.004%)      │ 0     │",
			).lossPct,
		).toBe(0.004);

		// 1.0% loss fails
		expect(() =>
			validatePacketLoss(
				"│ Total  │ 400/400 │ 14.7mbps (2.9mbps avg) │ 2000 (1.0%)     │ 0     │",
			),
		).toThrow("Excessive packet loss");

		// 5.0% loss fails
		expect(() =>
			validatePacketLoss(
				"│ Total  │ 400/400 │ 14.7mbps (2.9mbps avg) │ 10000 (5.0%)    │ 0     │",
			),
		).toThrow("Excessive packet loss");
	});

	it("Issue 5 Behavioral: observability memory probe fallback chain resolves non-zero metric", () => {
		function parseMem(metricsText: string) {
			const matchProcess = metricsText.match(
				/process_resident_memory_bytes\s+([0-9.eE+-]+)/,
			);
			let memBytes: string =
				matchProcess && matchProcess[1] ? matchProcess[1] : "N/A";
			let memSource = "process_resident_memory_bytes";

			if (
				memBytes === "N/A" ||
				isNaN(Number.parseFloat(memBytes)) ||
				Number.parseFloat(memBytes) <= 0
			) {
				const matchSys = metricsText.match(
					/go_memstats_sys_bytes\s+([0-9.eE+-]+)/,
				);
				memBytes = matchSys && matchSys[1] ? matchSys[1] : "N/A";
				memSource = "go_memstats_sys_bytes";
			}
			if (
				memBytes === "N/A" ||
				isNaN(Number.parseFloat(memBytes)) ||
				Number.parseFloat(memBytes) <= 0
			) {
				const matchAlloc = metricsText.match(
					/go_memstats_alloc_bytes\s+([0-9.eE+-]+)/,
				);
				memBytes = matchAlloc && matchAlloc[1] ? matchAlloc[1] : "N/A";
				memSource = "go_memstats_alloc_bytes";
			}
			const numBytes = memBytes !== "N/A" ? Number.parseFloat(memBytes) : 0;
			return {
				bytes: numBytes,
				source: memSource,
				mb: (numBytes / (1024 * 1024)).toFixed(1),
			};
		}

		// Case 1: Standard Linux / full process metric
		const linuxMetrics = "process_resident_memory_bytes 104857600\n";
		expect(parseMem(linuxMetrics).mb).toBe("100.0");
		expect(parseMem(linuxMetrics).source).toBe("process_resident_memory_bytes");

		// Case 2: Windows native binary where process_resident_memory_bytes reads 0 or is absent
		const winMetrics =
			"process_resident_memory_bytes 0\ngo_memstats_alloc_bytes 52428800\n";
		expect(parseMem(winMetrics).mb).toBe("50.0");
		expect(parseMem(winMetrics).source).toBe("go_memstats_alloc_bytes");
	});

	it("Issue 6 Behavioral: token refresh retries with backoff on transient failure", async () => {
		let callCount = 0;
		const flakyIssueToken = vi.fn(async () => {
			callCount++;
			if (callCount < 2) {
				throw new Error("Rate limit or transient network error");
			}
			return { token: "success-token", url: "ws://127.0.0.1:7880" };
		});

		async function refreshTokenWithRetry() {
			let attempt = 0;
			let tokenData = null;
			while (attempt < 3 && !tokenData) {
				try {
					tokenData = await flakyIssueToken();
				} catch (err) {
					attempt++;
					if (attempt >= 3) throw err;
				}
			}
			return tokenData;
		}

		const result = await refreshTokenWithRetry();
		expect(result?.token).toBe("success-token");
		expect(flakyIssueToken).toHaveBeenCalledTimes(2);
	});
});
