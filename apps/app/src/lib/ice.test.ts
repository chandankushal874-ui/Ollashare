import { describe, expect, it } from "vitest";
import {
  DEFAULT_STUN_SERVERS,
  buildIceServers,
  buildRtcConfiguration,
} from "./ice";

describe("buildIceServers (RFC 8656 / RFC 7635 NAT traversal)", () => {
  it("defaults to standard Google STUN servers when env is empty", () => {
    const servers = buildIceServers({});
    expect(servers).toHaveLength(1);
    expect(servers[0]!.urls).toEqual(DEFAULT_STUN_SERVERS);
    expect(servers[0]!.username).toBeUndefined();
    expect(servers[0]!.credential).toBeUndefined();
  });

  it("supports custom comma-separated STUN endpoints", () => {
    const servers = buildIceServers({
      NEXT_PUBLIC_STUN_URLS: "stun:stun.cloudflare.com:3478, stun:stun.l.google.com:19302",
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.urls).toEqual([
      "stun:stun.cloudflare.com:3478",
      "stun:stun.l.google.com:19302",
    ]);
  });

  it("assembles both STUN and authenticated TURN servers when TURN is configured", () => {
    const servers = buildIceServers({
      NEXT_PUBLIC_TURN_URL: "turn:relay.example.com:3478?transport=udp",
      NEXT_PUBLIC_TURN_USERNAME: "alice",
      NEXT_PUBLIC_TURN_CREDENTIAL: "secretpassword123",
    });

    expect(servers).toHaveLength(2);
    // STUN entry preserved
    expect(servers[0]!.urls).toEqual(DEFAULT_STUN_SERVERS);
    // TURN entry configured
    expect(servers[1]!.urls).toEqual(["turn:relay.example.com:3478?transport=udp"]);
    expect(servers[1]!.username).toBe("alice");
    expect(servers[1]!.credential).toBe("secretpassword123");
  });

  it("correctly preserves TLS 'turns:' entries on port 5349", () => {
    const servers = buildIceServers({
      NEXT_PUBLIC_TURN_URL: "turns:turn.example.com:5349?transport=tcp",
      NEXT_PUBLIC_TURN_USERNAME: "user-token",
      NEXT_PUBLIC_TURN_CREDENTIAL: "token-secret",
    });

    expect(servers).toHaveLength(2);
    expect(servers[1]!.urls).toEqual(["turns:turn.example.com:5349?transport=tcp"]);
  });

  it("parses multiple comma-separated TURN URLs and deduplicates", () => {
    const servers = buildIceServers({
      NEXT_PUBLIC_TURN_URL: "turn:turn1.example.com:3478",
      NEXT_PUBLIC_TURN_URLS: "turn:turn1.example.com:3478, turn:turn2.example.com:3478, turns:turn3.example.com:5349",
      NEXT_PUBLIC_TURN_USERNAME: "global-user",
      NEXT_PUBLIC_TURN_CREDENTIAL: "global-cred",
    });

    expect(servers).toHaveLength(2);
    expect(servers[1]!.urls).toEqual([
      "turn:turn1.example.com:3478",
      "turn:turn2.example.com:3478",
      "turns:turn3.example.com:5349",
    ]);
    expect(servers[1]!.username).toBe("global-user");
    expect(servers[1]!.credential).toBe("global-cred");
  });

  it("builds a full RTCConfiguration wrapping the iceServers", () => {
    const config = buildRtcConfiguration({
      NEXT_PUBLIC_TURN_URL: "turn:relay.example.com:3478",
    });
    expect(config).toBeDefined();
    expect(config.iceServers).toBeDefined();
    expect(config.iceServers!).toHaveLength(2);
  });
});
