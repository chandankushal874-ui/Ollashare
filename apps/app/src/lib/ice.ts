/**
 * WebRTC ICE Server Configuration Builder
 *
 * Implements RFC 8656 (TURN) and RFC 7635 (REST-auth model) configuration assembly.
 * Enables seamless NAT traversal for symmetric-NAT, CGNAT, and corporate networks.
 *
 * Defaults gracefully to Google STUN endpoints when TURN environment variables are unset.
 */

export interface IceEnv {
  NEXT_PUBLIC_STUN_URLS?: string | undefined;
  STUN_URLS?: string | undefined;
  NEXT_PUBLIC_TURN_URL?: string | undefined;
  NEXT_PUBLIC_TURN_URLS?: string | undefined;
  TURN_URLS?: string | undefined;
  NEXT_PUBLIC_TURN_USERNAME?: string | undefined;
  TURN_USERNAME?: string | undefined;
  NEXT_PUBLIC_TURN_CREDENTIAL?: string | undefined;
  TURN_CREDENTIAL?: string | undefined;
  NEXT_PUBLIC_TURN_PASSWORD?: string | undefined;
  [key: string]: string | undefined;
}

export const DEFAULT_STUN_SERVERS: string[] = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
  "stun:stun.nextcloud.com:443",
  "stun:stun.nextcloud.com:3478",
];

export function buildIceServers(
  env: Record<string, string | undefined> = typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {},
): RTCIceServer[] {
  // 1. Determine STUN URLs
  const stunRaw = env.NEXT_PUBLIC_STUN_URLS || env.STUN_URLS;
  const stunUrls: string[] = stunRaw
    ? stunRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_STUN_SERVERS];

  const iceServers: RTCIceServer[] = [
    {
      urls: stunUrls,
    },
  ];

  // 2. Determine TURN / TURNS URLs
  const turnCandidates: string[] = [];
  if (env.NEXT_PUBLIC_TURN_URL) {
    turnCandidates.push(env.NEXT_PUBLIC_TURN_URL);
  }
  const multiTurnRaw = env.NEXT_PUBLIC_TURN_URLS || env.TURN_URLS;
  if (multiTurnRaw) {
    turnCandidates.push(...multiTurnRaw.split(","));
  }

  const turnUrls = Array.from(
    new Set(turnCandidates.map((s) => s.trim()).filter(Boolean)),
  );

  if (turnUrls.length > 0) {
    const username = env.NEXT_PUBLIC_TURN_USERNAME || env.TURN_USERNAME;
    const credential =
      env.NEXT_PUBLIC_TURN_CREDENTIAL ||
      env.TURN_CREDENTIAL ||
      env.NEXT_PUBLIC_TURN_PASSWORD;

    const turnServer: RTCIceServer = {
      urls: turnUrls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    };

    iceServers.push(turnServer);
  }

  return iceServers;
}

export function buildRtcConfiguration(
  env: Record<string, string | undefined> = typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {},
): RTCConfiguration {
  return {
    iceServers: buildIceServers(env),
  };
}
