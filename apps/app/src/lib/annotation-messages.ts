import type { AnnotationTarget } from "./annotation-types";

export const ANNOTATION_LIMITS = {
	authorIdLength: 160,
	authorNameLength: 80,
	targetIdLength: 128,
	strokeIdLength: 128,
	maxPoints: 256,
	maxMessageBytes: 12_288,
	maxStrokesPerTarget: 100,
	maxPointsPerTarget: 4_096,
	maxStrokeAuthors: 256,
	maxAuthorsWithRateState: 128,
	minWidth: 1,
	maxWidth: 32,
	maxMessagesPerWindow: 60,
	rateWindowMs: 1_000,
	maxActiveTargets: 4,
	minHighlighterOpacity: 0.1,
	maxHighlighterOpacity: 0.6,
} as const;

export type AnnotationTargetType = "screen" | "shared-browser";

export type AnnotationPoint = Readonly<{ u: number; v: number }>;

export type AnnotationStroke = Readonly<{
	id: string;
	color: string;
	width: number;
	tool?: "pen" | "highlighter";
	opacity?: number;
	points: readonly AnnotationPoint[];
}>;

type AnnotationMessageBase = Readonly<{
	authorId: string;
	authorName: string;
	targetType: AnnotationTargetType;
	targetId: string;
}>;

export type AnnotationMessage =
	| (AnnotationMessageBase &
		Readonly<{ type: "SCREEN_ANNOTATION_STROKE"; stroke: AnnotationStroke }>)
	| (AnnotationMessageBase &
		Readonly<{ type: "SCREEN_ANNOTATION_ERASE"; strokeId: string }>)
	| (AnnotationMessageBase &
		Readonly<{ type: "SCREEN_ANNOTATION_CLEAR"; authorIdToClear?: string }>);

export type AnnotationPermissionSnapshot = Readonly<{
	permittedGuestIds: readonly string[] | ReadonlySet<string>;
	strokeAuthors?: Readonly<Record<string, string>>;
}>;

const annotationTypes = new Set([
	"SCREEN_ANNOTATION_STROKE",
	"SCREEN_ANNOTATION_ERASE",
	"SCREEN_ANNOTATION_CLEAR",
]);

function isBoundedString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maxLength
	);
}

function isValidPoint(value: unknown): value is AnnotationPoint {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { u, v } = value as Record<string, unknown>;
	return (
		typeof u === "number" &&
		Number.isFinite(u) &&
		u >= 0 &&
		u <= 1 &&
		typeof v === "number" &&
		Number.isFinite(v) &&
		v >= 0 &&
		v <= 1
	);
}

function isValidStroke(value: unknown): value is AnnotationStroke {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const stroke = value as Record<string, unknown>;
	const tool = stroke.tool ?? "pen";
	const validStyle =
		(tool === "pen" && (stroke.opacity === undefined || stroke.opacity === 1)) ||
		(tool === "highlighter" &&
			typeof stroke.opacity === "number" &&
			Number.isFinite(stroke.opacity) &&
			stroke.opacity >= ANNOTATION_LIMITS.minHighlighterOpacity &&
			stroke.opacity <= ANNOTATION_LIMITS.maxHighlighterOpacity);
	return (
		isBoundedString(stroke.id, ANNOTATION_LIMITS.strokeIdLength) &&
		typeof stroke.color === "string" &&
		/^#[0-9a-f]{6}$/i.test(stroke.color) &&
		typeof stroke.width === "number" &&
		Number.isFinite(stroke.width) &&
		stroke.width >= ANNOTATION_LIMITS.minWidth &&
		stroke.width <= ANNOTATION_LIMITS.maxWidth &&
		validStyle &&
		Array.isArray(stroke.points) &&
		stroke.points.length >= 2 &&
		stroke.points.length <= ANNOTATION_LIMITS.maxPoints &&
		stroke.points.every(isValidPoint)
	);
}

export function isAnnotationMessage(
	value: Record<string, unknown>,
): value is AnnotationMessage {
	if (!annotationTypes.has(String(value.type))) return false;
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return false;
	}
	if (serialized === undefined) return false;
	const encodedBytes = new TextEncoder().encode(serialized).byteLength;
	if (encodedBytes > ANNOTATION_LIMITS.maxMessageBytes) return false;
	if (!isBoundedString(value.authorId, ANNOTATION_LIMITS.authorIdLength))
		return false;
	if (!isBoundedString(value.authorName, ANNOTATION_LIMITS.authorNameLength))
		return false;
	if (value.targetType !== "screen" && value.targetType !== "shared-browser")
		return false;
	if (!isBoundedString(value.targetId, ANNOTATION_LIMITS.targetIdLength))
		return false;

	if (value.type === "SCREEN_ANNOTATION_STROKE")
		return isValidStroke(value.stroke);
	if (value.type === "SCREEN_ANNOTATION_ERASE") {
		return isBoundedString(value.strokeId, ANNOTATION_LIMITS.strokeIdLength);
	}
	return (
		value.authorIdToClear === undefined ||
		isBoundedString(value.authorIdToClear, ANNOTATION_LIMITS.authorIdLength)
	);
}

export function annotationStrokeAuthorKey(
	targetType: AnnotationTargetType,
	targetId: string,
	strokeId: string,
): string {
	return `${targetType}\u0000${targetId}\u0000${strokeId}`;
}

const annotationTargetIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:;-]*$/;

