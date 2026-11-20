import { describe, expect, test } from "vitest";
import { extractPeerStats } from "./webrtc-stats";

describe("extractPeerStats", () => {
  test("extracts RTT from active candidate-pair report", () => {
    const mockReports = [
      {
        type: "candidate-pair",
        state: "succeeded",
        currentRoundTripTime: 0.045, // 45ms
      },
    ];

    const stats = extractPeerStats(mockReports);
    expect(stats.rttMs).toBe(45);
  });

  test("extracts inbound and outbound bytes from video RTP reports", () => {
    const mockReports = [
      {
        type: "inbound-rtp",
        kind: "video",
        bytesReceived: 1048576,
      },
      {
        type: "outbound-rtp",
        kind: "video",
        bytesSent: 2097152,
      },
    ];

    const stats = extractPeerStats(mockReports);
    expect(stats.bytesReceived).toBe(1048576);
    expect(stats.bytesSent).toBe(2097152);
  });

  test("handles empty or irrelevant reports gracefully", () => {
    const stats = extractPeerStats([]);
    expect(stats.rttMs).toBeUndefined();
    expect(stats.bytesReceived).toBeUndefined();
    expect(stats.bytesSent).toBeUndefined();
  });

  test("ignores non-succeeded candidate pairs", () => {
    const mockReports = [
      {
        type: "candidate-pair",
        state: "failed",
        currentRoundTripTime: 0.12,
      },
    ];

    const stats = extractPeerStats(mockReports);
    expect(stats.rttMs).toBeUndefined();
  });
});
