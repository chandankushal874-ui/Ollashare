/** Browser-only remote interaction protocol and coordinate utilities. */

/** Modifier state accompanying a remote key event (all optional for back-compat). */
export interface KeyModifiers {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/**
 * Sharer input protocol.
 *
 * v2 (2026-10-19): mouse messages additionally carry `u`/`v` — the pointer
 * position normalized to the ACTIVE VIDEO IMAGE in the range 0..1 (0,0 = top-left
 * of the actual picture, 1,1 = bottom-right). Stream-pixel fields (`x`,`y`,`sw`,`sh`)
 * remain available for browser coordinate fallback;
 * receivers SHOULD prefer `u`/`v` when present because they are immune to
 * host/guest resolution differences and letterboxing.
 * Key messages optionally carry `modifiers`.
 */
export interface BrowserPointerMetadata {
  pointerId?: number;
  pointerType?: "mouse" | "touch" | "pen";
}

export type SharerInputMessage =
  | ({ type: "mouse_move"; x: number; y: number; sw?: number; sh?: number; u?: number; v?: number } & BrowserPointerMetadata)
  | ({ type: "mouse_down"; x: number; y: number; button: "left" | "right" | "middle"; sw?: number; sh?: number; u?: number; v?: number } & BrowserPointerMetadata)
  | ({ type: "mouse_up"; x: number; y: number; button: "left" | "right" | "middle"; sw?: number; sh?: number; u?: number; v?: number } & BrowserPointerMetadata)
  | ({ type: "mouse_cancel"; x: number; y: number; button: "left" | "right" | "middle"; sw?: number; sh?: number; u?: number; v?: number } & BrowserPointerMetadata)
  | { type: "mouse_wheel"; x: number; y: number; dx: number; dy: number; deltaMode?: 0 | 1 | 2; sw?: number; sh?: number; u?: number; v?: number }
  | { type: "key_down"; key: string; keyValue?: string; repeat?: boolean; modifiers?: KeyModifiers }
  | { type: "key_up"; key: string; keyValue?: string; modifiers?: KeyModifiers };

/** Validate untrusted peer input before it reaches any DOM action. */
export function isValidBrowserInput(value: unknown): value is SharerInputMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (m.type === "key_down" || m.type === "key_up") {
    if (typeof m.key !== "string" || m.key.length === 0 || m.key.length > 64) return false;
    if (m.keyValue !== undefined && (typeof m.keyValue !== "string" || m.keyValue.length === 0 || m.keyValue.length > 64)) return false;
    if (m.repeat !== undefined && typeof m.repeat !== "boolean") return false;
    return m.modifiers === undefined || (m.modifiers !== null && typeof m.modifiers === "object" &&
      Object.entries(m.modifiers).every(([k, v]) => ["shift", "ctrl", "alt", "meta"].includes(k) && typeof v === "boolean"));
  }
  if (!["mouse_move", "mouse_down", "mouse_up", "mouse_cancel", "mouse_wheel"].includes(String(m.type))) return false;
  if (!finite(m.x) || !finite(m.y) || m.x < 0 || m.y < 0 || m.x > 100000 || m.y > 100000) return false;
  for (const k of ["sw", "sh"]) if (m[k] !== undefined && (!finite(m[k]) || m[k] <= 0 || m[k] > 100000)) return false;
  if ((m.u === undefined) !== (m.v === undefined)) return false;
  for (const k of ["u", "v"]) if (m[k] !== undefined && (!finite(m[k]) || m[k] < 0 || m[k] > 1)) return false;
  if (m.type === "mouse_wheel") return finite(m.dx) && finite(m.dy) && Math.abs(m.dx) <= 100000 && Math.abs(m.dy) <= 100000 &&
    (m.deltaMode === undefined || m.deltaMode === 0 || m.deltaMode === 1 || m.deltaMode === 2);
  if (m.pointerId !== undefined && (!Number.isSafeInteger(m.pointerId) || (m.pointerId as number) < 0)) return false;
  if (m.pointerType !== undefined && !["mouse", "touch", "pen"].includes(String(m.pointerType))) return false;
  return m.type === "mouse_move" || ["left", "right", "middle"].includes(String(m.button));
}

export type RemoteControlStatus = "idle" | "requesting" | "active";