export function buildActiveAnnotationTargets(
	screenTargetIds: readonly string[],
	sharedBrowserSessionId: string | null,
): AnnotationTarget[] {
	const targets: AnnotationTarget[] = [];
	const seen = new Set<string>();
	const browserTarget =
		sharedBrowserSessionId &&
			sharedBrowserSessionId.length <= ANNOTATION_LIMITS.targetIdLength &&
			annotationTargetIdPattern.test(sharedBrowserSessionId)
			? sharedBrowserSessionId
			: null;
	const maxScreens = ANNOTATION_LIMITS.maxActiveTargets - (browserTarget ? 1 : 0);
	for (const targetId of screenTargetIds) {
		if (
			targets.length >= maxScreens ||
			targetId.length > ANNOTATION_LIMITS.targetIdLength ||
			!annotationTargetIdPattern.test(targetId) ||
			seen.has(targetId)
		) continue;
		seen.add(targetId);
		targets.push({ targetKind: "screen", targetId });
	}
	if (browserTarget) targets.push({ targetKind: "shared-browser", targetId: browserTarget });
	return targets;
}

export function acceptsAnnotationTarget(
	message: { targetType: AnnotationTargetType; targetId: string },
	activeScreenIds: ReadonlySet<string>,
	sharedBrowserSessionId: string | null,
): boolean {
	return message.targetType === "screen"
		? activeScreenIds.has(message.targetId)
		: sharedBrowserSessionId !== null && message.targetId === sharedBrowserSessionId;
}

export function retainBoundedAnnotationStrokes<T extends { points: readonly unknown[] }>(
	strokes: readonly T[],
	maxStrokes: number = ANNOTATION_LIMITS.maxStrokesPerTarget,
	maxPoints: number = ANNOTATION_LIMITS.maxPointsPerTarget,
): T[] {
	if (!Number.isInteger(maxStrokes) || maxStrokes < 1 || !Number.isInteger(maxPoints) || maxPoints < 1)
		return [];
	const retained: T[] = [];
	let pointCount = 0;
	for (let index = strokes.length - 1; index >= 0; index -= 1) {
		const stroke = strokes[index];
		if (!stroke) continue;
		if (stroke.points.length > maxPoints) return [];
		if (stroke.points.length > maxPoints - pointCount) break;
		retained.push(stroke);
		pointCount += stroke.points.length;
		if (retained.length >= maxStrokes) break;
	}
	return retained.reverse();
}

export function setBoundedRecordEntry<T>(
	record: Record<string, T>,
	key: string,
	value: T,
	maxEntries: number,
): void {
	if (!Number.isInteger(maxEntries) || maxEntries < 1) return;
	if (!Object.hasOwn(record, key) && Object.keys(record).length >= maxEntries) {
		const oldestKey = Object.keys(record)[0];
		if (oldestKey !== undefined) delete record[oldestKey];
	}
	record[key] = value;
}

function includesGuest(
	guestIds: AnnotationPermissionSnapshot["permittedGuestIds"],
	sender: string,
): boolean {
	return Array.isArray(guestIds)
		? guestIds.includes(sender)
		: (guestIds as ReadonlySet<string>).has(sender);
}

export function canSendAnnotationMessage(
	message: AnnotationMessage,
	sender: string | undefined,
	host: string | null,
	permissions: AnnotationPermissionSnapshot,
): boolean {
	if (!sender || message.authorId !== sender) return false;
	if (sender === host) return true;
	if (!includesGuest(permissions.permittedGuestIds, sender)) return false;

	if (message.type === "SCREEN_ANNOTATION_STROKE") return true;
	if (message.type === "SCREEN_ANNOTATION_ERASE") {
		return permissions.strokeAuthors?.[message.strokeId] === sender;
	}
	return message.authorIdToClear === sender;
}

export function applyAnnotationEvents(
	current: readonly import("./annotation-types").AnnotationStroke[],
	events: readonly import("./annotation-types").AnnotationEvent[],
	targetType: AnnotationTargetType,
	targetId: string,
): import("./annotation-types").AnnotationStroke[] {
	let strokes = Array.from(current);
	for (const event of events) {
		if (
			event.kind === "stroke" &&
			event.strokeId &&
			event.color &&
			event.width !== undefined &&
			event.points
		) {
			strokes = retainBoundedAnnotationStrokes([
				...strokes.filter((stroke) => stroke.id !== event.strokeId),
				{
					id: event.strokeId,
					authorId: event.actorId,
					authorName: event.actorName,
					targetType,
					targetId,
					color: event.color,
					width: event.width,
					tool: event.tool ?? "pen",
					opacity: event.tool === "highlighter" ? event.opacity : 1,
					points: Array.from(event.points),
					createdAt: event.createdAt,
				},
			]);
		} else if (event.kind === "erase" && event.strokeId) {
			strokes = strokes.filter((stroke) => stroke.id !== event.strokeId);
		} else if (event.kind === "clear") {
			strokes = event.clearScope === "all"
				? []
				: strokes.filter((stroke) => stroke.authorId !== event.actorId);
		}
	}
	return strokes;
}

export function isWithinAnnotationRateLimit(
	acceptedMessageTimes: readonly number[],
	now: number,
	maxMessages: number = ANNOTATION_LIMITS.maxMessagesPerWindow,
	windowMs: number = ANNOTATION_LIMITS.rateWindowMs,
): boolean {
	if (
		!Number.isFinite(now) ||
		!Number.isInteger(maxMessages) ||
		maxMessages < 1 ||
		!Number.isFinite(windowMs) ||
		windowMs <= 0
	) {
		return false;
	}
	const windowStart = now - windowMs;
	let messagesInWindow = 0;
	for (const timestamp of acceptedMessageTimes) {
		if (!Number.isFinite(timestamp) || timestamp > now) return false;
		if (timestamp > windowStart && ++messagesInWindow >= maxMessages)
			return false;
	}
	return true;
}
