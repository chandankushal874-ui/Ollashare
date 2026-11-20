export const COLLABORATION_TRANSPORT_LIMITS = {
	maxPayloadBytes: 16_384,
	windowMs: 1_000,
	maxSenders: 128,
	ignoreAfterViolations: 3,
	disconnectAfterViolations: 6,
	violationWindowMs: 30_000,
	ignoreDurationMs: 30_000,
	messageTypes: {
		annotation: { maxPayloadBytes: 12_288, maxMessages: 60, maxBytes: 196_608 },
		presentation: { maxPayloadBytes: 8_192, maxMessages: 20, maxBytes: 65_536 },
		control: { maxPayloadBytes: 4_096, maxMessages: 120, maxBytes: 98_304 },
		system: { maxPayloadBytes: 4_096, maxMessages: 10, maxBytes: 16_384 },
		unknown: { maxPayloadBytes: 2_048, maxMessages: 10, maxBytes: 8_192 },
	},
	aggregate: { maxMessages: 160, maxBytes: 262_144 },
} as const;

export type CollaborationMessageKind = keyof typeof COLLABORATION_TRANSPORT_LIMITS.messageTypes;
export type CollaborationFloodDecision = "accept" | "ignore" | "disconnect";

type BucketEntry = Readonly<{ at: number; bytes: number }>;
type SenderState = {
	aggregate: BucketEntry[];
	byType: Record<CollaborationMessageKind, BucketEntry[]>;
	violations: number[];
	ignoredUntil: number;
	blocked: boolean;
};

const messageTypes = COLLABORATION_TRANSPORT_LIMITS.messageTypes;

export function collaborationPayloadBytes(value: string | Uint8Array): number {
	return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}

export function classifyCollaborationMessage(value: unknown): CollaborationMessageKind {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
	const type = (value as Record<string, unknown>).type;
	if (typeof type !== "string") return "unknown";
	if (type.startsWith("SCREEN_ANNOTATION_")) return "annotation";
	if (type === "STAGE_MODE_CHANGE" || type.startsWith("PRESENTATION_")) return "presentation";
	if (type.startsWith("REMOTE_CONTROL_") || type.startsWith("mouse_") || type.startsWith("key_")) return "control";
	if (type === "KICK_NOTICE" || type === "SHARED_BROWSER_CONTROLLER_CHANGED") return "system";
	return "unknown";
}

function emptyTypeBuckets(): Record<CollaborationMessageKind, BucketEntry[]> {
	return { annotation: [], presentation: [], control: [], system: [], unknown: [] };
}

function trim(entries: BucketEntry[], now: number): BucketEntry[] {
	const after = now - COLLABORATION_TRANSPORT_LIMITS.windowMs;
	return entries.filter((entry) => entry.at > after && entry.at <= now);
}

function totalBytes(entries: readonly BucketEntry[]): number {
	return entries.reduce((total, entry) => total + entry.bytes, 0);
}

export function isCollaborationPayloadWithinLimit(
	guard: CollaborationFloodGuard,
	sender: string | undefined,
	payload: string | Uint8Array,
	now = Date.now(),
): CollaborationFloodDecision {
	const bytes = collaborationPayloadBytes(payload);
	if (bytes > COLLABORATION_TRANSPORT_LIMITS.maxPayloadBytes) {
		return guard.assess(sender, "unknown", bytes, now);
	}
	if (typeof payload !== "string") return guard.assess(sender, "unknown", bytes, now);
	try {
		const parsed: unknown = JSON.parse(payload);
		return guard.assess(sender, classifyCollaborationMessage(parsed), bytes, now);
	} catch {
		return guard.assess(sender, "unknown", bytes, now);
	}
}

export class CollaborationFloodGuard {
	private readonly senders = new Map<string, SenderState>();

	isBlocked(sender: string): boolean {
		return this.senders.get(sender)?.blocked === true;
	}

	assess(sender: string | undefined, kind: CollaborationMessageKind, bytes: number, now = Date.now()): CollaborationFloodDecision {
		if (!sender || !Number.isFinite(bytes) || bytes < 0) return "ignore";
		const state = this.getSender(sender, now);
		if (state.blocked) return "disconnect";
		if (state.ignoredUntil > now) {
			if (bytes > COLLABORATION_TRANSPORT_LIMITS.maxPayloadBytes || bytes > messageTypes[kind].maxPayloadBytes) {
				return this.violation(state, now);
			}
			return "ignore";
		}

		const typeLimit = messageTypes[kind];
		state.aggregate = trim(state.aggregate, now);
		state.byType[kind] = trim(state.byType[kind], now);
		const aggregateMessages = state.aggregate.length;
		const aggregateBytes = totalBytes(state.aggregate);
		const typeMessages = state.byType[kind].length;
		const typeBytes = totalBytes(state.byType[kind]);
		const exceeds =
			bytes > COLLABORATION_TRANSPORT_LIMITS.maxPayloadBytes ||
			bytes > typeLimit.maxPayloadBytes ||
			aggregateMessages >= COLLABORATION_TRANSPORT_LIMITS.aggregate.maxMessages ||
			aggregateBytes + bytes > COLLABORATION_TRANSPORT_LIMITS.aggregate.maxBytes ||
			typeMessages >= typeLimit.maxMessages ||
			typeBytes + bytes > typeLimit.maxBytes;

		if (exceeds) return this.violation(state, now);
		const entry = { at: now, bytes };
		state.aggregate.push(entry);
		state.byType[kind].push(entry);
		return "accept";
	}

	private getSender(sender: string, now: number): SenderState {
		const existing = this.senders.get(sender);
		if (existing) {
			this.senders.delete(sender);
			this.senders.set(sender, existing);
			return existing;
		}
		if (this.senders.size >= COLLABORATION_TRANSPORT_LIMITS.maxSenders) {
			const oldest = this.senders.keys().next().value;
			if (oldest !== undefined) this.senders.delete(oldest);
		}
		const state: SenderState = {
			aggregate: [],
			byType: emptyTypeBuckets(),
			violations: [],
			ignoredUntil: now,
			blocked: false,
		};
		this.senders.set(sender, state);
		return state;
	}

	private violation(state: SenderState, now: number): CollaborationFloodDecision {
		state.violations = state.violations.filter(
			(timestamp) => timestamp > now - COLLABORATION_TRANSPORT_LIMITS.violationWindowMs,
		);
		state.violations.push(now);
		if (state.violations.length >= COLLABORATION_TRANSPORT_LIMITS.disconnectAfterViolations) {
			state.blocked = true;
			return "disconnect";
		}
		if (state.violations.length >= COLLABORATION_TRANSPORT_LIMITS.ignoreAfterViolations) {
			state.ignoredUntil = now + COLLABORATION_TRANSPORT_LIMITS.ignoreDurationMs;
		}
		return "ignore";
	}
}
