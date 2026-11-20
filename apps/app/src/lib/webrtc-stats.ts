export interface PeerConnectionStats {
  rttMs?: number;
  bytesReceived?: number;
  bytesSent?: number;
}

/**
 * Extracts key WebRTC diagnostic metrics (RTT, bytes transferred)
 * from an RTCStatsReport for observability and monitoring.
 */
export function extractPeerStats(
  reports: Iterable<[string, any]> | any[],
): PeerConnectionStats {
  let rttMs: number | undefined;
  let bytesReceived: number | undefined;
  let bytesSent: number | undefined;

  const entries: any[] = Array.isArray(reports)
    ? reports
    : Array.from(reports, ([, v]) => v);

  for (const report of entries) {
    if (!report || typeof report !== "object") continue;

    if (
      report.type === "candidate-pair" &&
      (report.state === "succeeded" || report.nominated === true)
    ) {
      if (typeof report.currentRoundTripTime === "number") {
        rttMs = Math.round(report.currentRoundTripTime * 1000);
      }
    } else if (report.type === "inbound-rtp" && report.kind === "video") {
      if (typeof report.bytesReceived === "number") {
        bytesReceived = report.bytesReceived;
      }
    } else if (report.type === "outbound-rtp" && report.kind === "video") {
      if (typeof report.bytesSent === "number") {
        bytesSent = report.bytesSent;
      }
    }
  }

  return { rttMs, bytesReceived, bytesSent };
}