export interface IncomingControlRequest {
  hostId: string;
  hostName: string;
  deviceId: string;
}

export interface RemoteCursorState {
  x: number;
  y: number;
  clicking: string | false;
  lastActive: number;
}

export type RemoteControlMessage =
  | {
    type: "REMOTE_CONTROL_REQUEST";
    hostId: string;
    hostName: string;
    deviceId: string;
    targetUserId: string;
  }
  | {
    type: "REMOTE_CONTROL_RESPONSE";
    accepted: boolean;
    deviceId: string;
    hostId: string;
    guestId: string;
    guestName?: string;
  }
  | {
    type: "REMOTE_CONTROL_REVOKE";
    deviceId: string;
    by: "host" | "guest";
    hostId?: string;
    guestId?: string;
    guestName?: string;
  }
  | {
    type: "REMOTE_CONTROL_INPUT";
    deviceId: string;
    input: SharerInputMessage;
  };

/**
 * Letterbox/pillarbox adjusted coordinate normalization
 * Maps DOM client coordinates on a <video> element with object-contain to native video pixel coordinates.
 * Returns `u`/`v` — the same point normalized to the active image in 0..1 — alongside
 * stream pixels, so receivers can map onto ANY viewport without knowing the stream size.
 */
export function calculateNormalizedVideoCoordinates(
  clientX: number,
  clientY: number,
  videoRect: { left: number; top: number; width: number; height: number },
  videoNativeWidth: number = 1920,
  videoNativeHeight: number = 1080
): { x: number; y: number; u: number; v: number } | null {
  const nativeWidth = videoNativeWidth;
  const nativeHeight = videoNativeHeight;

  // Fail closed before metadata, during hidden layouts, or on invalid geometry.
  if (![clientX, clientY, videoRect.left, videoRect.top, videoRect.width, videoRect.height, nativeWidth, nativeHeight].every(Number.isFinite) ||
    videoRect.width <= 0 || videoRect.height <= 0 || nativeWidth <= 0 || nativeHeight <= 0) return null;
  const videoRatio = nativeWidth / nativeHeight;
  const containerRatio = videoRect.width / videoRect.height;

  let displayWidth = videoRect.width;
  let displayHeight = videoRect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (containerRatio > videoRatio) {
    // Pillarbox (bars left & right)
    displayWidth = videoRect.height * videoRatio;
    offsetX = (videoRect.width - displayWidth) / 2;
  } else {
    // Letterbox (bars top & bottom)
    displayHeight = videoRect.width / videoRatio;
    offsetY = (videoRect.height - displayHeight) / 2;
  }

  const relX = clientX - videoRect.left - offsetX;
  const relY = clientY - videoRect.top - offsetY;

  if (relX < 0 || relX > displayWidth || relY < 0 || relY > displayHeight) {
    return null; // outside active video bounds
  }

  const x = (relX / displayWidth) * nativeWidth;
  const y = (relY / displayHeight) * nativeHeight;

  return {
    x: Math.max(0, Math.min(nativeWidth - 1, x)),
    y: Math.max(0, Math.min(nativeHeight - 1, y)),
    u: Math.max(0, Math.min(1, relX / displayWidth)),
    v: Math.max(0, Math.min(1, relY / displayHeight)),
  };
}

/**
 * Validates and parses inbound control messages (either enveloped or raw sharer protocol)
 */
export function parseRemoteControlPayload(
  raw: string
): { isControl: true; data: RemoteControlMessage | SharerInputMessage } | { isControl: false } {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.type) {
      return { isControl: false };
    }

    const type = parsed.type;
    if (
      type === "REMOTE_CONTROL_REQUEST" ||
      type === "REMOTE_CONTROL_RESPONSE" ||
      type === "REMOTE_CONTROL_REVOKE" ||
      type === "REMOTE_CONTROL_INPUT" ||
      type === "mouse_move" ||
      type === "mouse_down" ||
      type === "mouse_up" ||
      type === "mouse_cancel" ||
      type === "mouse_wheel" ||
      type === "key_down" ||
      type === "key_up"
    ) {
      return { isControl: true, data: parsed };
    }
    return { isControl: false };
  } catch {
    return { isControl: false };
  }
}
