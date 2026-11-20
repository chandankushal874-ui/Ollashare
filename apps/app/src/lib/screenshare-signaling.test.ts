import { describe, expect, test } from "vitest";
import {
  MAX_SIGNAL_CONNECTIONS_PER_SENDER,
  MAX_SIGNAL_ICE_PER_CONNECTION,
  canCreateSignalConnection,
  enqueueSignalCandidate,
  parseMeshSignal,
} from "./screenshare-signaling";

describe("screenshare signaling guards", () => {
  test("drops malformed signal JSON and invalid schemas", () => {
    expect(parseMeshSignal("offer", "{")).toBeNull();
    expect(parseMeshSignal("offer", JSON.stringify({ deviceId: "d", offer: { type: "answer", sdp: "x" } }))).toBeNull();
    expect(parseMeshSignal("candidate", JSON.stringify({ deviceId: "d", candidate: {} }))).toBeNull();
  });

  test("accepts conservative browser-compatible descriptions and candidates", () => {
    expect(parseMeshSignal("offer", JSON.stringify({ deviceId: "d", offer: { type: "offer", sdp: "v=0" }, device: { id: "d" } })))
      .toMatchObject({ deviceId: "d", offer: { type: "offer" } });
    expect(parseMeshSignal("candidate", JSON.stringify({
      deviceId: "d",
      direction: "out",
      candidate: { candidate: "candidate:1", sdpMid: null, sdpMLineIndex: 0 },
    }))).toMatchObject({ deviceId: "d", direction: "out" });
  });

  test("caps queued ICE candidates per connection", () => {
    const queues = new Map<string, RTCIceCandidateInit[]>();
    for (let i = 0; i < MAX_SIGNAL_ICE_PER_CONNECTION; i += 1) {
      expect(enqueueSignalCandidate(queues, "conn", { candidate: `candidate:${i}` })).toBe(true);
    }
    expect(enqueueSignalCandidate(queues, "conn", { candidate: "candidate:overflow" })).toBe(false);
    expect(queues.get("conn")).toHaveLength(MAX_SIGNAL_ICE_PER_CONNECTION);
  });

  test("caps peer connections per sender without blocking an existing key", () => {
    const connections = new Map<string, RTCPeerConnection>();
    for (let i = 0; i < MAX_SIGNAL_CONNECTIONS_PER_SENDER; i += 1) {
      connections.set(`in_device-${i}_sender`, {} as RTCPeerConnection);
    }
    expect(canCreateSignalConnection(connections, "sender", "in_new_sender")).toBe(false);
    expect(canCreateSignalConnection(connections, "sender", "in_device-0_sender")).toBe(true);
    expect(canCreateSignalConnection(connections, "other", "in_new_other")).toBe(true);
  });
});
