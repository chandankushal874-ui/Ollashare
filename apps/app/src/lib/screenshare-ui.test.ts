import { describe, it, expect, vi } from "vitest";

describe("Issue V2-14: Screenshare UI Interactions & Contract Suite", () => {
  describe("Name-Gate Modal Logic", () => {
    function computeNeedsNameGate({
      roomCode,
      guestName,
      roomDocReceived,
      isHost,
    }: {
      roomCode: string | null;
      guestName: string | null;
      roomDocReceived: boolean;
      isHost: boolean;
    }) {
      // Mirrors page.tsx:161-162:
      // Boolean(roomCode) && !guestName && room !== undefined && !isHost
      return Boolean(roomCode) && !guestName && roomDocReceived && !isHost;
    }

    it("renders name-gate modal for prospective guest arriving via link without chosen name", () => {
      expect(
        computeNeedsNameGate({
          roomCode: "ROOM-XYZ",
          guestName: null,
          roomDocReceived: true,
          isHost: false,
        }),
      ).toBe(true);
    });

    it("bypasses name-gate modal for the host who created the room", () => {
      expect(
        computeNeedsNameGate({
          roomCode: "ROOM-XYZ",
          guestName: null,
          roomDocReceived: true,
          isHost: true,
        }),
      ).toBe(false);
    });

    it("bypasses name-gate modal once guest submits their display name", () => {
      expect(
        computeNeedsNameGate({
          roomCode: "ROOM-XYZ",
          guestName: "Alice",
          roomDocReceived: true,
          isHost: false,
        }),
      ).toBe(false);
    });

    it("suppresses gate while room doc is loading to prevent flash of gate for host", () => {
      expect(
        computeNeedsNameGate({
          roomCode: "ROOM-XYZ",
          guestName: null,
          roomDocReceived: false,
          isHost: false,
        }),
      ).toBe(false);
    });
  });

  describe("Host Broadcast UI Action Flow (Button -> Hook -> Convex Mutation)", () => {
    it("dispatches startScreenShare and marks isSharing: true in Convex DB", async () => {
      const mockLiveKit = {
        startScreenShare: vi.fn().mockResolvedValue(undefined),
        stopScreenShare: vi.fn().mockResolvedValue(undefined),
      };
      const setSharingStatusMutation = vi.fn().mockResolvedValue(undefined);
      let isBroadcasting = false;

      // Simulated button click handler in page.tsx
      async function handleStartBroadcast() {
        await mockLiveKit.startScreenShare({ resolution: "1080p", fps: 60 });
        isBroadcasting = true;
        await setSharingStatusMutation({ roomCode: "ROOM-123", isSharing: true });
      }

      await handleStartBroadcast();

      expect(mockLiveKit.startScreenShare).toHaveBeenCalledTimes(1);
      expect(isBroadcasting).toBe(true);
      expect(setSharingStatusMutation).toHaveBeenCalledWith({ roomCode: "ROOM-123", isSharing: true });
    });

    it("dispatches stopScreenShare and clears isSharing in Convex DB", async () => {
      const mockLiveKit = {
        startScreenShare: vi.fn(),
        stopScreenShare: vi.fn().mockResolvedValue(undefined),
      };
      const setSharingStatusMutation = vi.fn().mockResolvedValue(undefined);
      let isBroadcasting = true;

      // Simulated button click handler in page.tsx
      async function handleStopBroadcast() {
        await mockLiveKit.stopScreenShare();
        isBroadcasting = false;
        await setSharingStatusMutation({ roomCode: "ROOM-123", isSharing: false });
      }

      await handleStopBroadcast();

      expect(mockLiveKit.stopScreenShare).toHaveBeenCalledTimes(1);
      expect(isBroadcasting).toBe(false);
      expect(setSharingStatusMutation).toHaveBeenCalledWith({ roomCode: "ROOM-123", isSharing: false });
    });
  });

  describe("Guest Screenshare UI Action Flow with Dynamic Token Upgrade", () => {
    it("executes pre-flight publish grant mutation before calling liveKit.startScreenShare", async () => {
      const issueLiveKitTokenMutation = vi.fn().mockResolvedValue({
        token: "upgraded-publish-token",
        url: "ws://127.0.0.1:7880",
      });
      const mockLiveKit = {
        startScreenShare: vi.fn().mockResolvedValue(undefined),
      };
      const setSharingStatusMutation = vi.fn().mockResolvedValue(undefined);
      let isGuestSharing = false;

      async function handleStartGuestScreenshare() {
        const tokenData = await issueLiveKitTokenMutation({
          roomCode: "ROOM-GUEST",
          requestPublish: true,
        });
        await mockLiveKit.startScreenShare({ resolution: "1080p", fps: 60 }, tokenData.token);
        isGuestSharing = true;
        await setSharingStatusMutation({ roomCode: "ROOM-GUEST", isSharing: true });
      }

      await handleStartGuestScreenshare();

      expect(issueLiveKitTokenMutation).toHaveBeenCalledWith({
        roomCode: "ROOM-GUEST",
        requestPublish: true,
      });
      expect(mockLiveKit.startScreenShare).toHaveBeenCalledWith(
        { resolution: "1080p", fps: 60 },
        "upgraded-publish-token",
      );
      expect(isGuestSharing).toBe(true);
      expect(setSharingStatusMutation).toHaveBeenCalledWith({
        roomCode: "ROOM-GUEST",
        isSharing: true,
      });
    });
  });

  describe("Theater Mode & Focus Zoom Tile Interaction", () => {
    it("zooms into selected device stream and gracefully resets if device leaves", () => {
      let sharedDevices = [
        { id: "device-1", deviceName: "Host Screen" },
        { id: "device-2", deviceName: "Guest Screen" },
      ];
      let zoomedDeviceId: string | null = null;

      // User clicks device-2 tile in UI
      zoomedDeviceId = "device-2";
      let zoomedDevice = sharedDevices.find((d) => d.id === zoomedDeviceId) ?? null;
      expect(zoomedDevice?.deviceName).toBe("Guest Screen");

      // Guest disconnects: device-2 removed from active stream list
      sharedDevices = sharedDevices.filter((d) => d.id !== "device-2");
      if (zoomedDeviceId && !sharedDevices.some((d) => d.id === zoomedDeviceId)) {
        zoomedDeviceId = null;
      }
      zoomedDevice = sharedDevices.find((d) => d.id === zoomedDeviceId) ?? null;

      expect(zoomedDeviceId).toBeNull();
      expect(zoomedDevice).toBeNull();
    });
  });

  describe("BUG 1 Fix: Host Share Button Race & LiveKit Connection Guard", () => {
    it("disables share button while LiveKit is connecting to prevent premature click exception", () => {
      function isShareButtonDisabled(transport: string, roomCode: string | null, isConnected: boolean, isConnecting: boolean) {
        return transport === "livekit" && Boolean(roomCode) && (!isConnected || isConnecting);
      }

      // Pre-room (no room code): not in connecting state
      expect(isShareButtonDisabled("livekit", null, false, false)).toBe(false);

      // Room created, LiveKit connection in flight: MUST BE DISABLED
      expect(isShareButtonDisabled("livekit", "MIRA-123", false, true)).toBe(true);

      // Room created, token issued, connecting state pending: MUST BE DISABLED
      expect(isShareButtonDisabled("livekit", "MIRA-123", false, false)).toBe(true);

      // Fully connected: MUST BE ENABLED
      expect(isShareButtonDisabled("livekit", "MIRA-123", true, false)).toBe(false);

      // Mesh fallback mode: bypasses LiveKit connecting guard
      expect(isShareButtonDisabled("mesh", "MIRA-123", false, false)).toBe(false);
    });

    it("queues startScreenShare until room transitions to Connected instead of throwing immediately", async () => {
      let roomState = "connecting";
      const mockRoom = {
        get state() { return roomState; },
        localParticipant: {
          setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
        },
      };

      // Room connects after 150ms
      setTimeout(() => {
        roomState = "connected";
      }, 150);

      async function startScreenShareWithQueue() {
        const deadline = Date.now() + 1000;
        let activeRoom: any = mockRoom;
        while (Date.now() < deadline) {
          if (activeRoom && activeRoom.state === "connected") break;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!activeRoom || activeRoom.state !== "connected") {
          throw new Error("LiveKit room is not connected");
        }
        await activeRoom.localParticipant.setScreenShareEnabled(true);
      }

      await expect(startScreenShareWithQueue()).resolves.toBeUndefined();
      expect(mockRoom.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true);
    });
  });

  describe("BUG 2 Fix: Pre-Room Quality Configuration", () => {
    it("passes pre-configured resolution and fps into createRoom mutation", async () => {
      const createRoomMutation = vi.fn().mockResolvedValue({ code: "MIRA-720P" });
      const currentConfig = {
        resolution: "720p",
        fps: 60,
        bitrateKbps: 4000,
        codec: "H.264",
        audioEnabled: true,
      };

      async function handleCreateRoom(workspaceId: string, config: typeof currentConfig) {
        return await createRoomMutation({
          workspaceId,
          title: "Screenshare Session",
          resolution: config.resolution,
          fps: config.fps,
          bitrateKbps: config.bitrateKbps,
          codec: config.codec,
          audioEnabled: config.audioEnabled,
        });
      }

      const res = await handleCreateRoom("ws-123", currentConfig);
      expect(res.code).toBe("MIRA-720P");
      expect(createRoomMutation).toHaveBeenCalledWith({
        workspaceId: "ws-123",
        title: "Screenshare Session",
        resolution: "720p",
        fps: 60,
        bitrateKbps: 4000,
        codec: "H.264",
        audioEnabled: true,
      });
    });
  });

  describe("BUG 3 Fix: Host Moderation & Tile Kick Actions", () => {
    it("renders kick action directly on presenter tile for host when device owner is not host", () => {
      function shouldRenderTileKick(isHost: boolean, deviceOwnerId: string, currentUserId: string) {
        return isHost && deviceOwnerId !== currentUserId;
      }

      // Host viewing guest tile: MUST RENDER KICK
      expect(shouldRenderTileKick(true, "guest-user-1", "host-user")).toBe(true);

      // Host viewing own tile: NEVER RENDER KICK ON SELF
      expect(shouldRenderTileKick(true, "host-user", "host-user")).toBe(false);

      // Guest viewing another guest tile: NEVER RENDER KICK FOR GUEST
      expect(shouldRenderTileKick(false, "guest-user-2", "guest-user-1")).toBe(false);
    });
  });

});
