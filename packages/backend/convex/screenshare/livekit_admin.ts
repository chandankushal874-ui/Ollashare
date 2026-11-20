import { RoomServiceClient, TrackSource } from "livekit-server-sdk";

/**
 * Returns a configured LiveKit RoomServiceClient instance.
 * Converts ws:// or wss:// URLs to http:// or https:// for twirp HTTP RPC.
 * Returns null when env is genuinely absent (empty URL), NOT when it merely
 * lacks the dev default — so production missing creds are not silently masked.
 */
export function getRoomServiceClient(): RoomServiceClient | null {
  const url = process.env.LIVEKIT_URL || "ws://127.0.0.1:7880";
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!url || !apiKey || !apiSecret || apiKey === "devkey" || apiSecret === "secret") {
    return null;
  }

  const httpUrl = url.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  return new RoomServiceClient(httpUrl, apiKey, apiSecret);
}

/** Classifies a LiveKit SDK error as an authentication/authorization failure. */
export function isLiveKitAuthError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    return /unauthorized|401|forbidden|403|api key|authentication/i.test(msg);
  }
  return false;
}

function isLiveKitParticipantAbsentError(err: unknown): boolean {
  return err instanceof Error && /participant.*not found|not found.*participant|participant.*does not exist/i.test(err.message);
}

export type LiveKitAdminResult =
  | { ok: true }
  | { ok: false; failureKind: "auth" | "transient"; error: string };

function adminFailure(error: string, failureKind: "auth" | "transient"): LiveKitAdminResult {
  return { ok: false, failureKind, error };
}

function missingAdminCredentials(): LiveKitAdminResult {
  return adminFailure("LiveKit admin credentials are missing or insecure", "auth");
}

async function participantOperation(
  operation: "eviction" | "publish downgrade",
  roomCode: string,
  identity: string,
  run: (client: RoomServiceClient) => Promise<unknown>,
): Promise<LiveKitAdminResult> {
  try {
    const client = getRoomServiceClient();
    if (!client) return missingAdminCredentials();
    await run(client);
    return { ok: true };
  } catch (err) {
    if (isLiveKitParticipantAbsentError(err)) return { ok: true };
    const error = err instanceof Error ? err.message : String(err);
    const failureKind = isLiveKitAuthError(err) ? "auth" : "transient";
    if (failureKind === "auth") {
      console.error(
        `[livekit-admin] Participant ${operation} FAILED — LiveKit authentication error (check LIVEKIT_API_KEY/SECRET):`,
        error,
      );
    } else {
      console.warn(
        `[livekit-admin] Participant ${operation} for ${identity} in room ${roomCode} failed and will be retried:`,
        error,
      );
    }
    return adminFailure(error, failureKind);
  }
}

export async function evictParticipant(
  roomCode: string,
  identity: string,
): Promise<LiveKitAdminResult> {
  return participantOperation("eviction", roomCode, identity, (client) =>
    client.removeParticipant(roomCode, identity),
  );
}

export async function downgradePublishPermission(
  roomCode: string,
  identity: string,
): Promise<LiveKitAdminResult> {
  return participantOperation("publish downgrade", roomCode, identity, (client) =>
    client.updateParticipant(roomCode, identity, {
      permission: {
        canPublish: false,
        canPublishSources: [],
        canSubscribe: true,
        canPublishData: true,
      },
    }),
  );
}

/**
 * Grants publish rights to an already-connected participant, in place.
 *
 * LiveKit applies the change to the live SFU session immediately (the client
 * receives a ParticipantPermissionUpdate signal) — no disconnect/reconnect is
 * required, so other participants never observe churn and the same-identity
 * reconnect race (missed TrackSubscribed on fast re-join) cannot occur.
 *
 * Permissions are updated atomically: every desired permission must be set.
 * Safe fallback: never throws; returns false when the grant could not be
 * applied (SFU offline, participant not yet connected) so callers can fall
 * back to the reconnect-with-publish-token path.
 */
export async function grantPublishPermission(
  roomCode: string,
  identity: string,
): Promise<boolean> {
  try {
    const client = getRoomServiceClient();
    if (!client) return false;
    await client.updateParticipant(roomCode, identity, {
      permission: {
        canPublish: true,
        canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
        canSubscribe: true,
        canPublishData: true,
      },
    });
    return true;
  } catch (err) {
    console.warn(
      `[livekit-admin] Publish grant for ${identity} in room ${roomCode} skipped (LiveKit SFU offline or participant not connected):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Teardowns and deletes a LiveKit SFU room.
 * Invoked on endRoom, forceEndRoom, and autoEndStaleRoomsHandler watchdog.
 * Safe fallback: idempotent in LiveKit, never throws.
 */
export async function teardownLiveKitRoom(roomCode: string): Promise<LiveKitAdminResult> {
  try {
    const client = getRoomServiceClient();
    if (!client) {
      return missingAdminCredentials();
    }
    await client.deleteRoom(roomCode);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failureKind = isLiveKitAuthError(err) ? "auth" : "transient";
    if (failureKind === "auth") {
      console.error(
        `[livekit-admin] Room teardown FAILED — LiveKit authentication error (check LIVEKIT_API_KEY/SECRET):`,
        error,
      );
    } else {
      console.warn(
        `[livekit-admin] Room teardown for ${roomCode} failed and will be retried:`,
        error,
      );
    }
    return adminFailure(error, failureKind);
  }
}
