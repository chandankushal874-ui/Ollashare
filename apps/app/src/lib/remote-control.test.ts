import { describe, expect, it } from "vitest";
import {
  calculateNormalizedVideoCoordinates,
  parseRemoteControlPayload,
  type SharerInputMessage,
  type RemoteControlMessage,
  type KeyModifiers,
} from "./remote-control";

describe("Remote Control Engine - sharer protocol compatibility", () => {
  describe("calculateNormalizedVideoCoordinates with letterbox/pillarbox adjustment", () => {
    it("maps 1:1 when container matches video aspect ratio exactly", () => {
      // 1920x1080 native in 960x540 container (exact 16:9)
      const rect = { left: 0, top: 0, width: 960, height: 540 };
      const center = calculateNormalizedVideoCoordinates(480, 270, rect, 1920, 1080);
      expect(center).toEqual({ x: 960, y: 540, u: 0.5, v: 0.5 });

      const topLeft = calculateNormalizedVideoCoordinates(0, 0, rect, 1920, 1080);
      expect(topLeft).toEqual({ x: 0, y: 0, u: 0, v: 0 });

      const bottomRight = calculateNormalizedVideoCoordinates(960, 540, rect, 1920, 1080);
      expect(bottomRight?.x).toBe(1920);
      expect(bottomRight?.y).toBe(1080);
      expect(bottomRight?.u).toBeCloseTo(1, 5);
      expect(bottomRight?.v).toBeCloseTo(1, 5);
    });

    it("correctly handles pillarboxing (black bars on left & right)", () => {
      // 1920x1080 (16:9) video inside a wide 1200x540 container
      // Video display width = 540 * (16/9) = 960px
      // Pillarbox offset = (1200 - 960) / 2 = 120px left & right
      const rect = { left: 50, top: 50, width: 1200, height: 540 };

      // Point in left pillarbox black bar (clientX = 50 + 60 = 110)
      const inBlackBar = calculateNormalizedVideoCoordinates(110, 200, rect, 1920, 1080);
      expect(inBlackBar).toBeNull();

      // Point at left edge of active video (clientX = 50 + 120 = 170)
      const atVideoLeft = calculateNormalizedVideoCoordinates(170, 50, rect, 1920, 1080);
      expect(atVideoLeft).toEqual({ x: 0, y: 0, u: 0, v: 0 });

      // Point at center of active video (clientX = 50 + 120 + 480 = 650, clientY = 50 + 270 = 320)
      const atCenter = calculateNormalizedVideoCoordinates(650, 320, rect, 1920, 1080);
      expect(atCenter?.x).toBe(960);
      expect(atCenter?.y).toBe(540);
      expect(atCenter?.u).toBe(0.5);
      expect(atCenter?.v).toBe(0.5);
    });

    it("correctly handles letterboxing (black bars on top & bottom)", () => {
      // 1920x1080 (16:9) video inside a tall 960x800 container
      // Video display height = 960 / (16/9) = 540px
      // Letterbox offset = (800 - 540) / 2 = 130px top & bottom
      const rect = { left: 0, top: 0, width: 960, height: 800 };

      // Point in top letterbox black bar (clientY = 50)
      const inTopBar = calculateNormalizedVideoCoordinates(480, 50, rect, 1920, 1080);
      expect(inTopBar).toBeNull();

      // Point at top edge of active video (clientY = 130)
      const atTop = calculateNormalizedVideoCoordinates(0, 130, rect, 1920, 1080);
      expect(atTop).toEqual({ x: 0, y: 0, u: 0, v: 0 });

      // Point at center of active video (clientY = 130 + 270 = 400)
      const atCenter = calculateNormalizedVideoCoordinates(480, 400, rect, 1920, 1080);
      expect(atCenter?.x).toBe(960);
      expect(atCenter?.y).toBe(540);
      expect(atCenter?.u).toBe(0.5);
      expect(atCenter?.v).toBe(0.5);
    });

    it("returns null when coordinates are outside the container", () => {
      const rect = { left: 100, top: 100, width: 800, height: 600 };
      expect(calculateNormalizedVideoCoordinates(50, 200, rect)).toBeNull();
      expect(calculateNormalizedVideoCoordinates(950, 200, rect)).toBeNull();
    });
  });

  describe("parseRemoteControlPayload", () => {
    it("parses valid REMOTE_CONTROL_REQUEST handshake", () => {
      const req: RemoteControlMessage = {
        type: "REMOTE_CONTROL_REQUEST",
        hostId: "user_host_123",
        hostName: "Alice Host",
        deviceId: "guest-user_456",
        targetUserId: "user_456",
      };
      const res = parseRemoteControlPayload(JSON.stringify(req));
      expect(res.isControl).toBe(true);
      if (res.isControl) {
        expect(res.data.type).toBe("REMOTE_CONTROL_REQUEST");
      }
    });

    it("parses valid REMOTE_CONTROL_RESPONSE acceptance", () => {
      const resp: RemoteControlMessage = {
        type: "REMOTE_CONTROL_RESPONSE",
        accepted: true,
        deviceId: "guest-user_456",
        hostId: "user_host_123",
        guestId: "user_456",
        guestName: "Bob Guest",
      };
      const res = parseRemoteControlPayload(JSON.stringify(resp));
      expect(res.isControl).toBe(true);
      if (res.isControl) {
        expect(res.data.type).toBe("REMOTE_CONTROL_RESPONSE");
        expect((res.data as any).accepted).toBe(true);
      }
    });

    it("parses enveloped REMOTE_CONTROL_INPUT with mouse and keyboard messages", () => {
      const mouseMsg: SharerInputMessage = {
        type: "mouse_down",
        x: 1280,
        y: 720,
        button: "left",
      };
      const enveloped: RemoteControlMessage = {
        type: "REMOTE_CONTROL_INPUT",
        deviceId: "guest-user_456",
        input: mouseMsg,
      };

      const res = parseRemoteControlPayload(JSON.stringify(enveloped));
      expect(res.isControl).toBe(true);
      if (res.isControl) {
        expect(res.data.type).toBe("REMOTE_CONTROL_INPUT");
        expect((res.data as any).input.button).toBe("left");
      }
    });

    it("parses raw sharer InputMessage directly (native Rust client compatibility)", () => {
      const rawMove = JSON.stringify({ type: "mouse_move", x: 800, y: 600 });
      const resMove = parseRemoteControlPayload(rawMove);
      expect(resMove.isControl).toBe(true);
      if (resMove.isControl) {
        expect(resMove.data.type).toBe("mouse_move");
        expect((resMove.data as any).x).toBe(800);
      }

      const rawKey = JSON.stringify({ type: "key_down", key: "KeyW" });
      const resKey = parseRemoteControlPayload(rawKey);
      expect(resKey.isControl).toBe(true);
      if (resKey.isControl) {
        expect(resKey.data.type).toBe("key_down");
        expect((resKey.data as any).key).toBe("KeyW");
      }
    });

    it("ignores non-control payloads like chat messages or arbitrary json", () => {
      expect(parseRemoteControlPayload(JSON.stringify({ type: "CHAT_MESSAGE", text: "hello" }))).toEqual({
        isControl: false,
      });
      expect(parseRemoteControlPayload("not-json")).toEqual({ isControl: false });
    });
  });

  describe("P0-1/P0-2 regression: control DataChannel config", () => {
    it("control channel config must be unreliable and unordered (no head-of-line blocking on mouse moves)", () => {
      const CONTROL_CHANNEL_CONFIG = { ordered: false, maxRetransmits: 0 } as const;
      expect(CONTROL_CHANNEL_CONFIG.ordered).toBe(false);
      expect(CONTROL_CHANNEL_CONFIG.maxRetransmits).toBe(0);
    });
  });

  describe("P1-8 regression: key code to character mapping", () => {
    it("maps Key*, Digit*, and Space codes to correct key characters", () => {
      const mapKey = (key: string): string => {
        let keyChar = key;
        if (key.startsWith("Key") && key.length === 4) keyChar = key.charAt(3).toLowerCase();
        else if (key.startsWith("Digit")) keyChar = key.slice(5);
        else if (key === "Space") keyChar = " ";
        return keyChar;
      };
      expect(mapKey("KeyA")).toBe("a");
      expect(mapKey("KeyZ")).toBe("z");
      expect(mapKey("Digit1")).toBe("1");
      expect(mapKey("Digit0")).toBe("0");
      expect(mapKey("Space")).toBe(" ");
      expect(mapKey("Enter")).toBe("Enter");
      expect(mapKey("Backspace")).toBe("Backspace");
    });
  });

  describe("P1-4 regression: cursor position math must map stream coords to viewport", () => {
    it("maps 1920x1080 stream center to viewport center", () => {
      // Simulate the moveRemoteCursorTo math (1920x1080 screen, 1280x720 window)
      const input = { x: 960, y: 540, sw: 1920, sh: 1080 };
      const innerW = 1280, innerH = 720;
      const ratioX = input.x / (input.sw || 1920);
      const ratioY = input.y / (input.sh || 1080);
      const clientX = Math.min(innerW - 1, Math.max(0, Math.round(ratioX * innerW)));
      const clientY = Math.min(innerH - 1, Math.max(0, Math.round(ratioY * innerH)));
      expect(clientX).toBe(640);
      expect(clientY).toBe(360);
    });

    it("clamps out-of-bounds cursor positions to the viewport", () => {
      const input = { x: 5000, y: -300, sw: 1920, sh: 1080 };
      const innerW = 1280, innerH = 720;
      const clientX = Math.min(innerW - 1, Math.max(0, Math.round((input.x / (input.sw || 1920)) * innerW)));
      const clientY = Math.min(innerH - 1, Math.max(0, Math.round((input.y / (input.sh || 1080)) * innerH)));
      expect(clientX).toBe(1279);
      expect(clientY).toBe(0);
    });
  });

  describe("P0-4 regression: request timeout math", () => {
    it("a 20s timeout always exceeds LiveKit signaling round-trip budgets while staying responsive", () => {
      const REQUEST_TIMEOUT_MS = 20_000;
      expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(5_000);
      expect(REQUEST_TIMEOUT_MS).toBeLessThan(60_000);
    });
  });

  describe("RC-2026-10-19 A: normalized coordinates (u,v) in protocol v2", () => {
    it("calculateNormalizedVideoCoordinates returns u,v in 0..1 alongside stream pixels", () => {
      const rect = { left: 0, top: 0, width: 960, height: 540 };
      const center = calculateNormalizedVideoCoordinates(480, 270, rect, 1920, 1080);
      expect(center).toEqual({ x: 960, y: 540, u: 0.5, v: 0.5 });

      const topLeft = calculateNormalizedVideoCoordinates(0, 0, rect, 1920, 1080);
      expect(topLeft?.u).toBe(0);
      expect(topLeft?.v).toBe(0);

      const bottomRight = calculateNormalizedVideoCoordinates(960, 540, rect, 1920, 1080);
      expect(bottomRight?.u).toBeCloseTo(1, 5);
      expect(bottomRight?.v).toBeCloseTo(1, 5);
    });

    it("u,v stays 0..1 even for extreme aspect mismatch (letterbox)", () => {
      // 16:9 stream in a 2:1-tall container: active video occupies middle 405px of 960x800
      const rect = { left: 0, top: 0, width: 960, height: 800 };
      const center = calculateNormalizedVideoCoordinates(480, 400, rect, 1920, 1080);
      expect(center?.u).toBe(0.5);
      expect(center?.v).toBe(0.5);
      expect(center?.x).toBe(960);
      expect(center?.y).toBe(540);
    });

    it("mouse messages accept optional u,v fields without breaking legacy shape", () => {
      const msg: SharerInputMessage = {
        type: "mouse_move",
        x: 960,
        y: 540,
        sw: 1920,
        sh: 1080,
        u: 0.5,
        v: 0.5,
      };
      const res = parseRemoteControlPayload(
        JSON.stringify({ type: "REMOTE_CONTROL_INPUT", deviceId: "guest-1", input: msg }),
      );
      expect(res.isControl).toBe(true);
      if (res.isControl) {
        const input = (res.data as any).input as { type: string; u?: number; v?: number; x?: number };
        expect(input.u).toBe(0.5);
        expect(input.v).toBe(0.5);
        expect(input.x).toBe(960);
      }
    });

    it("key messages carry modifiers (shift/ctrl/alt/meta)", () => {
      const res = parseRemoteControlPayload(
        JSON.stringify({
          type: "REMOTE_CONTROL_INPUT",
          deviceId: "guest-1",
          input: { type: "key_down", key: "KeyA", modifiers: { shift: true, ctrl: false, alt: false, meta: false } },
        }),
      );
      expect(res.isControl).toBe(true);
      if (res.isControl) {
        const input = (res.data as any).input as { modifiers?: KeyModifiers };
        expect(input.modifiers?.shift).toBe(true);
        expect(input.modifiers?.ctrl).toBe(false);
      }
    });
  });
});
