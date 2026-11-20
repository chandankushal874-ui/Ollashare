export const MAX_SIGNAL_DEVICE_ID_CHARS = 160;
export const MAX_SIGNAL_CONNECTIONS_PER_SENDER = 12;
export const MAX_SIGNAL_ICE_PER_CONNECTION = 64;

type SignalType = "offer" | "answer" | "candidate";

type OfferSignal = {
  deviceId: string;
  offer: RTCSessionDescriptionInit;
  answer?: never;
  candidate?: never;
  direction?: never;
  device?: {
    id: string;
    deviceName?: string;
    ownerName?: string;
    resolution?: string;
    fps?: number;
    startedAt?: number;
  };
};

type AnswerSignal = {
  deviceId: string;
  answer: RTCSessionDescriptionInit;
  offer?: never;
  candidate?: never;
  direction?: never;
  device?: never;
};

type CandidateSignal = {
  deviceId: string;
  candidate: RTCIceCandidateInit;
  direction?: "in" | "out";
  offer?: never;
  answer?: never;
  device?: never;
};

type ParsedSignal = OfferSignal | AnswerSignal | CandidateSignal;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SIGNAL_DEVICE_ID_CHARS;
}

function isDescription(value: unknown, expectedType: "offer" | "answer"): value is RTCSessionDescriptionInit {
  if (!isRecord(value) || value.type !== expectedType) return false;
  return typeof value.sdp === "string" && value.sdp.length > 0;
}

function isCandidate(value: unknown): value is RTCIceCandidateInit {
  if (!isRecord(value) || typeof value.candidate !== "string" || value.candidate.length === 0) return false;
  if (value.sdpMid !== undefined && value.sdpMid !== null && typeof value.sdpMid !== "string") return false;
  if (value.sdpMLineIndex !== undefined && value.sdpMLineIndex !== null &&
    (!Number.isInteger(value.sdpMLineIndex) || (value.sdpMLineIndex as number) < 0)) return false;
  if (value.usernameFragment !== undefined && value.usernameFragment !== null && typeof value.usernameFragment !== "string") return false;
  return true;
}

export function parseMeshSignal(type: SignalType, payload: string): ParsedSignal | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isDeviceId(value.deviceId)) return null;

  if (type === "offer") {
    if (!isDescription(value.offer, "offer")) return null;
    if (value.deviceId !== "mira-chat-p2p" && value.device === undefined) return null;
    if (value.device !== undefined) {
      if (!isRecord(value.device) || value.device.id !== value.deviceId) return null;
    }
    return value as ParsedSignal;
  }
  if (type === "answer") {
    return isDescription(value.answer, "answer") ? value as ParsedSignal : null;
  }
  if (!isCandidate(value.candidate)) return null;
  if (value.direction !== undefined && value.direction !== "in" && value.direction !== "out") return null;
  return value as ParsedSignal;
}

export function canCreateSignalConnection(
  peerConnections: ReadonlyMap<string, RTCPeerConnection>,
  senderId: string,
  connKey: string,
): boolean {
  if (peerConnections.has(connKey)) return true;
  let count = 0;
  for (const key of peerConnections.keys()) {
    if (key === `chat_${senderId}` || key.endsWith(`_${senderId}`)) count += 1;
  }
  return count < MAX_SIGNAL_CONNECTIONS_PER_SENDER;
}

export function enqueueSignalCandidate(
  queues: Map<string, RTCIceCandidateInit[]>,
  connKey: string,
  candidate: RTCIceCandidateInit,
): boolean {
  const queue = queues.get(connKey) ?? [];
  if (queue.length >= MAX_SIGNAL_ICE_PER_CONNECTION) return false;
  queue.push(candidate);
  queues.set(connKey, queue);
  return true;
}
