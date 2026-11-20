"use client";

import {
	type StreamQualityConfig,
	applySenderConfig,
	resolveScreenCaptureOptions,
	setCodecPreferences,
	updateLiveBitrate,
	updateLiveFps,
	buildRtcConfiguration,
	configureIceRestart,
	extractPeerStats,
} from "@/lib/mira-webrtc";
import { type ReadableMediaFps } from "@/lib/media-profiles";
import * as Sentry from "@sentry/nextjs";
import {
	resolveLiveKitDataSenderIdentity,
	useLiveKitRoom,
} from "@/lib/use-livekit-room";
import { useServerChat } from "@/lib/use-server-chat";
import { acceptsCollaborationMessage } from "@/lib/collaboration-messages";
import {
	ANNOTATION_LIMITS,
	applyAnnotationEvents,
	buildActiveAnnotationTargets,
} from "@/lib/annotation-messages";
import {
	ANNOTATION_COLORS,
	ANNOTATION_WIDTHS,
	HIGHLIGHTER_OPACITY,
	getAnnotationStrokeRenderStyle,
	type AnnotationEvent,
	type AnnotationOperation,
	type AnnotationStroke,
	type AnnotationTarget,
	type AnnotationTool,
} from "@/lib/annotation-types";
import {
	FULL_VIEW_CONTROL_ROW_CLASS,
	PARTICIPANT_ACTION_ROW_CLASS,
	createAnnotationStrokeId,
	findNearestErasableStroke,
	getFullViewInteractionState,
	tryReleasePointerCapture,
	trySetPointerCapture,
	type FullViewInteractionMode,
} from "@/lib/screen-annotation-ui";
import { captureDisplayIfAllowed } from "@/lib/guarded-screen-capture";
import { ScreenshareSessionBoundary } from "@/lib/screenshare-session-boundary";
import {
	canCreateSignalConnection,
	enqueueSignalCandidate,
	parseMeshSignal,
} from "@/lib/screenshare-signaling";
import { SignupMesh } from "@/components/signup-mesh";
import { RoomLocalRecording } from "@/components/recording/use-room-local-recording";
import type { SharedBrowserFrameHandle } from "@/components/shared-browser/frame-source";
import { RoomInviteManager } from "@/components/screenshare/room-invite-manager";
import {
	MobileRoomControlDock,
	type MobileRoomSheetKind,
} from "@/components/screenshare/mobile-room-control-dock";
import { MobileRoomSheet } from "@/components/screenshare/mobile-room-sheet";
import { RoomParticipantList } from "@/components/screenshare/room-participant-list";
import { useMobileRoomLayout } from "@/lib/use-mobile-room-layout";
import {
	SharedBrowserPanel,
	type SharedBrowserViewerState,
} from "@/components/shared-browser/shared-browser-panel";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
	Check,
	ChevronLeft,
	ChevronRight,
	ChevronDown,
	Copy,
	LayoutGrid,
	Maximize,
	Maximize2,
	Minimize,
	Minimize2,
	Play,
	Plus,
	ScreenShare,
	Square,
	Users,
	Vote,
	Lock,
	Unlock,
	ShieldCheck,
	Share2,
	Sliders,
	UserMinus,
	ZoomIn,
	ZoomOut,
	MousePointer,
	AlertTriangle,
	Edit2,
	MessageSquare,
	Send,
	ArrowUp,
	X,
	Sparkles,
	Link2,
	ArrowRight,
	Presentation,
	FileText,
	Activity,
	Pencil,
	Highlighter,
	Eraser,
	Trash2,
	Globe2,
} from "lucide-react";
import { attachBrowserInputCapture } from "@/lib/browser-pointer-capture";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { toast } from "sonner";
import {
	MIRA_REMOTE_GUARD_ATTR,
	dispatchRemoteInputToPage as dispatchSyntheticGuestInput,
	mapRemotePointToViewport as mapToViewportForCursor,
	releaseAllRemoteInputs,
	resetRemoteInputState,
} from "@/lib/synthetic-input";

export interface ViewerInfo {
	id: string;
	name: string;
	role?: string;
	isSharing?: boolean;
}

export interface ChatMessage {
	id: string;
	senderId: string;
	senderName: string;
	senderRole: "host" | "guest";
	text: string;
	timestamp: number;
	isSystem?: boolean;
}

function formatChatTime(timestamp: number): string {
	try {
		const d = new Date(timestamp);
		return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	} catch {
		return "";
	}
}

function encodeLiveKitData(payload: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(new TextEncoder().encode(payload));
}

// Remote-control protocol types come from the single source of truth in
// @/lib/remote-control (v2: mouse messages carry normalized u/v, key messages carry
// modifiers). Imported for use here and re-exported for existing import sites.
import {
	calculateNormalizedVideoCoordinates,
	isValidBrowserInput,
	type SharerInputMessage,
	type KeyModifiers,
} from "@/lib/remote-control";
export type { SharerInputMessage, KeyModifiers };

export type RemoteControlStatus = "idle" | "requesting" | "active";

export interface IncomingControlRequest {
	hostId: string;
	hostName: string;
	deviceId: string;
	requestId: string;
}

export interface RemoteCursorState {
	x: number;
	y: number;
	clientX?: number;
	clientY?: number;
	clicking: string | false;
	lastActive: number;
}

export interface SharedDeviceStream {
	id: string; // "host-primary" or "guest-{userId}"
	deviceName: string;
	ownerId: string;
	ownerName: string;
	isHost: boolean;
	stream: MediaStream | null;
	liveKitTrack?: any;
	isLive: boolean;
	resolution: string;
	fps: number;
	startedAt: number;
}

type ScreenAnnotationStroke = AnnotationStroke;

type ScreenAnnotationToolbarProps = {
	deviceId: string;
	activeDeviceId: string | null;
	color: string;
	width: number;
	tool: AnnotationTool;
	canClear: boolean;
	clearLabel: string;
	compact?: boolean;
	onToggle: () => void;
	onColorChange: (color: string) => void;
	onWidthChange: (width: number) => void;
	onToolChange: (tool: AnnotationTool) => void;
	onClear: () => void;
};

function ScreenAnnotationToolbar({
	deviceId,
	activeDeviceId,
	color,
	width,
	tool,
	canClear,
	clearLabel,
	compact = false,
	onToggle,
	onColorChange,
	onWidthChange,
	onToolChange,
	onClear,
}: ScreenAnnotationToolbarProps) {
	const active = activeDeviceId === deviceId;
	return (
		<div
			role="toolbar"
			aria-label={`Screen annotation tools for ${deviceId}`}
			className={`flex max-w-full snap-x items-center gap-1 overflow-x-auto overscroll-x-contain border border-amber-400/25 bg-slate-900/90 touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${compact ? "rounded-lg p-1" : "rounded-xl p-1.5 sm:rounded-full sm:p-1"}`}
		>
			<button
				type="button"
				onClick={onToggle}
				className={`flex min-h-11 shrink-0 items-center gap-1 rounded px-3 py-2 font-semibold transition sm:px-2 sm:py-1 ${compact ? "text-[11px] sm:text-[10px]" : "text-xs"} ${active ? "bg-amber-500/25 text-amber-100" : "text-amber-300 hover:bg-amber-500/15"}`}
				title="Draw annotations over this shared screen"
			>
				<Pencil className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
				{active ? "Drawing" : "Draw"}
			</button>
			{active && (
				<>
					<button
						type="button"
						onClick={() => onToolChange("pen")}
						className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 sm:p-1 ${tool === "pen" ? "bg-white/15 text-white" : "text-slate-400"}`}
						title="Pen"
						aria-label="Pen"
						aria-pressed={tool === "pen"}
					>
						<Pencil
							className={
								compact ? "h-4 w-4 sm:h-2.5 sm:w-2.5" : "h-4 w-4 sm:h-3 sm:w-3"
							}
						/>
					</button>
					<button
						type="button"
						onClick={() => onToolChange("highlighter")}
						className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 sm:p-1 ${tool === "highlighter" ? "bg-white/15 text-white" : "text-slate-400"}`}
						title="Highlighter"
						aria-label="Highlighter"
						aria-pressed={tool === "highlighter"}
					>
						<Highlighter
							className={
								compact ? "h-4 w-4 sm:h-2.5 sm:w-2.5" : "h-4 w-4 sm:h-3 sm:w-3"
							}
						/>
					</button>
					<button
						type="button"
						onClick={() => onToolChange("eraser")}
						className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 sm:p-1 ${tool === "eraser" ? "bg-white/15 text-white" : "text-slate-400"}`}
						title="Eraser"
						aria-label="Eraser"
						aria-pressed={tool === "eraser"}
					>
						<Eraser
							className={
								compact ? "h-4 w-4 sm:h-2.5 sm:w-2.5" : "h-4 w-4 sm:h-3 sm:w-3"
							}
						/>
					</button>
					{ANNOTATION_COLORS.map((ink) => (
						<button
							key={ink}
							type="button"
							onClick={() => {
								onColorChange(ink);
								if (tool === "eraser") onToolChange("pen");
							}}
							className={`h-11 w-11 shrink-0 rounded-full border sm:h-4 sm:w-4 ${color === ink ? "border-white ring-1 ring-white/60" : "border-white/20"}`}
							style={{ backgroundColor: ink }}
							aria-label={`Use ${ink} ink`}
						/>
					))}
					<input
						type="color"
						value={color}
						onChange={(event) => {
							onColorChange(event.target.value);
							if (tool === "eraser") onToolChange("pen");
						}}
						className="h-11 w-11 shrink-0 cursor-pointer border-0 bg-transparent p-0 sm:h-4 sm:w-4"
						aria-label="Custom ink color"
					/>
					<select
						value={String(width)}
						onChange={(event) => onWidthChange(Number(event.target.value))}
						className="min-h-11 shrink-0 rounded border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-200 sm:px-1 sm:py-0.5 sm:text-[10px]"
						aria-label="Annotation width"
					>
						{ANNOTATION_WIDTHS.map((lineWidth) => (
							<option key={lineWidth} value={lineWidth}>
								{lineWidth}px
							</option>
						))}
					</select>
					{canClear && (
						<button
							type="button"
							onClick={onClear}
							className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 text-slate-300 hover:bg-white/10 sm:p-1"
							title={clearLabel}
							aria-label={clearLabel}
						>
							<Trash2
								className={
									compact
										? "h-4 w-4 sm:h-2.5 sm:w-2.5"
										: "h-4 w-4 sm:h-3 sm:w-3"
								}
							/>
						</button>
					)}
				</>
			)}
		</div>
	);
}

// The generated Convex client may lag deployment. These names are the intended
// screenshare contracts: `grantAnnotation`, `revokeAnnotation`, and
// `getAnnotationPermission` with `{ roomCode, targetKind, targetId? }`.
const grantAnnotationRef = makeFunctionReference<
	"mutation",
	{
		roomCode: string;
		viewerId: Id<"users">;
		targetKind: "screen";
		targetId?: string;
	},
	null
>("screenshare:grantAnnotation");
const revokeAnnotationRef = makeFunctionReference<
	"mutation",
	{
		roomCode: string;
		viewerId: Id<"users">;
		targetKind: "screen";
		targetId?: string;
	},
	null
>("screenshare:revokeAnnotation");
const getAnnotationPermissionRef = makeFunctionReference<
	"query",
	{
		roomCode: string;
		targetKind: "screen" | "shared-browser";
		targetId?: string;
	},
	{ allowed: boolean; isHost: boolean; participantIds: Id<"users">[] }
>("screenshare:getAnnotationPermission");
const appendAnnotationEventsRef = makeFunctionReference<
	"mutation",
	{
		roomCode: string;
		targetKind: "screen" | "shared-browser";
		targetId: string;
		operations: AnnotationOperation[];
	},
	{ firstSequence: number; lastSequence: number }
>("screenshare:appendAnnotationEvents");
const listAnnotationEventsRef = makeFunctionReference<
	"query",
	{ roomCode: string; targets: AnnotationTarget[]; afterSequence?: number },
	AnnotationEvent[]
>("screenshare:listAnnotationEvents");

// Issue 9: Sentry breadcrumb & error telemetry helpers
function captureBreadcrumb(
	category: string,
	message: string,
	data?: Record<string, any>,
) {
	try {
		Sentry.addBreadcrumb({
			category: `screenshare.${category}`,
			message,
			data,
			level: "info",
		});
	} catch {}
}

function captureError(
	err: unknown,
	context?: string,
	data?: Record<string, any>,
) {
	try {
		Sentry.addBreadcrumb({
			category: "screenshare.error",
			message: `${context ?? "Error"}: ${err instanceof Error ? err.message : String(err)}`,
			data,
			level: "warning",
		});
	} catch {}
}

// Module-level constants: stable references so callbacks that capture them are
// never invalidated by re-renders.
// Module-level constants: stable references so callbacks that capture them are
// never invalidated by re-renders. ICE configuration is environment-driven with TURN/STUN support.
const RTC_CONFIG: RTCConfiguration = buildRtcConfiguration();

const DEFAULT_CONFIG: StreamQualityConfig = {
	resolution: "1080p",
	fps: 60,
	bitrateKbps: 8000,
	codec: "H.264",
	audioEnabled: true,
};

interface SignalRow {
	_id: string;
	senderId: string;
	type: "offer" | "answer" | "candidate";
	to: string | null;
	payload: string;
	timestamp: number;
}

export default function ScreensharePage() {
	return (
		<ScreenshareSessionBoundary>
			<ScreenshareSession />
		</ScreenshareSessionBoundary>
	);
}
function ScreenshareSession() {
	const searchParams = useSearchParams();
	const mobileLayout = useMobileRoomLayout();
	const initialCode =
		searchParams?.get("room") ?? (searchParams?.get("code") || "");
	const roleParam = searchParams?.get("role");

	const { current: workspaceId } = useWorkspace();
	const currentUser = useQuery(api.users.getUser);
	const myUserId = currentUser?._id ?? null;
	const isAnonymousUser = Boolean(currentUser?.isAnonymous);
	const myName =
		currentUser?.name ?? currentUser?.email?.split("@")[0] ?? "Member";

	// Persistent custom display name & name editing state
	const [customName, setCustomName] = useState<string>("");
	const [hostNameInput, setHostNameInput] = useState<string>("Host");
	const [showNameModal, setShowNameModal] = useState<boolean>(false);
	const [nameEditValue, setNameEditValue] = useState<string>("");

	const [roomCode, setRoomCode] = useState<string>(initialCode);
	const [showInviteManager, setShowInviteManager] = useState(false);
	const [creatingRoom, setCreatingRoom] = useState(false);
	// Guests enter a display name BEFORE joining. `null` = not yet chosen.
	const [guestName, setGuestName] = useState<string | null>(() => {
		if (typeof window === "undefined") return null;
		try {
			return localStorage.getItem("mira_user_name");
		} catch {
			return null;
		}
	});
	const [guestNameSubmitting, setGuestNameSubmitting] = useState(false);

	// Frontpage host/join tabs & invite link join state
	const [frontpageTab, setFrontpageTab] = useState<"host" | "join">("host");
	const [inviteLinkInput, setInviteLinkInput] = useState<string>("");
	const [guestJoinNameInput, setGuestJoinNameInput] = useState<string>("");
	const [showJoinModal, setShowJoinModal] = useState<boolean>(false);
	// Full View (Theater) Mode: edge-to-edge window view with zero sidebars/chrome.
	const [theaterMode, setTheaterMode] = useState<boolean>(false);
	const [recordingControlsPortalTarget, setRecordingControlsPortalTarget] =
		useState<HTMLDivElement | null>(null);
	// Zoom Mode: focus/spotlight on a specific shared device screen.
	const [zoomedDeviceId, setZoomedDeviceId] = useState<string | null>(null);
	// Client mount state for safe createPortal execution and localStorage sync.
	const [mounted, setMounted] = useState<boolean>(false);
	useEffect(() => {
		setMounted(true);
		try {
			const saved = localStorage.getItem("mira_user_name");
			if (saved) {
				setCustomName(saved);
				setHostNameInput(saved);
				setGuestName(saved);
			}
		} catch {}
	}, []);

	// Identity is SERVER-DRIVEN: everyone (host included) joins the room first,
	// then the room doc tells us whether we're the host. The URL role param is
	// cosmetic only — trusting it was a security and correctness bug.
	const [joinedRoom, setJoinedRoom] = useState<boolean>(false);
	const [joinError, setJoinError] = useState<string | null>(null);
	const queriesReady = Boolean(roomCode && joinedRoom);

	const room = useQuery(
		api.screenshare.getRoom,
		queriesReady ? { code: roomCode } : "skip",
	);
	const convexViewers = useQuery(
		api.screenshare.getViewers,
		queriesReady ? { roomCode } : "skip",
	);
	const hostUserId = room?.hostId ?? null;
	// Host = the user who created the room (per the room doc). A fresh visitor
	// with no room code is a prospective host.
	const isHost = room ? room.hostId === myUserId : !roomCode;
	const isHostRef = useRef<boolean>(isHost);
	isHostRef.current = isHost;
	// Loading state: queries active but the room doc hasn't arrived yet.
	const identityLoading = queriesReady && room === undefined;
	const mediaScope = `${myUserId}:${roomCode}:${room?.status}:${queriesReady}`;
	const mediaScopeRef = useRef({ key: mediaScope, active: true, live: false });
	if (mediaScopeRef.current.key !== mediaScope)
		mediaScopeRef.current = {
			key: mediaScope,
			active: true,
			live: room?.status === "live" && queriesReady,
		};
	mediaScopeRef.current.live = room?.status === "live" && queriesReady;
	useEffect(() => {
		// Capture this generation. React runs the previous effect cleanup after render,
		// when mediaScopeRef.current may already point at the replacement room scope.
		// Closing the ref directly would therefore disable the new live session.
		const scope = mediaScopeRef.current;
		scope.active = true;
		return () => {
			scope.active = false;
			scope.live = false;
		};
	}, [mediaScope]);
	// Guests arriving via invite link must pick a name before joining. The host
	// (who created the room) and fresh visitors skip the gate. While identity is
	// still resolving (no room doc yet), do NOT show the gate: the join effect
	// proceeds and the room doc then confirms who is host. The gate only renders
	// for a KNOWN non-host (guest) without a chosen name.
	const needsNameGate =
		mounted && isAnonymousUser && Boolean(roomCode) && !guestName;
	// The name this participant is known by in the room (reactive from viewers record).
	const myViewerRecord = convexViewers?.find(
		(v: any) => v.viewerId === myUserId,
	);
	const displayName =
		myViewerRecord?.name ||
		(isHost
			? customName || room?.hostName || myName || "Host"
			: guestName || customName || myName || "Guest");

	// Sharing state
	const [sharedDevices, setSharedDevices] = useState<SharedDeviceStream[]>([]);
	const sharedDevicesRef = useRef<SharedDeviceStream[]>([]);
	sharedDevicesRef.current = sharedDevices;
	const [annotationDeviceId, setAnnotationDeviceId] = useState<string | null>(
		null,
	);
	const [annotationStrokes, setAnnotationStrokes] = useState<
		Record<string, AnnotationStroke[]>
	>({});
	const [recordingAnnotationDrafts, setRecordingAnnotationDrafts] = useState<
		Record<string, AnnotationStroke | null>
	>({});
	const [annotationColor, setAnnotationColor] = useState<string>(
		ANNOTATION_COLORS[0],
	);
	const [annotationWidth, setAnnotationWidth] = useState<number>(
		ANNOTATION_WIDTHS[1],
	);
	const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("pen");
	const [fullViewInteractionMode, setFullViewInteractionMode] =
		useState<FullViewInteractionMode>("control");
	const [sharedBrowserSessionId, setSharedBrowserSessionId] = useState<
		string | null
	>(null);
	const sharedBrowserSessionIdRef = useRef<string | null>(null);
	sharedBrowserSessionIdRef.current = sharedBrowserSessionId;
	const controllerSubscribersRef = useRef(
		new Set<(message: unknown, senderId?: string) => void>(),
	);
	const [sharedBrowserViewerState, setSharedBrowserViewerState] =
		useState<SharedBrowserViewerState>("checking");
	const [sharedBrowserFrame, setSharedBrowserFrame] =
		useState<SharedBrowserFrameHandle | null>(null);
	const lastConnectedSharedBrowserFrameRef =
		useRef<SharedBrowserFrameHandle | null>(null);
	const handleSharedBrowserFrameChange = useCallback(
		(handle: SharedBrowserFrameHandle | null) => {
			if (handle) lastConnectedSharedBrowserFrameRef.current = handle;
			setSharedBrowserFrame(handle);
		},
		[],
	);
	const [sharedBrowserAnnotationStrokes, setSharedBrowserAnnotationStrokes] =
		useState<AnnotationStroke[]>([]);
	const [sharedBrowserRecordingDraft, setSharedBrowserRecordingDraft] =
		useState<AnnotationStroke | null>(null);
	useEffect(() => {
		const onScreenDraft = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					deviceId: string;
					draft: AnnotationStroke | null;
				}>
			).detail;
			if (!detail?.deviceId) return;
			setRecordingAnnotationDrafts((current) => ({
				...current,
				[detail.deviceId]: detail.draft,
			}));
		};
		const onSharedBrowserDraft = (event: Event) => {
			const detail = (event as CustomEvent<{ draft: AnnotationStroke | null }>)
				.detail;
			setSharedBrowserRecordingDraft(detail?.draft ?? null);
		};
		window.addEventListener("mira-screen-annotation-draft", onScreenDraft);
		window.addEventListener(
			"mira-shared-browser-annotation-draft",
			onSharedBrowserDraft,
		);
		return () => {
			window.removeEventListener("mira-screen-annotation-draft", onScreenDraft);
			window.removeEventListener(
				"mira-shared-browser-annotation-draft",
				onSharedBrowserDraft,
			);
		};
	}, []);

	useEffect(() => {
		const activeDeviceIds = new Set(
			sharedDevices
				.filter((device) => device.isLive)
				.map((device) => device.id),
		);
		setAnnotationStrokes((current) => {
			const next = Object.fromEntries(
				Object.entries(current).filter(([deviceId]) =>
					activeDeviceIds.has(deviceId),
				),
			);
			return Object.keys(next).length === Object.keys(current).length
				? current
				: next;
		});
	}, [sharedDevices]);

	useEffect(() => {
		setSharedBrowserAnnotationStrokes((current) => {
			const next = current.filter(
				(stroke) =>
					stroke.targetType === "shared-browser" &&
					stroke.targetId === sharedBrowserSessionId,
			);
			return next.length === current.length ? current : next;
		});
	}, [sharedBrowserSessionId]);

	// Derived zoomed device stream (if any).
	const zoomedDevice = useMemo(() => {
		if (!zoomedDeviceId) return null;
		return sharedDevices.find((d) => d.id === zoomedDeviceId) ?? null;
	}, [sharedDevices, zoomedDeviceId]);

	// If the focused device stops streaming or leaves, reset zoom gracefully.
	useEffect(() => {
		if (zoomedDeviceId && !sharedDevices.some((d) => d.id === zoomedDeviceId)) {
			setZoomedDeviceId(null);
		}
	}, [sharedDevices, zoomedDeviceId]);
	const [isBroadcasting, setIsBroadcasting] = useState<boolean>(false);
	const [isGuestSharing, setIsGuestSharing] = useState<boolean>(false);
	const [config, setConfig] = useState<StreamQualityConfig>(DEFAULT_CONFIG);

	// Interactive Presentation Stage & In-App Collaboration (No-EXE solution)
	const [stageMode, setStageMode] = useState<
		"screens" | "presentation" | "shared-browser"
	>("screens");
	const stageModeRef = useRef<"screens" | "presentation" | "shared-browser">(
		"screens",
	);
	stageModeRef.current = stageMode;
	const [presentationSlide, setPresentationSlide] = useState<number>(0);
	const [presentationVotes, setPresentationVotes] = useState<
		Record<string, number>
	>({ A: 0, B: 0, C: 0 });
	const [userVoted, setUserVoted] = useState<string | null>(null);
	const [presentationNotes, setPresentationNotes] = useState<string>(
		"• High-speed WebRTC DataChannel active\n• Crisp text detail preserved via maintain-resolution\n• In-browser interactive collaboration with zero software installation",
	);
	const presentationSlideRef = useRef<number>(presentationSlide);
	presentationSlideRef.current = presentationSlide;
	const presentationVotesRef =
		useRef<Record<string, number>>(presentationVotes);
	presentationVotesRef.current = presentationVotes;
	const presentationNotesRef = useRef<string>(presentationNotes);
	presentationNotesRef.current = presentationNotes;
	const [isPresenterMinimized, setIsPresenterMinimized] =
		useState<boolean>(false);

	// Apple Segmented Control: Chat, Viewers, Settings
	const [sidebarTab, setSidebarTab] = useState<"chat" | "viewers" | "settings">(
		"chat",
	);
	const [mobileSheet, setMobileSheet] = useState<MobileRoomSheetKind | null>(
		null,
	);
	const [mobileMoreTab, setMobileMoreTab] = useState<
		"settings" | "invitations"
	>("settings");
	const sidebarTabRef = useRef<"chat" | "viewers" | "settings">("chat");
	sidebarTabRef.current = sidebarTab;

	// Kicked state: when host evicts a guest, guest is forced to close screen and locked out
	const [isKickedByHost, setIsKickedByHost] = useState<boolean>(false);
	const wasInRoomRef = useRef<boolean>(false);

	// Chat is strictly viable for the host, or for guests ONLY after they have joined and not kicked
	const isChatViable = Boolean(
		roomCode && (isHost || joinedRoom) && !isKickedByHost,
	);

	// If a guest has not joined yet, ensure tab falls back to viewers/settings instead of locked chat
	useEffect(() => {
		if (roomCode && !isHost && !joinedRoom && sidebarTab === "chat") {
			setSidebarTab("viewers");
		}
	}, [roomCode, isHost, joinedRoom, sidebarTab]);

	const showSettings = sidebarTab === "settings";
	const setShowSettings = useCallback((val: boolean) => {
		setSidebarTab(val ? "settings" : "viewers");
	}, []);

	const chat = useServerChat(
		roomCode,
		myUserId,
		Boolean(queriesReady && !isKickedByHost),
		room?.status === "live" && !isKickedByHost,
	);
	const messages = chat.messages;
	const chatInput = chat.draft;
	const setChatInput = chat.setDraft;
	const handleSendMessage = chat.handleSend;
	useEffect(() => {
		if (chat.error) toast.error(chat.error);
	}, [chat.error]);
	const [unreadCount, setUnreadCount] = useState<number>(0);
	const chatScrollRef = useRef<HTMLDivElement>(null);
	const chatBottomRef = useRef<HTMLDivElement>(null);

	// Active P2P WebRTC DataChannels Map
	const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
	// --- Remote Control Engine (mira-screen-share/sharer Protocol) ---
	const [remoteControlTargetId, setRemoteControlTargetId] = useState<
		string | null
	>(null);
	const [remoteControlStatus, setRemoteControlStatus] =
		useState<RemoteControlStatus>("idle");
	const remoteControlTargetRef = useRef<string | null>(null);
	remoteControlTargetRef.current = remoteControlTargetId;
	const remoteControlStatusRef = useRef<RemoteControlStatus>("idle");
	remoteControlStatusRef.current = remoteControlStatus;
	const controlRequestTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	useEffect(() => {
		setFullViewInteractionMode("control");
	}, [remoteControlTargetId, remoteControlStatus]);
	const releaseHostControlRef = useRef<
		(deviceId: string, guestId: string) => void
	>(() => {});
	const pendingControlRequestRef = useRef<{
		guestId: string;
		deviceId: string;
		hostId: string;
		requestId: string;
	} | null>(null);
	// Pin a single ordered input lane for a grant. Never fall back to another channel
	// mid-gesture: independently ordered channels can reorder down/move/up.
	const inputLaneRef = useRef<{
		deviceId: string;
		channel: RTCDataChannel;
	} | null>(null);
	const sfuInputQueueRef = useRef<Promise<unknown>>(Promise.resolve());
	const sfuPendingInputsRef = useRef(0);

	// Guest-side remote control states
	const [incomingControlRequest, setIncomingControlRequest] =
		useState<IncomingControlRequest | null>(null);
	const incomingControlRequestRef = useRef<IncomingControlRequest | null>(null);
	const [isControlledByHost, setIsControlledByHost] = useState<boolean>(false);
	const isControlledByHostRef = useRef<boolean>(false);
	// Identity of the host currently granted remote control (set on accept, cleared on revoke).
	// Remote input requires this identity AND the current room host's transport identity.
	const controllingHostIdRef = useRef<string | null>(null);
	// P1-11b: the device the guest actually GRANTED (captured at accept time). Input
	// envelopes from the host carry the device id of THEIR shared-stream tile (which
	// can be an SFU track id like `TR_*` or a legacy `guest-*` id) — it can never be
	// matched by naming conventions alone, so every device-id gate must compare
	// against the id captured here.
	const grantedControlDeviceIdRef = useRef<string | null>(null);
	const revokeGuestControlRef = useRef<() => void>(() => {});
	const grantedCaptureTrackRef = useRef<MediaStreamTrack | null>(null);
	const grantedRequestIdRef = useRef<string | null>(null);
	const requestedCaptureTrackRef = useRef<MediaStreamTrack | null>(null);
	const requestedResponseChannelRef = useRef<RTCDataChannel | null>(null);
	const localGuestCaptureRef = useRef<{
		deviceId: string;
		track: MediaStreamTrack;
	} | null>(null);
	const [sameTabConfirmed, setSameTabConfirmed] = useState(false);
	const [isSendingControlResponse, setIsSendingControlResponse] =
		useState(false);
	const [captureEligibilityVersion, setCaptureEligibilityVersion] = useState(0);
	const sameTabConfirmedRef = useRef(false);
	const captureHandleRef = useRef<string | null>(null);

	useEffect(() => {
		const devices = navigator.mediaDevices as MediaDevices & {
			setCaptureHandleConfig?: (config: {
				handle: string;
				exposeOrigin: boolean;
				permittedOrigins: string[];
			}) => void;
		};
		if (!devices?.setCaptureHandleConfig) return;
		try {
			const handle = crypto.randomUUID();
			devices.setCaptureHandleConfig({
				handle,
				exposeOrigin: true,
				permittedOrigins: [window.location.origin],
			});
			captureHandleRef.current = handle;
		} catch {
			// Unsupported/blocked API: explicit guest confirmation remains mandatory.
		}
		return () => {
			captureHandleRef.current = null;
			try {
				devices.setCaptureHandleConfig?.({
					handle: "",
					exposeOrigin: false,
					permittedOrigins: [],
				});
			} catch {}
		};
	}, []);

	const canControlLocalCapture = useCallback(
		(deviceId: string, requireConfirmation = true) => {
			const capture = localGuestCaptureRef.current;
			if (
				!capture ||
				capture.deviceId !== deviceId ||
				capture.track.readyState !== "live"
			)
				return false;
			// A preference for browser capture is NOT proof of this document's identity.
			try {
				if (capture.track.getSettings().displaySurface !== "browser")
					return false;
			} catch {
				return false;
			}
			const track = capture.track as MediaStreamTrack & {
				getCaptureHandle?: () => { handle?: string; origin?: string } | null;
			};
			if (track.getCaptureHandle && captureHandleRef.current) {
				try {
					const identity = track.getCaptureHandle();
					return (
						identity?.handle === captureHandleRef.current &&
						identity?.origin === window.location.origin
					);
				} catch {
					return false;
				}
			}
			// Best effort only on browsers without Capture Handle identity verification.
			return !requireConfirmation || sameTabConfirmedRef.current;
		},
		[],
	);

	isControlledByHostRef.current = isControlledByHost;
	const [controllingHostName, setControllingHostName] = useState<string | null>(
		null,
	);
	const [remoteCursor, setRemoteCursor] = useState<RemoteCursorState | null>(
		null,
	);

	// Dedicated 'control' DataChannels for raw sharer protocol
	const controlChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());

	// P1-4: rAF-driven cursor overlay — cursor positions update the DOM directly via
	// transform, never through React state, so 60-120 move events/sec never re-render
	// this (5700-line) page component. `remoteCursor` state is kept only for the
	// click-indicator ("clicking") flag which changes rarely.
	const remoteCursorElRef = useRef<HTMLDivElement | null>(null);
	const pendingCursorPosRef = useRef<{ x: number; y: number } | null>(null);
	const cursorRafIdRef = useRef<number | null>(null);
	// Last rendered position — survives portal remounts (fullscreen enter/exit) so the
	// cursor never snaps back to the hidden off-screen default on a fullscreenchange.
	const lastCursorPosRef = useRef<{ x: number; y: number } | null>(null);
	const lastRemotePointRef = useRef<{
		x: number;
		y: number;
		sw?: number;
		sh?: number;
		u?: number;
		v?: number;
	} | null>(null);

	const renderRemoteCursor = useCallback((x: number, y: number) => {
		pendingCursorPosRef.current = { x, y };
		if (cursorRafIdRef.current !== null) return; // one frame in flight
		cursorRafIdRef.current = requestAnimationFrame(() => {
			cursorRafIdRef.current = null;
			const el = remoteCursorElRef.current;
			const pos = pendingCursorPosRef.current;
			pendingCursorPosRef.current = null;
			if (!el || !pos) return;
			// Clamp to viewport so the cursor never escapes the window
			const px = Math.min(window.innerWidth - 1, Math.max(0, pos.x));
			const py = Math.min(window.innerHeight - 1, Math.max(0, pos.y));
			lastCursorPosRef.current = { x: px, y: py };
			el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
			el.style.opacity = "1";
		});
	}, []);

	// Portal remount rehydration: whenever the cursor element re-attaches (fullscreen
	// enter/exit re-evaluates the portal target), restore the last known position
	// instead of staying at the hidden off-screen default until the next move.
	useEffect(() => {
		if (!isControlledByHost || typeof document === "undefined") return;
		const rehydrate = () => {
			// fullscreenchange fires BEFORE React re-renders with the new portal target;
			// rehydrate one frame later when the remounted element ref is live again.
			requestAnimationFrame(() => {
				const el = remoteCursorElRef.current;
				const pos = lastCursorPosRef.current;
				if (!el || !pos) return;
				if (el.style.opacity !== "1") {
					el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
					el.style.opacity = "1";
				}
			});
		};
		document.addEventListener("fullscreenchange", rehydrate);
		return () => document.removeEventListener("fullscreenchange", rehydrate);
	}, [isControlledByHost]);

	// Guest viewport changes (window resize / orientation / monitor swap): the last
	// rendered cursor position may now sit outside the new bounds — re-clamp it.
	// Input mapping needs no work (every event maps against the LIVE window size),
	// this is purely visual hygiene for the parked overlay between moves.
	useEffect(() => {
		if (!isControlledByHost) return;
		const reClamp = () => {
			const el = remoteCursorElRef.current;
			const pos = lastCursorPosRef.current;
			if (!el || !pos) return;
			const mapped = lastRemotePointRef.current
				? mapToViewportForCursor(lastRemotePointRef.current)
				: null;
			const px =
				mapped?.clientX ?? Math.min(window.innerWidth - 1, Math.max(0, pos.x));
			const py =
				mapped?.clientY ?? Math.min(window.innerHeight - 1, Math.max(0, pos.y));
			lastCursorPosRef.current = { x: px, y: py };
			el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
		};
		reClamp();
		window.addEventListener("resize", reClamp);
		window.addEventListener("orientationchange", reClamp);
		return () => {
			window.removeEventListener("resize", reClamp);
			window.removeEventListener("orientationchange", reClamp);
		};
	}, [isControlledByHost, mobileLayout.viewportRevision]);

	// Guest-side cursor positioning — SAME mapping as actual synthetic input
	// (mapToViewport in lib/synthetic-input): normalized u/v (0..1 within the active
	// video image) is authoritative when present; legacy messages fall back to
	// stream-pixel ratio math. The visual cursor and the dispatched input can never
	// disagree because they share one coordinate path.
	const moveRemoteCursorTo = useCallback(
		(input: {
			x: number;
			y: number;
			sw?: number;
			sh?: number;
			u?: number;
			v?: number;
		}) => {
			if (typeof window === "undefined") return;
			lastRemotePointRef.current = input;
			const { clientX, clientY } = mapToViewportForCursor(input);
			renderRemoteCursor(clientX, clientY);
			return { clientX, clientY };
		},
		[renderRemoteCursor],
	);

	// Viewers list (server-driven; no per-event state churn)
	const [realViewers, setRealViewers] = useState<ViewerInfo[]>([]);

	// Mutations — stored in a ref so signal handlers are render-stable.
	const sendSignalMutation = useMutation(api.screenshare.sendSignal);
	const joinRoomMutation = useMutation(api.screenshare.joinRoom);
	const pingViewerMutation = useMutation(api.screenshare.pingViewer);
	const createRoomMutation = useMutation(api.screenshare.createRoom);
	const endRoomMutation = useMutation(api.screenshare.endRoom);
	const updateRoomSettingsMutation = useMutation(
		api.screenshare.updateRoomSettings,
	);
	const setRoomLockMutation = useMutation(api.screenshare.setRoomLock);
	const setAllowGuestSharingMutation = useMutation(
		api.screenshare.setAllowGuestSharing,
	);
	const setRoomLimitsMutation = useMutation(api.screenshare.setRoomLimits);
	const kickParticipantMutation = useMutation(api.screenshare.kickParticipant);
	const kickParticipantAction = useAction(
		api.screenshare.kickParticipantAction,
	);
	const setSharingStatusMutation = useMutation(
		api.screenshare.setSharingStatus,
	);
	const issueLiveKitTokenMutation = useMutation(
		api.screenshare.issueLiveKitToken,
	);
	const upgradeViewerToSharerAction = useAction(
		api.screenshare.upgradeViewerToSharer,
	);
	const ensureWorkspaceMutation = useMutation(api.orgs.ensureWorkspace);
	const grantAnnotationMutation = useMutation(grantAnnotationRef);
	const revokeAnnotationMutation = useMutation(revokeAnnotationRef);
	const appendAnnotationEventsMutation = useMutation(appendAnnotationEventsRef);
	const annotationPermission = useQuery(
		getAnnotationPermissionRef,
		queriesReady && roomCode ? { roomCode, targetKind: "screen" } : "skip",
	);
	const screenAnnotationPermissions = useMemo(
		() =>
			new Set<string>(annotationPermission?.participantIds?.map(String) ?? []),
		[annotationPermission?.participantIds],
	);
	const sharedBrowserAnnotationPermission = useQuery(
		getAnnotationPermissionRef,
		queriesReady && roomCode && sharedBrowserSessionId
			? {
					roomCode,
					targetKind: "shared-browser",
					targetId: sharedBrowserSessionId,
				}
			: "skip",
	);
	const sharedBrowserAnnotationPermissions = useMemo(
		() =>
			new Set<string>(
				sharedBrowserAnnotationPermission?.participantIds?.map(String) ?? [],
			),
		[sharedBrowserAnnotationPermission?.participantIds],
	);

	const activeAnnotationTargets = useMemo(
		() =>
			buildActiveAnnotationTargets(
				sharedDevices
					.filter((device) => device.isLive)
					.map((device) => device.id),
				sharedBrowserSessionId,
			),
		[sharedBrowserSessionId, sharedDevices],
	);
	const annotationEvents = useQuery(
		listAnnotationEventsRef,
		queriesReady && roomCode && activeAnnotationTargets.length > 0
			? { roomCode, targets: activeAnnotationTargets, afterSequence: 0 }
			: "skip",
	);
	useEffect(() => {
		if (!annotationEvents) return;
		const nextScreens: Record<string, AnnotationStroke[]> = {};
		const screenTargetIds = new Set(
			annotationEvents
				.filter((event) => event.targetKind === "screen" && event.targetId)
				.map((event) => event.targetId as string),
		);
		for (const targetId of screenTargetIds) {
			nextScreens[targetId] = applyAnnotationEvents(
				[],
				annotationEvents.filter(
					(event) =>
						event.targetKind === "screen" && event.targetId === targetId,
				),
				"screen",
				targetId,
			);
		}
		setAnnotationStrokes(nextScreens);
		if (sharedBrowserSessionId) {
			const browserEvents = annotationEvents.filter(
				(event) =>
					event.targetKind === "shared-browser" &&
					event.targetId === sharedBrowserSessionId,
			);
			setSharedBrowserAnnotationStrokes(
				applyAnnotationEvents(
					[],
					browserEvents,
					"shared-browser",
					sharedBrowserSessionId,
				),
			);
		}
	}, [annotationEvents, sharedBrowserSessionId]);

	const transport =
		(process.env.NEXT_PUBLIC_TRANSPORT as "livekit" | "mesh") || "mesh";
	const [liveKitTokenData, setLiveKitTokenData] = useState<{
		token: string;
		url: string;
	} | null>(null);
	const isTokenRefreshingRef = useRef(false);
	const isSharingRef = useRef(false);
	useEffect(() => {
		isSharingRef.current = isBroadcasting || isGuestSharing;
	}, [isBroadcasting, isGuestSharing]);

	useEffect(() => {
		if (transport !== "livekit" || !roomCode || (!isHost && !joinedRoom))
			return;
		let isMounted = true;
		issueLiveKitTokenMutation({ roomCode })
			.then((res) => {
				if (isMounted) {
					setLiveKitTokenData({ token: res.token, url: res.url });
				}
			})
			.catch((err) => {
				console.warn("[screenshare] LiveKit token issuance failed:", err);
			});
		return () => {
			isMounted = false;
		};
	}, [transport, roomCode, isHost, joinedRoom, issueLiveKitTokenMutation]);

	const handleLiveKitConnected = useCallback(() => {
		isTokenRefreshingRef.current = false;
		if (roomCode) {
			mutationsRef.current.pingViewer({ roomCode }).catch(() => {});
		}
	}, [roomCode]);

	const handleLiveKitHeartbeat = useCallback(() => {
		if (roomCode) {
			mutationsRef.current.pingViewer({ roomCode }).catch(() => {});
		}
	}, [roomCode]);

	const handleLiveKitDisconnected = useCallback(() => {
		// Suppress clearing sharing status if a token refresh is currently in progress
		if (isTokenRefreshingRef.current) {
			return;
		}
		// Only clear sharing status in Convex DB if this participant was actively broadcasting or guest sharing locally
		if (roomCode && isSharingRef.current) {
			mutationsRef.current
				.setSharingStatus({ roomCode, isSharing: false })
				.catch(() => {});
		}
	}, [roomCode]);

	const handleLiveKitTokenExpiring = useCallback(async () => {
		if (!roomCode) return;
		isTokenRefreshingRef.current = true;
		let attempt = 0;
		let newTokenData = null;
		while (attempt < 3 && !newTokenData) {
			try {
				newTokenData = await mutationsRef.current.issueLiveKitToken({
					roomCode,
					requestPublish: isHost || isGuestSharing,
				});
			} catch (err) {
				attempt++;
				if (attempt < 3) {
					const delay = 1000 * attempt + Math.floor(Math.random() * 800);
					await new Promise((r) => setTimeout(r, delay));
				} else {
					console.warn(
						"[screenshare] Proactive LiveKit token refresh failed after 3 attempts:",
						err,
					);
					isTokenRefreshingRef.current = false;
				}
			}
		}
		if (newTokenData) {
			setLiveKitTokenData(newTokenData);
			// In-place token update applies credentials without a room reconnect cycle (V2-4b).
			// Clear refresh-in-progress flag after a short grace period (1s) so legitimate future
			// disconnects are handled cleanly.
			setTimeout(() => {
				isTokenRefreshingRef.current = false;
			}, 1000);
		}
	}, [roomCode, isHost, isGuestSharing]);

	const effectiveLiveKitUrl =
		typeof window !== "undefined" &&
		window.location.hostname !== "localhost" &&
		window.location.hostname !== "127.0.0.1" &&
		process.env.NEXT_PUBLIC_LIVEKIT_URL
			? process.env.NEXT_PUBLIC_LIVEKIT_URL
			: liveKitTokenData?.url ||
				process.env.NEXT_PUBLIC_LIVEKIT_URL ||
				"ws://127.0.0.1:7880";

	const liveKit = useLiveKitRoom({
		roomCode,
		serverUrl: effectiveLiveKitUrl,
		token: liveKitTokenData?.token,
		enabled: transport === "livekit" && Boolean(liveKitTokenData),
		onConnected: handleLiveKitConnected,
		onHeartbeat: handleLiveKitHeartbeat,
		onDisconnected: handleLiveKitDisconnected,
		onTokenExpiring: handleLiveKitTokenExpiring,
	});

	const getControlEligibilityError = useCallback(
		(deviceId: string) => {
			const capture = localGuestCaptureRef.current;
			if (
				!capture ||
				capture.deviceId !== deviceId ||
				capture.track.readyState !== "live"
			) {
				return "The shared tab is no longer live. Start sharing this Ollashare tab again.";
			}
			try {
				if (capture.track.getSettings().displaySurface !== "browser") {
					return "Remote control requires a browser tab. Stop sharing and choose this Ollashare tab, not a window or entire screen.";
				}
			} catch {
				return "The browser could not verify the shared source. Stop sharing and choose this Ollashare tab again.";
			}
			const track = capture.track as MediaStreamTrack & {
				getCaptureHandle?: () => { handle?: string; origin?: string } | null;
			};
			if (track.getCaptureHandle && captureHandleRef.current) {
				try {
					const identity = track.getCaptureHandle();
					if (
						identity?.handle !== captureHandleRef.current ||
						identity?.origin !== window.location.origin
					) {
						return "This is not the verified Ollashare tab. Stop sharing, then select the tab showing this request.";
					}
				} catch {
					return "The browser could not verify this Ollashare tab. Stop sharing and select it again.";
				}
			}
			if (!sameTabConfirmed)
				return "Confirm that you are sharing this Ollashare tab before allowing control.";
			if (transport === "mesh") {
				const responseChannel = requestedResponseChannelRef.current;
				const inputChannel = controlChannelsRef.current.get(
					incomingControlRequestRef.current?.hostId ?? "",
				);
				if (
					responseChannel?.readyState !== "open" ||
					inputChannel?.readyState !== "open"
				) {
					return "The secure control connection is still connecting. Wait a moment and try again.";
				}
			} else if (!liveKit.room || (liveKit.room as any).state !== "connected") {
				return "The secure control connection is reconnecting. Wait a moment and try again.";
			}
			return null;
		},
		[sameTabConfirmed, transport, liveKit.room, captureEligibilityVersion],
	);

	const isLiveKitConnecting =
		transport === "livekit" &&
		Boolean(roomCode) &&
		(!liveKit.isConnected || liveKit.isConnecting);

	const liveKitStreamCacheRef = useRef<Map<string, MediaStream>>(new Map());
	if (transport === "livekit") {
		const localScreen = liveKit.screenTracks.find((track) => track.isLocal);
		const track = localScreen?.track?.mediaStreamTrack;
		localGuestCaptureRef.current =
			localScreen && track && !isHost
				? { deviceId: localScreen.id, track }
				: null;
	}

	// Map LiveKit screen tracks to sharedDevices when transport === "livekit"
	useEffect(() => {
		if (transport !== "livekit") return;
		const cache = liveKitStreamCacheRef.current;
		const mappedStreams: SharedDeviceStream[] = liveKit.screenTracks.map(
			(t) => {
				const mst = (t.track as any)?.mediaStreamTrack;
				const trackId = mst?.id || t.id;
				let stream = cache.get(trackId);
				if (!stream || (mst && !stream.getTracks().includes(mst))) {
					stream = mst ? new MediaStream([mst]) : new MediaStream();
					cache.set(trackId, stream);
				}
				return {
					id: t.id,
					deviceName: t.participantName || "Screen Share",
					ownerId: t.participantIdentity,
					ownerName: t.participantName || "Participant",
					isHost: t.isLocal ? isHost : false,
					stream,
					liveKitTrack: t.track,
					isLive: true,
					resolution: room?.resolution || "1080p",
					fps: room?.fps || 60,
					startedAt: Date.now(),
				};
			},
		);
		setSharedDevices((prev) => {
			if (
				prev.length === mappedStreams.length &&
				prev.every(
					(d, i) =>
						d.id === mappedStreams[i]?.id &&
						d.stream === mappedStreams[i]?.stream &&
						d.liveKitTrack === mappedStreams[i]?.liveKitTrack,
				)
			) {
				return prev;
			}
			return mappedStreams;
		});
	}, [transport, liveKit.screenTracks, room?.resolution, room?.fps, isHost]);

	const mutationsRef = useRef({
		sendSignal: sendSignalMutation,
		joinRoom: joinRoomMutation,
		pingViewer: pingViewerMutation,
		createRoom: createRoomMutation,
		endRoom: endRoomMutation,
		updateRoomSettings: updateRoomSettingsMutation,
		setRoomLock: setRoomLockMutation,
		setAllowGuestSharing: setAllowGuestSharingMutation,
		setRoomLimits: setRoomLimitsMutation,
		kickParticipant: kickParticipantMutation,
		kickParticipantAction,
		setSharingStatus: setSharingStatusMutation,
		issueLiveKitToken: issueLiveKitTokenMutation,
		upgradeViewerToSharer: upgradeViewerToSharerAction,
	});
	mutationsRef.current = {
		sendSignal: sendSignalMutation,
		joinRoom: joinRoomMutation,
		pingViewer: pingViewerMutation,
		createRoom: createRoomMutation,
		endRoom: endRoomMutation,
		updateRoomSettings: updateRoomSettingsMutation,
		setRoomLock: setRoomLockMutation,
		setAllowGuestSharing: setAllowGuestSharingMutation,
		setRoomLimits: setRoomLimitsMutation,
		kickParticipant: kickParticipantMutation,
		kickParticipantAction,
		setSharingStatus: setSharingStatusMutation,
		issueLiveKitToken: issueLiveKitTokenMutation,
		upgradeViewerToSharer: upgradeViewerToSharerAction,
	};

	// WebRTC resources — all in refs, never in state.
	const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
	const iceCandidateQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(
		new Map(),
	);
	const hostStreamRef = useRef<MediaStream | null>(null);
	const guestStreamRef = useRef<MediaStream | null>(null);
	const hostDeviceMetaRef = useRef<SharedDeviceStream | null>(null);
	const guestDeviceMetaRef = useRef<SharedDeviceStream | null>(null);

	const myUserIdRef = useRef<string | null>(null);
	myUserIdRef.current = myUserId;
	// Room host identity, read by the signal handler (stale-closure-safe).
	const hostUserIdRef = useRef<string | null>(null);
	hostUserIdRef.current = hostUserId;

	// Input ref for the guest name gate (uncontrolled — read on submit).
	const nameInputRef = useRef<HTMLInputElement>(null);

	// Signal processing: cursor-based with inclusive boundary. `sinceRef`
	// advances to the newest processed signal; the boundary ms is re-served by
	// the query and deduped here by _id (bounded FIFO set), so same-millisecond
	// signals are never missed and never processed twice.
	// Issue 5: Track document _id cursor to eliminate same-ms drops & signal loss
	const processedSignalsRef = useRef<Set<string>>(new Set());
	const signals = useQuery(
		api.screenshare.getSignals,
		transport === "mesh" && queriesReady ? { roomCode } : "skip",
	);

	const sendSignal = useCallback(
		(
			type: "offer" | "answer" | "candidate",
			to: string | undefined,
			payload: unknown,
		) => {
			if (!roomCode) return;
			console.log(`[screenshare:sendSignal] sending ${type} to: ${to}`);
			mutationsRef.current
				.sendSignal({
					roomCode,
					type,
					to: to ? (to as Id<"users">) : undefined,
					payload: JSON.stringify(payload),
				})
				.then(() => {
					console.log(`[screenshare:sendSignal] ${type} to ${to} SUCCESS`);
				})
				.catch((err) => {
					console.error(
						`[screenshare:sendSignal ERROR] ${type} to ${to}:`,
						err,
					);
					captureError(err, "sendSignal", { type, to });
				});
		},
		[roomCode],
	);

	const closePeerConnections = useCallback(() => {
		for (const pc of peerConnectionsRef.current.values()) {
			try {
				pc.close();
			} catch {}
		}
		peerConnectionsRef.current.clear();
	}, []);

	const stopLocalTracks = useCallback((which: "host" | "guest") => {
		const stream =
			which === "host" ? hostStreamRef.current : guestStreamRef.current;
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
		}
		if (which === "host") {
			hostStreamRef.current = null;
			hostDeviceMetaRef.current = null;
		} else {
			guestStreamRef.current = null;
			guestDeviceMetaRef.current = null;
		}
	}, []);

	// Consent/revoke traffic is targeted and reliable, on the selected transport only.
	const sendControlMessage = useCallback(
		async (
			targetId: string,
			payload: string,
			preferredChannel?: RTCDataChannel | null,
		) => {
			if (transport === "livekit") {
				const room = liveKit.room;
				if (!room || (room as any).state !== "connected") return false;
				try {
					await room.localParticipant.publishData(encodeLiveKitData(payload), {
						reliable: true,
						destinationIdentities: [targetId],
					});
					return true;
				} catch {
					return false;
				}
			}
			const dc =
				preferredChannel?.readyState === "open"
					? preferredChannel
					: dataChannelsRef.current.get(targetId);
			if (dc?.readyState === "open") {
				try {
					dc.send(payload);
					return true;
				} catch {
					/* Peer may have disconnected. */
				}
			}
			return false;
		},
		[transport, liveKit.room],
	);

	// Mesh offer: send this device's stream to one peer.
	// --- Real-Time P2P Chat Engine (Production Grade, Zero Backend Touch) ---
	const handleIncomingChatMessage = useCallback(
		(raw: string, fromPeerId?: string, sourceChannel?: RTCDataChannel) => {
			try {
				if (raw.length > 16_384) return;
				const data = JSON.parse(raw);
				if (!data || typeof data !== "object" || Array.isArray(data)) return;
				if (data.type === "SHARED_BROWSER_CONTROLLER_CHANGED") {
					if (
						!fromPeerId ||
						fromPeerId !== hostUserIdRef.current ||
						typeof data.viewerId !== "string"
					)
						return;
					for (const listener of controllerSubscribersRef.current)
						listener(data, fromPeerId);
					return;
				}
				if (String(data.type).startsWith("SCREEN_ANNOTATION_")) return;
				if (
					!acceptsCollaborationMessage(data, fromPeerId, hostUserIdRef.current)
				)
					return;
				if (data.type === "KICK_NOTICE") {
					if (!fromPeerId || fromPeerId !== hostUserIdRef.current) return;
					const myId = myUserIdRef.current;
					if (
						!isHostRef.current &&
						(data.kickedViewerId === myId || !data.kickedViewerId)
					) {
						handleEviction(data.reason || "You have been kicked by the host.");
						return;
					}
				}

				if (
					data.type === "STAGE_MODE_CHANGE" &&
					(data.mode === "screens" ||
						data.mode === "presentation" ||
						data.mode === "shared-browser")
				)
					setStageMode(data.mode);
				else if (data.type === "PRESENTATION_SLIDE_CHANGE")
					setPresentationSlide(data.slideIndex as number);
				else if (data.type === "PRESENTATION_NOTES_SYNC")
					setPresentationNotes(data.notes as string);
				else if (data.type === "PRESENTATION_FULL_SYNC") {
					if (
						data.mode === "screens" ||
						data.mode === "presentation" ||
						data.mode === "shared-browser"
					)
						setStageMode(data.mode);
					if (typeof data.slideIndex === "number")
						setPresentationSlide(data.slideIndex);
					if (typeof data.notes === "string") setPresentationNotes(data.notes);
					if (data.votes) setPresentationVotes(data.votes);
				}
				// --- Remote Control Messages (mira-screen-share/sharer Protocol) ---
				else if (data.type === "REMOTE_CONTROL_REQUEST") {
					const myId = myUserIdRef.current;
					const localCapture = localGuestCaptureRef.current;
					const isActualHost =
						typeof fromPeerId === "string" &&
						fromPeerId === hostUserIdRef.current &&
						data.hostId === fromPeerId;
					if (
						!isHostRef.current &&
						isActualHost &&
						data.targetUserId === myId &&
						typeof data.deviceId === "string" &&
						typeof data.requestId === "string" &&
						data.requestId.length > 0 &&
						data.requestId.length <= 128 &&
						!isControlledByHostRef.current &&
						localCapture &&
						localCapture.deviceId === data.deviceId &&
						localCapture.track.readyState === "live"
					) {
						if (incomingControlRequestRef.current?.requestId === data.requestId)
							return;
						const request = {
							hostId: fromPeerId,
							hostName:
								typeof data.hostName === "string" ? data.hostName : "Host",
							deviceId: data.deviceId,
							requestId: data.requestId,
						};
						incomingControlRequestRef.current = request;
						requestedCaptureTrackRef.current = localCapture.track;
						requestedResponseChannelRef.current = sourceChannel ?? null;
						sameTabConfirmedRef.current = false;
						setSameTabConfirmed(false);
						setIncomingControlRequest(request);
						toast.info(`Remote control requested by ${request.hostName}`);
					}
				} else if (data.type === "REMOTE_CONTROL_RESPONSE") {
					const pending = pendingControlRequestRef.current;
					if (
						isHostRef.current &&
						pending &&
						remoteControlStatusRef.current === "requesting" &&
						myUserIdRef.current === hostUserIdRef.current &&
						data.hostId === pending.hostId &&
						data.hostId === myUserIdRef.current &&
						fromPeerId === pending.guestId &&
						data.guestId === pending.guestId &&
						data.deviceId === pending.deviceId &&
						data.deviceId === remoteControlTargetRef.current &&
						data.requestId === pending.requestId &&
						typeof data.accepted === "boolean"
					) {
						remoteControlStatusRef.current = data.accepted ? "active" : "idle";
						if (!data.accepted) {
							pendingControlRequestRef.current = null;
							remoteControlTargetRef.current = null;
						}
						// P0-4: clear the pending request timeout — a response arrived
						if (controlRequestTimeoutRef.current) {
							clearTimeout(controlRequestTimeoutRef.current);
							controlRequestTimeoutRef.current = null;
						}
						if (data.accepted) {
							setRemoteControlStatus("active");
							setRemoteControlTargetId(data.deviceId);
							// Place Host in edge-to-edge remote control view
							setTheaterMode(true);
							setZoomedDeviceId(data.deviceId);
							toast.success(
								`Remote control granted for ${data.guestName || "guest screen"}. Browser control is limited to the guest Ollashare tab.`,
							);
						} else {
							setRemoteControlStatus("idle");
							setRemoteControlTargetId(null);
							toast.error(
								`${data.guestName || "Guest"} declined remote control access.`,
							);
						}
					}
				} else if (data.type === "REMOTE_CONTROL_REVOKE") {
					const pending = pendingControlRequestRef.current;
					const incoming = incomingControlRequestRef.current;
					if (isHostRef.current) {
						if (
							!pending ||
							data.by !== "guest" ||
							fromPeerId !== pending.guestId ||
							data.guestId !== pending.guestId ||
							data.hostId !== myUserIdRef.current ||
							data.deviceId !== pending.deviceId ||
							data.requestId !== pending.requestId
						)
							return;
						pendingControlRequestRef.current = null;
						inputLaneRef.current = null;
						remoteControlTargetRef.current = null;
						remoteControlStatusRef.current = "idle";
						if (controlRequestTimeoutRef.current)
							clearTimeout(controlRequestTimeoutRef.current);
						controlRequestTimeoutRef.current = null;
						setRemoteControlTargetId(null);
						setRemoteControlStatus("idle");
						toast.info(
							`Remote control for ${data.guestName || "guest screen"} was released.`,
						);
					} else {
						if (
							data.by !== "host" ||
							typeof fromPeerId !== "string" ||
							fromPeerId !== hostUserIdRef.current ||
							data.hostId !== fromPeerId ||
							data.guestId !== myUserIdRef.current ||
							!(
								(isControlledByHostRef.current &&
									fromPeerId === controllingHostIdRef.current &&
									data.deviceId === grantedControlDeviceIdRef.current &&
									data.requestId === grantedRequestIdRef.current) ||
								(incoming &&
									fromPeerId === incoming.hostId &&
									data.deviceId === incoming.deviceId &&
									data.requestId === incoming.requestId)
							)
						)
							return;
						incomingControlRequestRef.current = null;
						setIncomingControlRequest(null);
						isControlledByHostRef.current = false;
						grantedCaptureTrackRef.current = null;
						grantedRequestIdRef.current = null;
						requestedCaptureTrackRef.current = null;
						sameTabConfirmedRef.current = false;
						setSameTabConfirmed(false);
						releaseAllRemoteInputs();
						resetRemoteInputState();
						setIsControlledByHost(false);
						isControlledByHostRef.current = false;
						controllingHostIdRef.current = null;
						grantedControlDeviceIdRef.current = null;
						setControllingHostName(null);
						setRemoteCursor(null);
						if (typeof document !== "undefined" && document.fullscreenElement) {
							document.exitFullscreen().catch(() => {});
						}
						toast.info("Remote control ended.");
					}
				} else if (
					data.type === "REMOTE_CONTROL_INPUT" ||
					data.type === "mouse_move" ||
					data.type === "mouse_down" ||
					data.type === "mouse_up" ||
					data.type === "mouse_cancel" ||
					data.type === "mouse_wheel" ||
					data.type === "key_down" ||
					data.type === "key_up"
				) {
					// Raw and enveloped input share one FAIL-CLOSED transport/device gate.
					// A claimed payload hostId is never a substitute for transport identity.
					const senderIsGrantedHost =
						typeof fromPeerId === "string" &&
						fromPeerId === controllingHostIdRef.current &&
						fromPeerId === hostUserIdRef.current;
					const isTargetDevice =
						typeof data.deviceId === "string" &&
						data.deviceId === grantedControlDeviceIdRef.current;
					const candidate: unknown =
						data.type === "REMOTE_CONTROL_INPUT" ? data.input : data;
					if (
						isHostRef.current ||
						!isControlledByHostRef.current ||
						!senderIsGrantedHost ||
						!isTargetDevice ||
						data.requestId !== grantedRequestIdRef.current ||
						!isValidBrowserInput(candidate)
					)
						return;
					const input = candidate as SharerInputMessage; // Validated above, not trusted from the wire.
					if (
						!canControlLocalCapture(data.deviceId) ||
						localGuestCaptureRef.current?.track !==
							grantedCaptureTrackRef.current
					) {
						revokeGuestControlRef.current();
						return;
					}
					if (
						input.type === "mouse_move" ||
						input.type === "mouse_down" ||
						input.type === "mouse_up" ||
						input.type === "mouse_cancel"
					) {
						const mapped = moveRemoteCursorTo(input);
						if (input.type !== "mouse_move") {
							setRemoteCursor({
								x: mapped?.clientX ?? 0,
								y: mapped?.clientY ?? 0,
								clicking: input.type === "mouse_down" ? input.button : false,
								lastActive: Date.now(),
							});
						}
					}
					dispatchSyntheticGuestInput(input);
				}
			} catch (err) {
				console.warn("[chat:engine] error parsing inbound chat payload:", err);
			}
		},
		[roomCode, canControlLocalCapture, moveRemoteCursorTo],
	);

	const setupDataChannel = useCallback(
		(dc: RTCDataChannel, peerId: string) => {
			console.log(`[chat:mesh] configuring data channel for peer ${peerId}`);
			const registerOpenChannel = () => {
				console.log(
					`[chat:mesh] data channel OPEN with ${peerId}, label=${dc.label}`,
				);
				if (dc.label === "control") {
					if (
						!dc.ordered ||
						dc.maxRetransmits !== null ||
						dc.maxPacketLifeTime !== null
					) {
						dc.close();
						return;
					}
					controlChannelsRef.current.set(peerId, dc);
					return; // Input lane carries no chat/presentation history backlog.
				} else {
					dataChannelsRef.current.set(peerId, dc);
				}
				if (
					isHostRef.current &&
					(stageModeRef.current !== "screens" ||
						presentationSlideRef.current > 0 ||
						presentationNotesRef.current)
				) {
					try {
						dc.send(
							JSON.stringify({
								type: "PRESENTATION_FULL_SYNC",
								mode: stageModeRef.current,
								slideIndex: presentationSlideRef.current,
								votes: presentationVotesRef.current,
								notes: presentationNotesRef.current,
							}),
						);
					} catch {}
				}
			};
			dc.onopen = registerOpenChannel;
			dc.onclose = () => {
				console.log(
					`[chat:mesh] data channel CLOSED with ${peerId}, label=${dc.label}`,
				);
				const wasCurrentControlChannel =
					controlChannelsRef.current.get(peerId) === dc;
				if (dc.label === "control") {
					if (wasCurrentControlChannel)
						controlChannelsRef.current.delete(peerId);
				} else {
					if (dataChannelsRef.current.get(peerId) === dc)
						dataChannelsRef.current.delete(peerId);
				}
				if (
					!isHostRef.current &&
					isControlledByHostRef.current &&
					peerId === controllingHostIdRef.current &&
					wasCurrentControlChannel
				)
					revokeGuestControlRef.current();
				const grant = pendingControlRequestRef.current;
				if (
					isHostRef.current &&
					grant &&
					inputLaneRef.current?.channel === dc
				) {
					releaseHostControlRef.current(grant.deviceId, grant.guestId);
				}
			};
			dc.onerror = (err) => {
				if (dc.readyState === "closed" || dc.readyState === "closing") return;
				console.warn(
					`[chat:mesh] data channel notice with ${peerId}:`,
					(err as any)?.error?.message || err,
				);
			};
			dc.onmessage = (evt) => {
				if (!evt.data || typeof evt.data !== "string") return;
				handleIncomingChatMessage(evt.data, peerId, dc);
			};
		},
		[handleIncomingChatMessage],
	);

	// Auto-scroll chat to latest message
	useEffect(() => {
		if (sidebarTab === "chat" && chatBottomRef.current) {
			chatBottomRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [messages, sidebarTab]);

	// LiveKit data listener
	useEffect(() => {
		if (transport !== "livekit" || !liveKit.room) return;
		const room = liveKit.room as any;
		const onData = (
			payload: Uint8Array,
			participant?: { identity?: string },
			_kind?: unknown,
			_topic?: string,
			_encryptionType?: unknown,
			participantIdentity?: string,
		) => {
			try {
				const str = new TextDecoder().decode(payload);
				handleIncomingChatMessage(
					str,
					resolveLiveKitDataSenderIdentity(participant, participantIdentity),
				);
			} catch (err) {
				console.warn("[chat:livekit] data decode error:", err);
			}
		};
		room.on("dataReceived", onData);
		return () => {
			room.off("dataReceived", onData);
		};
	}, [transport, liveKit.room, handleIncomingChatMessage]);

	const handleToggleStageMode = useCallback(
		(newMode: "screens" | "presentation" | "shared-browser") => {
			setStageMode(newMode);
			const payload = JSON.stringify({
				type: "STAGE_MODE_CHANGE",
				mode: newMode,
			});
			dataChannelsRef.current.forEach((dc) => {
				if (dc.readyState === "open") {
					try {
						dc.send(payload);
					} catch {}
				}
			});
			if (
				transport === "livekit" &&
				liveKit.room &&
				(liveKit.room as any).state === "connected"
			) {
				try {
					liveKit.room.localParticipant.publishData(
						encodeLiveKitData(payload),
						{ reliable: true },
					);
				} catch {}
			}
		},
		[transport, liveKit.room],
	);

	const handleChangeSlide = useCallback(
		(nextIndex: number) => {
			const clamped = Math.max(0, Math.min(3, nextIndex));
			setPresentationSlide(clamped);
			const payload = JSON.stringify({
				type: "PRESENTATION_SLIDE_CHANGE",
				slideIndex: clamped,
			});
			dataChannelsRef.current.forEach((dc) => {
				if (dc.readyState === "open") {
					try {
						dc.send(payload);
					} catch {}
				}
			});
			if (
				transport === "livekit" &&
				liveKit.room &&
				(liveKit.room as any).state === "connected"
			) {
				try {
					liveKit.room.localParticipant.publishData(
						encodeLiveKitData(payload),
						{ reliable: true },
					);
				} catch {}
			}
		},
		[transport, liveKit.room],
	);

	const handleVoteOption = useCallback(
		(opt: string) => {
			setUserVoted(opt);
			setPresentationVotes((prev) => ({
				...prev,
				[opt]: (prev[opt] || 0) + 1,
			}));
			const payload = JSON.stringify({
				type: "PRESENTATION_VOTE",
				option: opt,
			});
			dataChannelsRef.current.forEach((dc) => {
				if (dc.readyState === "open") {
					try {
						dc.send(payload);
					} catch {}
				}
			});
			if (
				transport === "livekit" &&
				liveKit.room &&
				(liveKit.room as any).state === "connected"
			) {
				try {
					liveKit.room.localParticipant.publishData(
						encodeLiveKitData(payload),
						{ reliable: true },
					);
				} catch {}
			}
		},
		[transport, liveKit.room],
	);

	const handleUpdateNotes = useCallback((notes: string) => {
		setPresentationNotes(notes);
		const payload = JSON.stringify({ type: "PRESENTATION_NOTES_SYNC", notes });
		dataChannelsRef.current.forEach((dc) => {
			if (dc.readyState === "open") {
				try {
					dc.send(payload);
				} catch {}
			}
		});
	}, []);

	const broadcastCollaborationPayload = useCallback(
		(payload: string) => {
			dataChannelsRef.current.forEach((dc) => {
				if (dc.readyState === "open") {
					try {
						dc.send(payload);
					} catch {}
				}
			});
			if (
				transport === "livekit" &&
				liveKit.room &&
				(liveKit.room as any).state === "connected"
			) {
				void liveKit.room.localParticipant
					.publishData(encodeLiveKitData(payload), {
						reliable: true,
					})
					.catch(() => {});
			}
		},
		[transport, liveKit.room],
	);

	const subscribeControllerMessages = useCallback(
		(listener: (message: unknown, senderId?: string) => void) => {
			controllerSubscribersRef.current.add(listener);
			return () => {
				controllerSubscribersRef.current.delete(listener);
			};
		},
		[],
	);

	const sendSharedBrowserAnnotation = useCallback(
		async (operation: AnnotationOperation) => {
			if (!roomCode || !sharedBrowserSessionId) return;
			try {
				await appendAnnotationEventsMutation({
					roomCode,
					targetKind: "shared-browser",
					targetId: sharedBrowserSessionId,
					operations: [operation],
				});
			} catch {
				toast.error(
					"Annotation permission changed or the browser session ended.",
				);
			}
		},
		[appendAnnotationEventsMutation, roomCode, sharedBrowserSessionId],
	);

	const broadcastSharedBrowserControllerChanged = useCallback(
		(viewerId: string) => {
			if (!isHostRef.current || !sharedBrowserSessionId) return;
			broadcastCollaborationPayload(
				JSON.stringify({
					type: "SHARED_BROWSER_CONTROLLER_CHANGED",
					viewerId,
					sessionId: sharedBrowserSessionId,
				}),
			);
		},
		[broadcastCollaborationPayload, sharedBrowserSessionId],
	);

	const setSharedBrowserAnnotationPermission = useCallback(
		async (viewerId: string, allowed: boolean) => {
			if (!isHost || !roomCode || !sharedBrowserSessionId) return;
			const args = {
				roomCode,
				viewerId: viewerId as Id<"users">,
				targetKind: "shared-browser" as const,
				targetId: sharedBrowserSessionId,
			};
			if (allowed) await grantAnnotationMutation(args as any);
			else await revokeAnnotationMutation(args as any);
		},
		[
			grantAnnotationMutation,
			isHost,
			revokeAnnotationMutation,
			roomCode,
			sharedBrowserSessionId,
		],
	);

	const canDrawAnnotations = Boolean(isHost || annotationPermission?.allowed);

	const handleAnnotationStroke = useCallback(
		(deviceId: string, stroke: ScreenAnnotationStroke) => {
			if (
				annotationDeviceId !== deviceId ||
				!sharedDevicesRef.current.some(
					(device) => device.id === deviceId && device.isLive,
				) ||
				(!isHostRef.current && !annotationPermission?.allowed)
			)
				return;
			void appendAnnotationEventsMutation({
				roomCode,
				targetKind: "screen",
				targetId: deviceId,
				operations: [
					{
						kind: "stroke",
						strokeId: stroke.id,
						color: stroke.color,
						width: stroke.width,
						tool: stroke.tool ?? "pen",
						opacity:
							stroke.tool === "highlighter"
								? stroke.opacity ?? HIGHLIGHTER_OPACITY
								: 1,
						points: stroke.points,
					},
				],
			}).catch(() =>
				toast.error(
					"Annotation permission changed or the screen is no longer active.",
				),
			);
		},
		[
			annotationDeviceId,
			annotationPermission?.allowed,
			appendAnnotationEventsMutation,
			roomCode,
		],
	);

	const handleAnnotationErase = useCallback(
		(deviceId: string, strokeId: string) => {
			if (
				!sharedDevicesRef.current.some(
					(device) => device.id === deviceId && device.isLive,
				)
			)
				return;
			void appendAnnotationEventsMutation({
				roomCode,
				targetKind: "screen",
				targetId: deviceId,
				operations: [{ kind: "erase", strokeId }],
			}).catch(() =>
				toast.error(
					"You can only erase annotations you are authorized to remove.",
				),
			);
		},
		[appendAnnotationEventsMutation, roomCode],
	);

	const handleClearAnnotations = useCallback(
		(deviceId: string, scope: "all" | "own") => {
			if (
				!sharedDevicesRef.current.some(
					(device) => device.id === deviceId && device.isLive,
				)
			)
				return;
			void appendAnnotationEventsMutation({
				roomCode,
				targetKind: "screen",
				targetId: deviceId,
				operations: [{ kind: "clear", scope }],
			}).catch(() =>
				toast.error(
					"Annotation permission changed or the screen is no longer active.",
				),
			);
		},
		[appendAnnotationEventsMutation, roomCode],
	);

	const handleSetAnnotationPermission = useCallback(
		async (viewerId: string, allowed: boolean) => {
			if (!isHost || !roomCode || viewerId === myUserId) return;
			try {
				const args = {
					roomCode,
					viewerId: viewerId as Id<"users">,
					targetKind: "screen" as const,
				};
				if (allowed) await grantAnnotationMutation(args);
				else await revokeAnnotationMutation(args);
			} catch {
				toast.error("Could not update drawing permission.");
			}
		},
		[
			grantAnnotationMutation,
			isHost,
			myUserId,
			revokeAnnotationMutation,
			roomCode,
		],
	);

	const handleSendRemoteInput = useCallback(
		(targetUserId: string, deviceId: string, inputMsg: SharerInputMessage) => {
			const grant = pendingControlRequestRef.current;
			if (
				!isHostRef.current ||
				myUserIdRef.current !== hostUserIdRef.current ||
				remoteControlStatusRef.current !== "active" ||
				!grant ||
				grant.deviceId !== deviceId ||
				grant.guestId !== targetUserId ||
				remoteControlTargetRef.current !== deviceId
			)
				return;
			const isMove = inputMsg.type === "mouse_move";
			const enveloped = JSON.stringify({
				type: "REMOTE_CONTROL_INPUT",
				hostId: myUserIdRef.current,
				deviceId,
				requestId: grant.requestId,
				input: inputMsg,
			});
			if (transport === "mesh") {
				if (!inputLaneRef.current) {
					const dc = controlChannelsRef.current.get(targetUserId);
					if (
						!dc ||
						dc.readyState !== "open" ||
						!dc.ordered ||
						dc.maxRetransmits !== null ||
						dc.maxPacketLifeTime !== null
					)
						return;
					inputLaneRef.current = { deviceId, channel: dc };
				}
				const lane = inputLaneRef.current;
				if (lane.deviceId !== deviceId || lane.channel.readyState !== "open") {
					releaseHostControlRef.current(deviceId, targetUserId);
					return;
				}
				// Drop only unsent stale moves. All button/key/wheel/cancel state remains
				// ordered on this SAME lane; no chat/SFU fallback can overtake a press.
				if (isMove && lane.channel.bufferedAmount >= 4096) return;
				try {
					lane.channel.send(enveloped);
				} catch {
					releaseHostControlRef.current(deviceId, targetUserId); // Never switch lanes mid-grant.
				}
				return;
			}
			const room = liveKit.room;
			if (!room || (room as any).state !== "connected") return;
			if (isMove && sfuPendingInputsRef.current >= 8) return;
			sfuPendingInputsRef.current++;
			sfuInputQueueRef.current = sfuInputQueueRef.current
				.then(async () => {
					// Drop queued input from a released/replaced grant, never replay it later.
					if (
						pendingControlRequestRef.current !== grant ||
						remoteControlStatusRef.current !== "active"
					)
						return;
					await room.localParticipant.publishData(
						encodeLiveKitData(enveloped),
						{
							reliable: true,
							destinationIdentities: [targetUserId],
						},
					);
				})
				.catch(() => {
					if (pendingControlRequestRef.current === grant)
						releaseHostControlRef.current(deviceId, targetUserId);
				})
				.finally(() => {
					sfuPendingInputsRef.current--;
				});
		},
		[transport, liveKit.room],
	);

	const handleReleaseRemoteControl = useCallback(
		(deviceId: string, targetUserId: string) => {
			const requestId = pendingControlRequestRef.current?.requestId;
			remoteControlTargetRef.current = null;
			remoteControlStatusRef.current = "idle";
			pendingControlRequestRef.current = null;
			inputLaneRef.current = null;
			setRemoteControlTargetId(null);
			setRemoteControlStatus("idle");

			// P0-4: clear any pending request timeout on manual release
			if (controlRequestTimeoutRef.current) {
				clearTimeout(controlRequestTimeoutRef.current);
				controlRequestTimeoutRef.current = null;
			}

			const releasePayload = JSON.stringify({
				type: "REMOTE_CONTROL_REVOKE",
				deviceId,
				by: "host",
				hostId: myUserIdRef.current,
				guestId: targetUserId,
				requestId,
			});

			sendControlMessage(targetUserId, releasePayload);
			toast.info("Remote control released");
		},
		[sendControlMessage],
	);

	releaseHostControlRef.current = handleReleaseRemoteControl;

	const handleRequestRemoteControl = useCallback(
		(device: SharedDeviceStream) => {
			if (!isHost) return;
			setAnnotationDeviceId(null);

			if (
				remoteControlTargetId === device.id &&
				remoteControlStatus === "active"
			) {
				handleReleaseRemoteControl(device.id, device.ownerId);
				return;
			}

			if (remoteControlTargetId && remoteControlTargetId !== device.id) {
				const prevDevice = sharedDevices.find(
					(d) => d.id === remoteControlTargetId,
				);
				if (prevDevice) {
					handleReleaseRemoteControl(prevDevice.id, prevDevice.ownerId);
				}
			}

			if (
				!myUserIdRef.current ||
				myUserIdRef.current !== hostUserIdRef.current ||
				device.ownerId === myUserIdRef.current
			)
				return;
			if (
				remoteControlStatusRef.current === "requesting" &&
				remoteControlTargetRef.current === device.id
			)
				return;
			const requestId = crypto.randomUUID();
			pendingControlRequestRef.current = {
				guestId: device.ownerId,
				deviceId: device.id,
				hostId: myUserIdRef.current,
				requestId,
			};
			inputLaneRef.current = null;
			remoteControlTargetRef.current = device.id;
			remoteControlStatusRef.current = "requesting";
			setRemoteControlTargetId(device.id);
			setRemoteControlStatus("requesting");
			toast.info(
				`Requesting remote control for ${device.ownerName || device.deviceName}…`,
			);

			// P0-4: request timeout — never leave the host stuck in "requesting" forever
			if (controlRequestTimeoutRef.current)
				clearTimeout(controlRequestTimeoutRef.current);
			controlRequestTimeoutRef.current = setTimeout(() => {
				controlRequestTimeoutRef.current = null;
				if (remoteControlStatusRef.current === "requesting") {
					handleReleaseRemoteControl(device.id, device.ownerId);
					toast.error(
						"Control request timed out. The guest may be away or sharing a view-only source.",
					);
				}
			}, 20_000);

			const requestPayload = JSON.stringify({
				type: "REMOTE_CONTROL_REQUEST",
				hostId: myUserIdRef.current,
				hostName: displayName,
				deviceId: device.id,
				targetUserId: device.ownerId,
				requestId,
			});

			sendControlMessage(device.ownerId, requestPayload);
		},
		[
			isHost,
			remoteControlTargetId,
			remoteControlStatus,
			sharedDevices,
			displayName,
			sendControlMessage,
			handleReleaseRemoteControl,
		],
	);

	useEffect(() => {
		if (!incomingControlRequest) return;
		const request = incomingControlRequest;
		const track = requestedCaptureTrackRef.current;
		const dismiss = () => {
			if (incomingControlRequestRef.current !== request) return;
			incomingControlRequestRef.current = null;
			requestedCaptureTrackRef.current = null;
			requestedResponseChannelRef.current = null;
			sameTabConfirmedRef.current = false;
			setSameTabConfirmed(false);
			setIncomingControlRequest(null);
		};
		const checkSource = () => {
			if (
				!track ||
				track.readyState !== "live" ||
				localGuestCaptureRef.current?.track !== track ||
				hostUserIdRef.current !== request.hostId
			) {
				dismiss();
				return;
			}
			setCaptureEligibilityVersion((version) => version + 1);
		};
		track?.addEventListener("ended", dismiss);
		const refreshEligibility = () =>
			setCaptureEligibilityVersion((version) => version + 1);
		track?.addEventListener("capturehandlechange", refreshEligibility);
		const expiration = setTimeout(dismiss, 20_000);
		const check = setInterval(checkSource, 500);
		return () => {
			clearTimeout(expiration);
			clearInterval(check);
			track?.removeEventListener("ended", dismiss);
			track?.removeEventListener("capturehandlechange", refreshEligibility);
		};
	}, [incomingControlRequest]);

	const handleAcceptControlRequest = useCallback(async () => {
		if (
			!incomingControlRequest ||
			incomingControlRequestRef.current !== incomingControlRequest
		)
			return;
		const { hostId, deviceId, hostName, requestId } = incomingControlRequest;
		const eligibilityError = getControlEligibilityError(deviceId);
		if (
			isHostRef.current ||
			document.visibilityState === "hidden" ||
			hostId !== hostUserIdRef.current ||
			eligibilityError ||
			!canControlLocalCapture(deviceId) ||
			localGuestCaptureRef.current?.track !== requestedCaptureTrackRef.current
		) {
			toast.error(
				eligibilityError ??
					"The control request is no longer valid. Ask the host to request again.",
			);
			return;
		}
		setIsSendingControlResponse(true);
		const responsePayload = JSON.stringify({
			type: "REMOTE_CONTROL_RESPONSE",
			accepted: true,
			requestId,
			deviceId,
			hostId,
			guestId: myUserIdRef.current,
			guestName: displayName,
		});
		const delivered = await sendControlMessage(
			hostId,
			responsePayload,
			requestedResponseChannelRef.current,
		);
		setIsSendingControlResponse(false);
		if (
			!delivered ||
			incomingControlRequestRef.current !== incomingControlRequest
		) {
			toast.error(
				"Could not send approval to the host. The request remains open; wait for the secure connection and try again.",
			);
			setCaptureEligibilityVersion((version) => version + 1);
			return;
		}
		grantedCaptureTrackRef.current = localGuestCaptureRef.current!.track;
		grantedRequestIdRef.current = requestId;
		incomingControlRequestRef.current = null;
		releaseAllRemoteInputs(); // clear anything a previous session left held
		resetRemoteInputState();
		setIsControlledByHost(true);
		isControlledByHostRef.current = true;
		// P1-11: remember WHO was granted control — input from any other peer is dropped.
		controllingHostIdRef.current = hostId || null;
		// P1-11b: remember WHICH device was granted control — host envelopes target this
		// exact id; missing or alias device ids are rejected.
		grantedControlDeviceIdRef.current = deviceId;
		setControllingHostName(hostName);
		setIncomingControlRequest(null);
		requestedResponseChannelRef.current = null;
		// Maximize viewport presentation view
		setTheaterMode(true);

		toast.success(
			`Remote control granted to ${hostName || "Host"}. Only this Ollashare tab can receive browser input.`,
		);
	}, [
		incomingControlRequest,
		displayName,
		sendControlMessage,
		canControlLocalCapture,
		getControlEligibilityError,
	]);

	const handleDenyControlRequest = useCallback(async () => {
		if (!incomingControlRequest) return;
		const { hostId, deviceId, requestId } = incomingControlRequest;
		const responsePayload = JSON.stringify({
			type: "REMOTE_CONTROL_RESPONSE",
			accepted: false,
			requestId,
			deviceId,
			hostId,
			guestId: myUserIdRef.current,
			guestName: displayName,
		});
		const delivered = await sendControlMessage(
			hostId,
			responsePayload,
			requestedResponseChannelRef.current,
		);
		if (!delivered) {
			toast.error(
				"Could not send the decline. The request remains open; try again when the connection recovers.",
			);
			return;
		}
		incomingControlRequestRef.current = null;
		requestedResponseChannelRef.current = null;
		sameTabConfirmedRef.current = false;
		setSameTabConfirmed(false);
		setIncomingControlRequest(null);
		toast.info("Remote control request declined");
	}, [incomingControlRequest, displayName, sendControlMessage]);

	const handleRevokeControlByGuest = useCallback(() => {
		if (!isControlledByHostRef.current) return;
		const hostId = controllingHostIdRef.current;
		const deviceId = grantedControlDeviceIdRef.current;
		const requestId = grantedRequestIdRef.current;
		grantedRequestIdRef.current = null;
		// Close authorization synchronously BEFORE release events can invoke page handlers.
		isControlledByHostRef.current = false;
		grantedCaptureTrackRef.current = null;
		sameTabConfirmedRef.current = false;
		setSameTabConfirmed(false);
		releaseAllRemoteInputs();
		resetRemoteInputState();
		setIsControlledByHost(false);
		isControlledByHostRef.current = false;
		controllingHostIdRef.current = null;
		grantedControlDeviceIdRef.current = null;
		setControllingHostName(null);
		setRemoteCursor(null);
		if (typeof document !== "undefined" && document.fullscreenElement) {
			document.exitFullscreen().catch(() => {});
		}

		const revokePayload = JSON.stringify({
			type: "REMOTE_CONTROL_REVOKE",
			deviceId,
			hostId,
			by: "guest",
			requestId,
			guestId: myUserIdRef.current,
			guestName: displayName,
		});

		if (hostId) sendControlMessage(hostId, revokePayload);
		toast.info("You revoked remote screen control");
	}, [displayName, sendControlMessage]);

	// Auto-release remote control if target device stream is stopped/unshared.
	// HOST side: the guest's screen is gone — nothing to control. Send a REVOKE so the
	// guest also drops out of controlled state (and releases any stuck inputs) instead
	// of waiting for its own timeout; THEN reset local state.
	const prevTargetDeviceRef = useRef<{ id: string; ownerId: string } | null>(
		null,
	);
	useEffect(() => {
		if (!remoteControlTargetId) {
			prevTargetDeviceRef.current = null;
			return;
		}
		const device = sharedDevices.find((d) => d.id === remoteControlTargetId);
		if (device) {
			prevTargetDeviceRef.current = { id: device.id, ownerId: device.ownerId };
			return;
		}
		console.log(
			"[remote-control] Controlled device unshared, resetting state to idle",
		);
		// Revoke the grant on the guest's side (best-effort: device may already be gone).
		const prev = prevTargetDeviceRef.current;
		if (prev && pendingControlRequestRef.current) {
			const revokePayload = JSON.stringify({
				type: "REMOTE_CONTROL_REVOKE",
				deviceId: prev.id,
				by: "host",
				hostId: myUserIdRef.current,
				guestId: prev.ownerId,
				requestId: pendingControlRequestRef.current?.requestId,
			});
			sendControlMessage(prev.ownerId, revokePayload);
		}
		prevTargetDeviceRef.current = null;
		pendingControlRequestRef.current = null;
		inputLaneRef.current = null;
		remoteControlTargetRef.current = null;
		remoteControlStatusRef.current = "idle";
		if (controlRequestTimeoutRef.current)
			clearTimeout(controlRequestTimeoutRef.current);
		controlRequestTimeoutRef.current = null;
		setRemoteControlTargetId(null);
		setRemoteControlStatus("idle");
	}, [sharedDevices, remoteControlTargetId, sendControlMessage]);

	revokeGuestControlRef.current = handleRevokeControlByGuest;

	useEffect(() => {
		if (transport !== "livekit" || liveKit.isConnected) return;
		if (isControlledByHostRef.current) revokeGuestControlRef.current();
		const grant = pendingControlRequestRef.current;
		if (grant) releaseHostControlRef.current(grant.deviceId, grant.guestId);
	}, [transport, liveKit.isConnected]);

	// A grant is bound to one live capture track. Surface/handle/source changes,
	// hidden documents and page teardown revoke rather than leaving held input.
	// Window blur alone is not authority loss: browser chrome, permission surfaces,
	// devtools and OS focus transitions can blur a still-visible controlled Ollashare tab.
	useEffect(() => {
		if (!isControlledByHost) return;
		const track = grantedCaptureTrackRef.current;
		const revoke = () => revokeGuestControlRef.current();
		const check = () => {
			const deviceId = grantedControlDeviceIdRef.current;
			if (
				!deviceId ||
				!canControlLocalCapture(deviceId) ||
				localGuestCaptureRef.current?.track !== track ||
				hostUserIdRef.current !== controllingHostIdRef.current
			)
				revoke();
		};
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") revoke();
		};
		track?.addEventListener("ended", revoke);
		track?.addEventListener("capturehandlechange", check);
		window.addEventListener("pagehide", revoke);
		document.addEventListener("visibilitychange", onVisibilityChange);
		const timer = setInterval(check, 500);
		check();
		return () => {
			clearInterval(timer);
			track?.removeEventListener("ended", revoke);
			track?.removeEventListener("capturehandlechange", check);
			window.removeEventListener("pagehide", revoke);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [isControlledByHost, canControlLocalCapture]);

	// GUEST host-disappearance watchdog: if the granted host is no longer in the room's
	// viewer list, the control session is dead — exit controlled state locally (the
	// host cannot send input or a revoke anymore). Prevents a zombie "controlled" pill
	// with a dead input path.
	useEffect(() => {
		if (!isControlledByHost) return;
		const grantedHostId = controllingHostIdRef.current;
		if (!grantedHostId) return;
		const hostStillPresent =
			!realViewers ||
			realViewers.length === 0 ||
			realViewers.some((v) => v.id === grantedHostId);
		if (!hostStillPresent) {
			console.log(
				"[remote-control] Controlling host left the room — releasing control",
			);
			handleRevokeControlByGuest();
		}
	}, [isControlledByHost, realViewers, handleRevokeControlByGuest]);

	// Emergency Escape key listener for Guest to revoke control
	useEffect(() => {
		if (!isControlledByHost) return;
		const handleEsc = (e: KeyboardEvent) => {
			if (e.isTrusted && e.key === "Escape") {
				handleRevokeControlByGuest();
			}
		};
		window.addEventListener("keydown", handleEsc);
		return () => window.removeEventListener("keydown", handleEsc);
	}, [isControlledByHost, handleRevokeControlByGuest]);

	const sendOfferToPeer = useCallback(
		async (
			targetPeerId: string,
			mediaStream: MediaStream,
			deviceMeta: SharedDeviceStream,
		) => {
			if (!mediaStream || targetPeerId === myUserIdRef.current) return;

			const connKey = `out_${deviceMeta.id}_${targetPeerId}`;
			const existing = peerConnectionsRef.current.get(connKey);
			if (
				!existing &&
				!canCreateSignalConnection(
					peerConnectionsRef.current,
					targetPeerId,
					connKey,
				)
			)
				return;
			if (existing) {
				try {
					existing.close();
				} catch {}
			}

			const pc = new RTCPeerConnection(RTC_CONFIG);
			pc.oniceconnectionstatechange = () => {
				console.log(
					`[screenshare:mesh] pc (${connKey}) iceConnectionState=${pc.iceConnectionState}, connectionState=${pc.connectionState}`,
				);
			};
			peerConnectionsRef.current.set(connKey, pc);

			try {
				const chatDc = pc.createDataChannel("mira-chat", { ordered: true });
				setupDataChannel(chatDc, targetPeerId);
			} catch (err) {
				console.warn(
					"[screenshare:mesh] failed to create chat data channel on offer:",
					err,
				);
			}

			// One reliable, ordered lane for all browser input. Stale moves drop before enqueue.
			try {
				const controlDc = pc.createDataChannel("control", { ordered: true });
				setupDataChannel(controlDc, targetPeerId);
			} catch (err) {
				console.warn(
					"[screenshare:mesh] failed to create control data channel on offer:",
					err,
				);
			}

			// Issue 2: ICE restart and connection recovery state machine
			configureIceRestart(pc, {
				onRestartOffer: async () => {
					try {
						const restartOffer = await pc.createOffer({ iceRestart: true });
						await pc.setLocalDescription(restartOffer);
						sendSignal("offer", targetPeerId, {
							offer: restartOffer,
							deviceId: deviceMeta.id,
							device: {
								id: deviceMeta.id,
								deviceName: deviceMeta.deviceName,
								ownerId: deviceMeta.ownerId,
								ownerName: deviceMeta.ownerName,
								isHost: Boolean(deviceMeta.isHost),
								resolution: deviceMeta.resolution,
								fps: deviceMeta.fps,
								startedAt: deviceMeta.startedAt,
							},
						});
					} catch (err) {
						console.warn("[ICE restart offer error]", err);
					}
				},
				onReconnect: () => {
					toast.success("Stream connection restored");
				},
				onFail: () => {
					toast.error("Stream connection dropped. Rebuilding connection...");
					try {
						pc.close();
					} catch {}
					peerConnectionsRef.current.delete(connKey);
				},
			});

			mediaStream.getTracks().forEach((track) => {
				try {
					pc.addTrack(track, mediaStream);
				} catch {}
			});

			const videoTrack = mediaStream.getVideoTracks()[0];
			if (videoTrack) {
				await applySenderConfig(pc, videoTrack, configRef.current);
			}

			const transceiver = pc
				.getTransceivers()
				.find((t) => t.sender.track?.kind === "video");
			if (transceiver) {
				setCodecPreferences(transceiver, configRef.current.codec);
			}

			pc.onicecandidate = (iceEvt) => {
				if (iceEvt.candidate) {
					const cand = iceEvt.candidate.toJSON
						? iceEvt.candidate.toJSON()
						: {
								candidate: iceEvt.candidate.candidate,
								sdpMid: iceEvt.candidate.sdpMid,
								sdpMLineIndex: iceEvt.candidate.sdpMLineIndex,
								usernameFragment: iceEvt.candidate.usernameFragment,
							};
					sendSignal("candidate", targetPeerId, {
						candidate: cand,
						deviceId: deviceMeta.id,
						direction: "out",
					});
				}
			};

			try {
				const offer = await pc.createOffer();
				await pc.setLocalDescription(offer);
				sendSignal("offer", targetPeerId, {
					offer,
					deviceId: deviceMeta.id,
					device: {
						id: deviceMeta.id,
						deviceName: deviceMeta.deviceName,
						ownerId: deviceMeta.ownerId,
						ownerName: deviceMeta.ownerName,
						isHost: Boolean(deviceMeta.isHost),
						resolution: deviceMeta.resolution,
						fps: deviceMeta.fps,
						startedAt: deviceMeta.startedAt,
					},
				});
			} catch {
				try {
					pc.close();
				} catch {}
				peerConnectionsRef.current.delete(connKey);
				iceCandidateQueueRef.current.delete(connKey);
			}
		},
		[sendSignal],
	);

	const configRef = useRef(config);
	configRef.current = config;

	// Force evict guest when kicked by host
	const handleEviction = useCallback(
		(reason?: string) => {
			console.log("[screenshare] Evicting participant: kicked by host");
			if (isControlledByHostRef.current) revokeGuestControlRef.current();
			incomingControlRequestRef.current = null;
			setIncomingControlRequest(null);
			setIsKickedByHost(true);
			setJoinedRoom(false);

			// 1. Force stop guest's screen share stream immediately
			if (guestStreamRef.current) {
				guestStreamRef.current
					.getTracks()
					.forEach((track: MediaStreamTrack) => {
						try {
							track.stop();
						} catch {}
					});
				guestStreamRef.current = null;
			}
			stopLocalTracks("guest");
			setIsGuestSharing(false);
			setIsBroadcasting(false);

			// 2. Clear all shared devices
			setSharedDevices([]);
			setZoomedDeviceId(null);

			// 3. Teardown all peer connections and data channels
			peerConnectionsRef.current.forEach((pc) => {
				try {
					pc.close();
				} catch {}
			});
			peerConnectionsRef.current.clear();

			dataChannelsRef.current.forEach((dc) => {
				try {
					dc.close();
				} catch {}
			});
			dataChannelsRef.current.clear();

			// 4. Disconnect from LiveKit if connected
			if (liveKit.room) {
				try {
					liveKit.disconnect();
				} catch {}
			}

			toast.error(
				reason || "You have been kicked from this session by the host.",
			);
		},
		[stopLocalTracks, liveKit],
	);

	// Reactive subscription: detect when guest was in room but host kicked/removed them from convexViewers
	useEffect(() => {
		if (!convexViewers || isHost || !myUserId) return;
		const inRoom = convexViewers.some((v: any) => v.viewerId === myUserId);
		if (inRoom) {
			wasInRoomRef.current = true;
		} else if (wasInRoomRef.current && joinedRoom && !isKickedByHost) {
			handleEviction("You have been kicked by the host.");
		}
	}, [
		convexViewers,
		isHost,
		myUserId,
		joinedRoom,
		isKickedByHost,
		handleEviction,
	]);

	// Sync sharedDevices with active convexViewers across all participants
	useEffect(() => {
		if (!convexViewers) return;
		const activeViewerIds = new Set(convexViewers.map((v: any) => v.viewerId));
		setSharedDevices((prev) =>
			prev.filter((d) => {
				if (d.isHost || d.id === "host-primary") return true;
				return activeViewerIds.has(d.ownerId);
			}),
		);
	}, [convexViewers]);

	// Stop guest sharing (local cleanup + announce).
	const stopGuestScreenshare = useCallback(() => {
		if (isControlledByHostRef.current) revokeGuestControlRef.current();
		localGuestCaptureRef.current = null;
		incomingControlRequestRef.current = null;
		setIncomingControlRequest(null);
		if (transport === "livekit") {
			liveKit.stopScreenShare();
			setIsGuestSharing(false);
			if (roomCode)
				mutationsRef.current
					.setSharingStatus({ roomCode, isSharing: false })
					.catch(() => {});
			return;
		}
		stopLocalTracks("guest");
		setIsGuestSharing(false);
		if (roomCode)
			mutationsRef.current
				.setSharingStatus({ roomCode, isSharing: false })
				.catch(() => {});
		const deviceId = `guest-${myUserIdRef.current}`;
		setSharedDevices((prev) => prev.filter((d) => d.id !== deviceId));
		peerConnectionsRef.current.forEach((pc, key) => {
			if (key.includes(deviceId)) {
				try {
					pc.close();
				} catch {}
				peerConnectionsRef.current.delete(key);
			}
		});
		toast.info("Your screen sharing has ended");
	}, [stopLocalTracks, transport, liveKit.stopScreenShare, roomCode]);

	const stopBroadcast = useCallback(() => {
		if (!isHost) return;
		if (transport === "livekit") {
			liveKit.stopScreenShare();
			setIsBroadcasting(false);
			if (roomCode)
				mutationsRef.current
					.setSharingStatus({ roomCode, isSharing: false })
					.catch(() => {});
			return;
		}
		stopLocalTracks("host");
		setIsBroadcasting(false);
		if (roomCode)
			mutationsRef.current
				.setSharingStatus({ roomCode, isSharing: false })
				.catch(() => {});
		setSharedDevices((prev) => prev.filter((d) => d.id !== "host-primary"));
		peerConnectionsRef.current.forEach((pc, key) => {
			if (key.includes("host-primary")) {
				try {
					pc.close();
				} catch {}
				peerConnectionsRef.current.delete(key);
			}
		});
		toast.info("Host screen broadcast stopped");
	}, [isHost, stopLocalTracks, transport, roomCode, liveKit.stopScreenShare]);
	useEffect(() => {
		if (room?.status !== "ended" && !isKickedByHost) return;
		mediaScopeRef.current.live = false;
		stopLocalTracks("host");
		stopLocalTracks("guest");
		closePeerConnections();
		liveKit.disconnect();
		releaseAllRemoteInputs();
		resetRemoteInputState();
		isControlledByHostRef.current = false;
		controllingHostIdRef.current = null;
		setIsBroadcasting(false);
		setIsGuestSharing(false);
		setSharedDevices([]);
	}, [
		room?.status,
		isKickedByHost,
		stopLocalTracks,
		closePeerConnections,
		liveKit.disconnect,
	]);

	// Process inbound signals (cursor advances after each batch).
	useEffect(() => {
		if (!signals || !Array.isArray(signals) || signals.length === 0) return;

		const myId = myUserIdRef.current;

		for (const sig of signals as SignalRow[]) {
			if (!sig || !sig._id) continue;
			if (processedSignalsRef.current.has(sig._id)) continue;
			processedSignalsRef.current.add(sig._id);
			// Bound the dedupe set WITHOUT a full clear: a clear() would let every
			// previously-processed signal _id be re-processed on the next poll (the
			// newest-200 query re-serves the same rows), re-dispatching already-handled
			// offers/candidates. Trim the OLDEST entries instead (Set keeps insertion
			// order; the newest are what the reactive query keeps returning).
			while (processedSignalsRef.current.size > 2000) {
				const oldest = processedSignalsRef.current.values().next().value;
				if (oldest === undefined) break;
				processedSignalsRef.current.delete(oldest);
			}
			if (sig.to !== null && sig.to !== undefined && sig.to !== myId) continue;
			if (sig.senderId === myId) continue;
			const data = parseMeshSignal(sig.type, sig.payload);
			if (!data) continue;

			if (sig.type === "offer") {
				if (data.deviceId === "mira-chat-p2p") {
					const connKey = `chat_${sig.senderId}`;
					if (
						!canCreateSignalConnection(
							peerConnectionsRef.current,
							sig.senderId,
							connKey,
						)
					)
						continue;
					let pc = peerConnectionsRef.current.get(connKey);
					if (
						!pc ||
						pc.connectionState === "closed" ||
						pc.connectionState === "failed"
					) {
						pc = new RTCPeerConnection(RTC_CONFIG);
						peerConnectionsRef.current.set(connKey, pc);
						pc.ondatachannel = (evt) => {
							console.log(
								`[chat:mesh] ondatachannel received from ${sig.senderId}, label=${evt.channel.label}`,
							);
							if (
								evt.channel.label === "mira-chat" ||
								evt.channel.label === "chat" ||
								evt.channel.label === "control"
							) {
								setupDataChannel(evt.channel, sig.senderId);
							}
						};
						pc.onicecandidate = (iceEvt) => {
							if (iceEvt.candidate) {
								const cand = iceEvt.candidate.toJSON
									? iceEvt.candidate.toJSON()
									: {
											candidate: iceEvt.candidate.candidate,
											sdpMid: iceEvt.candidate.sdpMid,
											sdpMLineIndex: iceEvt.candidate.sdpMLineIndex,
											usernameFragment: iceEvt.candidate.usernameFragment,
										};
								sendSignal("candidate", sig.senderId, {
									candidate: cand,
									deviceId: "mira-chat-p2p",
								});
							}
						};
					}
					(async () => {
						try {
							await pc.setRemoteDescription(
								new RTCSessionDescription(data.offer!),
							);
							const queued = iceCandidateQueueRef.current.get(connKey) || [];
							iceCandidateQueueRef.current.delete(connKey);
							for (const cand of queued) {
								try {
									await pc.addIceCandidate(new RTCIceCandidate(cand));
								} catch {}
							}
							const answer = await pc.createAnswer();
							await pc.setLocalDescription(answer);
							sendSignal("answer", sig.senderId, {
								answer,
								deviceId: "mira-chat-p2p",
							});
							console.log(
								`[chat:mesh] answered chat offer from ${sig.senderId}`,
							);
						} catch (err) {
							console.warn("[chat:mesh] error answering chat offer:", err);
							try {
								pc.close();
							} catch {}
							peerConnectionsRef.current.delete(connKey);
							iceCandidateQueueRef.current.delete(connKey);
						}
					})();
					continue;
				}
				console.log(
					`[screenshare:mesh] Received OFFER from ${sig.senderId} for device ${data.deviceId}, target=${sig.to}`,
				);
				const deviceId = data.deviceId;
				if (!deviceId) continue;

				const connKey = `in_${deviceId}_${sig.senderId}`;
				if (
					!canCreateSignalConnection(
						peerConnectionsRef.current,
						sig.senderId,
						connKey,
					)
				)
					continue;
				const existing = peerConnectionsRef.current.get(connKey);
				if (existing) {
					try {
						existing.close();
					} catch {}
				}
				const pc = new RTCPeerConnection(RTC_CONFIG);
				pc.oniceconnectionstatechange = () => {
					console.log(
						`[screenshare:mesh] pc (${connKey}) iceConnectionState=${pc.iceConnectionState}, connectionState=${pc.connectionState}`,
					);
				};
				pc.ondatachannel = (evt) => {
					if (
						evt.channel.label === "mira-chat" ||
						evt.channel.label === "chat" ||
						evt.channel.label === "control"
					) {
						setupDataChannel(evt.channel, sig.senderId);
					}
				};
				peerConnectionsRef.current.set(connKey, pc);

				// Issue 2: ICE restart and connection recovery state machine for receiving peer
				configureIceRestart(pc, {
					onReconnect: () => {
						toast.success("Stream connection restored");
					},
					onFail: () => {
						toast.error("Lost connection to stream. Attempting recovery...");
						try {
							pc.close();
						} catch {}
						peerConnectionsRef.current.delete(connKey);
						setSharedDevices((prev) => prev.filter((d) => d.id !== deviceId));
					},
				});

				pc.ontrack = (trackEvent) => {
					console.log(
						`[screenshare:mesh] pc.ontrack fired for device ${data.deviceId}, track kind=${trackEvent.track?.kind}`,
					);
					const remoteStream =
						trackEvent.streams && trackEvent.streams[0]
							? trackEvent.streams[0]
							: trackEvent.track
								? new MediaStream([trackEvent.track])
								: null;
					const deviceMeta = data.device;
					if (remoteStream && deviceMeta) {
						setSharedDevices((prev) => {
							const existingIndex = prev.findIndex(
								(d) => d.id === deviceMeta.id,
							);
							const existing =
								existingIndex >= 0 ? prev[existingIndex] : undefined;
							if (existing) {
								if (
									trackEvent.track &&
									!existing.stream?.getTracks().includes(trackEvent.track)
								) {
									try {
										existing.stream?.addTrack(trackEvent.track);
									} catch {}
								}
								const updatedStream = existing.stream
									? new MediaStream(existing.stream.getTracks())
									: remoteStream;
								const next = [...prev];
								next[existingIndex] = {
									...existing,
									stream: updatedStream,
									isLive: true,
								};
								return next;
							}
							return [
								...prev.filter((d) => d.id !== deviceMeta.id),
								{
									id: deviceMeta.id,
									deviceName: deviceMeta.deviceName || "Screen Share",
									ownerId: sig.senderId,
									ownerName:
										deviceMeta.ownerName ||
										`Participant (${String(sig.senderId).slice(-4)})`,
									isHost: sig.senderId === hostUserIdRef.current,
									stream: remoteStream,
									isLive: true,
									resolution: deviceMeta.resolution || "1080p",
									fps: deviceMeta.fps || 60,
									startedAt: deviceMeta.startedAt || Date.now(),
								},
							];
						});
					}
				};

				pc.onicecandidate = (iceEvt) => {
					if (iceEvt.candidate) {
						const cand = iceEvt.candidate.toJSON
							? iceEvt.candidate.toJSON()
							: {
									candidate: iceEvt.candidate.candidate,
									sdpMid: iceEvt.candidate.sdpMid,
									sdpMLineIndex: iceEvt.candidate.sdpMLineIndex,
									usernameFragment: iceEvt.candidate.usernameFragment,
								};
						sendSignal("candidate", sig.senderId, {
							candidate: cand,
							deviceId,
							direction: "in",
						});
					}
				};

				(async () => {
					try {
						await pc.setRemoteDescription(
							new RTCSessionDescription(data.offer!),
						);
						// Drain any queued ICE candidates that arrived before remoteDescription
						const queued = iceCandidateQueueRef.current.get(connKey) || [];
						iceCandidateQueueRef.current.delete(connKey);
						for (const cand of queued) {
							try {
								await pc.addIceCandidate(new RTCIceCandidate(cand));
								console.log(
									`[screenshare:mesh] (${connKey}) drained candidate SUCCESS`,
								);
							} catch (err) {
								console.error(
									`[screenshare:mesh ERROR] (${connKey}) drain candidate failed:`,
									err,
								);
							}
						}
						const answer = await pc.createAnswer();
						await pc.setLocalDescription(answer);
						sendSignal("answer", sig.senderId, { answer, deviceId });
					} catch (err) {
						captureError(err, "setRemoteDescription (offer)", { connKey });
						try {
							pc.close();
						} catch {}
						peerConnectionsRef.current.delete(connKey);
						iceCandidateQueueRef.current.delete(connKey);
					}
				})();
			} else if (sig.type === "answer") {
				if (data.deviceId === "mira-chat-p2p") {
					const connKey = `chat_${sig.senderId}`;
					const pc = peerConnectionsRef.current.get(connKey);
					console.log(
						`[chat:mesh] received chat answer from ${sig.senderId}, pcState=${pc?.signalingState}`,
					);
					if (pc && pc.signalingState === "have-local-offer") {
						pc.setRemoteDescription(new RTCSessionDescription(data.answer!))
							.then(async () => {
								const queued = iceCandidateQueueRef.current.get(connKey) || [];
								iceCandidateQueueRef.current.delete(connKey);
								for (const cand of queued) {
									try {
										await pc.addIceCandidate(new RTCIceCandidate(cand));
									} catch {}
								}
								console.log(
									`[chat:mesh] chat connection remote description set for ${sig.senderId}`,
								);
							})
							.catch((err) => {
								console.warn(
									"[chat:mesh] error setting remote answer for chat:",
									err,
								);
								try {
									pc.close();
								} catch {}
								peerConnectionsRef.current.delete(connKey);
								iceCandidateQueueRef.current.delete(connKey);
							});
					}
					continue;
				}
				const connKey = `out_${data.deviceId}_${sig.senderId}`;
				console.log(
					`[screenshare:mesh] Received ANSWER from ${sig.senderId} for ${data.deviceId}, connKey=${connKey}, pcExists=${Boolean(peerConnectionsRef.current.get(connKey))}, state=${peerConnectionsRef.current.get(connKey)?.signalingState}`,
				);
				const pc = peerConnectionsRef.current.get(connKey);
				if (pc && pc.signalingState === "have-local-offer") {
					pc.setRemoteDescription(new RTCSessionDescription(data.answer!))
						.then(async () => {
							// Drain any queued ICE candidates for this outgoing connection
							const queued = iceCandidateQueueRef.current.get(connKey) || [];
							iceCandidateQueueRef.current.delete(connKey);
							for (const cand of queued) {
								try {
									await pc.addIceCandidate(new RTCIceCandidate(cand));
								} catch {}
							}
						})
						.catch((err) => {
							captureError(err, "setRemoteDescription", { connKey });
							try {
								pc.close();
							} catch {}
							peerConnectionsRef.current.delete(connKey);
							iceCandidateQueueRef.current.delete(connKey);
						});
				}
			} else if (sig.type === "candidate") {
				if (data.deviceId === "mira-chat-p2p") {
					const connKey = `chat_${sig.senderId}`;
					const pc = peerConnectionsRef.current.get(connKey);
					if (pc?.remoteDescription) {
						pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(
							() => {},
						);
					} else {
						enqueueSignalCandidate(
							iceCandidateQueueRef.current,
							connKey,
							data.candidate!,
						);
					}
					continue;
				}
				const connKey =
					data.direction === "out"
						? `in_${data.deviceId}_${sig.senderId}`
						: `out_${data.deviceId}_${sig.senderId}`;
				const pc = peerConnectionsRef.current.get(connKey);
				console.log(
					`[screenshare:mesh] Received CANDIDATE from ${sig.senderId} for ${data.deviceId}, connKey=${connKey}, pcExists=${Boolean(pc)}, hasRemote=${Boolean(pc?.remoteDescription)}`,
				);
				if (pc?.remoteDescription) {
					pc.addIceCandidate(new RTCIceCandidate(data.candidate))
						.then(() => {
							console.log(
								`[screenshare:mesh] (${connKey}) live candidate added SUCCESS`,
							);
						})
						.catch((err) => {
							console.error(
								`[screenshare:mesh ERROR] (${connKey}) live candidate failed:`,
								err,
							);
							captureError(err, "addIceCandidate", { connKey });
						});
				} else {
					enqueueSignalCandidate(
						iceCandidateQueueRef.current,
						connKey,
						data.candidate!,
					);
				}
			}
		}
	}, [signals, sendSignal]);

	// Mesh sync: when viewers change, ensure active broadcasters offer to each peer.
	useEffect(() => {
		const myStream = isHost ? hostStreamRef.current : guestStreamRef.current;
		const myDevice = isHost
			? hostDeviceMetaRef.current
			: guestDeviceMetaRef.current;
		if (!myStream || !myDevice) return;

		const rawPeerIds: string[] = [];
		if (!isHost && hostUserId) rawPeerIds.push(hostUserId);
		for (const viewer of realViewers) {
			if (viewer.id && viewer.id !== myUserId) rawPeerIds.push(viewer.id);
		}
		const uniquePeerIds = Array.from(new Set(rawPeerIds));

		for (const peerId of uniquePeerIds) {
			const connKey = `out_${myDevice.id}_${peerId}`;
			const existing = peerConnectionsRef.current.get(connKey);
			if (
				!existing ||
				existing.connectionState === "closed" ||
				existing.connectionState === "failed" ||
				existing.signalingState === "closed"
			) {
				sendOfferToPeer(peerId, myStream, myDevice);
			}
		}
	}, [realViewers, isHost, hostUserId, myUserId, sendOfferToPeer]);

	// Sync viewers list from the server (server is the source of truth).
	useEffect(() => {
		if (!convexViewers || !Array.isArray(convexViewers)) return;
		const peers: ViewerInfo[] = convexViewers.map(
			(v: {
				viewerId: string;
				name: string;
				role?: string;
				isSharing?: boolean;
			}) => ({
				id: v.viewerId,
				name:
					v.name ||
					(v.role === "host"
						? "Host"
						: `Viewer (${String(v.viewerId).slice(-4)})`),
				role: v.role,
				isSharing: Boolean(v.isSharing),
			}),
		);
		setRealViewers(peers);
	}, [convexViewers]);

	// Dedicated background P2P Chat Mesh initiation (Host <-> Viewers)
	useEffect(() => {
		if (transport !== "mesh" || !roomCode || !isHost || !myUserId) return;

		for (const viewer of realViewers) {
			if (!viewer.id || viewer.id === myUserId || viewer.role === "host")
				continue;
			if (dataChannelsRef.current.has(viewer.id)) continue;
			const connKey = `chat_${viewer.id}`;
			const existing = peerConnectionsRef.current.get(connKey);
			if (
				!existing &&
				!canCreateSignalConnection(
					peerConnectionsRef.current,
					viewer.id,
					connKey,
				)
			)
				continue;
			if (
				existing &&
				existing.connectionState !== "closed" &&
				existing.connectionState !== "failed"
			)
				continue;

			console.log(
				`[chat:mesh] Host initiating P2P chat data connection with ${viewer.id}`,
			);
			const pc = new RTCPeerConnection(RTC_CONFIG);
			peerConnectionsRef.current.set(connKey, pc);

			pc.onicecandidate = (iceEvt) => {
				if (iceEvt.candidate) {
					const cand = iceEvt.candidate.toJSON
						? iceEvt.candidate.toJSON()
						: {
								candidate: iceEvt.candidate.candidate,
								sdpMid: iceEvt.candidate.sdpMid,
								sdpMLineIndex: iceEvt.candidate.sdpMLineIndex,
								usernameFragment: iceEvt.candidate.usernameFragment,
							};
					sendSignal("candidate", viewer.id, {
						candidate: cand,
						deviceId: "mira-chat-p2p",
					});
				}
			};

			try {
				const dc = pc.createDataChannel("mira-chat", { ordered: true });
				setupDataChannel(dc, viewer.id);
			} catch (err) {
				console.warn("[chat:mesh] error creating data channel:", err);
			}

			// Reliable ordered browser input; never split moves and button state.
			try {
				const controlDc = pc.createDataChannel("control", { ordered: true });
				setupDataChannel(controlDc, viewer.id);
			} catch (err) {
				console.warn("[chat:mesh] error creating control data channel:", err);
			}

			(async () => {
				try {
					const offer = await pc.createOffer();
					await pc.setLocalDescription(offer);
					sendSignal("offer", viewer.id, {
						offer,
						deviceId: "mira-chat-p2p",
					});
					console.log(`[chat:mesh] Host sent chat offer to ${viewer.id}`);
				} catch (err) {
					console.warn("[chat:mesh] error creating data offer:", err);
					try {
						pc.close();
					} catch {}
					peerConnectionsRef.current.delete(connKey);
					iceCandidateQueueRef.current.delete(connKey);
				}
			})();
		}
	}, [
		transport,
		roomCode,
		isHost,
		myUserId,
		realViewers,
		sendSignal,
		setupDataChannel,
	]);

	// Issue V2: Guaranteed periodic presence ping regardless of transport (mesh or livekit)
	useEffect(() => {
		if (!roomCode || !joinedRoom) return;
		const interval = setInterval(() => {
			mutationsRef.current.pingViewer({ roomCode }).catch(() => {});
		}, 20_000);
		return () => clearInterval(interval);
	}, [roomCode, joinedRoom]);

	// Everyone joins the room FIRST — the room queries above stay skipped until
	// this lands, so getRoom never fires for a non-participant. joinRoom is
	// idempotent (the host's viewers row was created by createRoom). Guests wait
	// until they've chosen a display name (name gate) before joining.
	const hasJoinedRef = useRef(false);
	useEffect(() => {
		if (hasJoinedRef.current || !myUserId || !roomCode) return;
		if (isAnonymousUser && !guestName) return;
		hasJoinedRef.current = true;
		let cancelled = false;
		mutationsRef.current
			.joinRoom({ roomCode, name: guestName ?? myName })
			.then(() => {
				if (!cancelled) {
					setJoinedRoom(true);
					setSidebarTab("chat"); // Instantly unlocks and focuses chat upon joining
				}
			})
			.catch((err) => {
				hasJoinedRef.current = false;
				if (cancelled) return;
				const msg = String((err as Error)?.message ?? err);
				if (/not live/i.test(msg)) {
					setJoinError("This session has ended.");
				} else if (/full/i.test(msg)) {
					setJoinError("This room is full (25 viewers max).");
				} else if (/not found/i.test(msg)) {
					setJoinError("Room not found — check the code with your host.");
				} else {
					setJoinError("Could not join the room. Please try again.");
				}
			});

		return () => {
			cancelled = true;
			hasJoinedRef.current = false;
		};
	}, [roomCode, myUserId, isAnonymousUser, guestName, myName]);

	// Mirror of joinedRoom for the interval above (avoids stale closure churn).
	const joinedRoomRef = useRef(false);
	joinedRoomRef.current = joinedRoom;

	// CRITICAL cleanup: on unmount, close every peer connection and stop every
	// captured track — previously these leaked and screen capture kept running
	// after leaving the page.
	useEffect(() => {
		return () => {
			isControlledByHostRef.current = false;
			controllingHostIdRef.current = null;
			grantedControlDeviceIdRef.current = null;
			grantedCaptureTrackRef.current = null;
			grantedRequestIdRef.current = null;
			pendingControlRequestRef.current = null;
			remoteControlStatusRef.current = "idle";
			if (controlRequestTimeoutRef.current)
				clearTimeout(controlRequestTimeoutRef.current);
			releaseAllRemoteInputs();
			resetRemoteInputState();
			if (cursorRafIdRef.current !== null)
				cancelAnimationFrame(cursorRafIdRef.current);
			closePeerConnections();
			if (hostStreamRef.current)
				hostStreamRef.current.getTracks().forEach((t) => t.stop());
			if (guestStreamRef.current)
				guestStreamRef.current.getTracks().forEach((t) => t.stop());
			hostStreamRef.current = null;
			guestStreamRef.current = null;
		};
	}, [closePeerConnections]);

	// Host: start screen broadcast.
	const startBroadcast = useCallback(async () => {
		if (!isHost) return;
		const scope = mediaScopeRef.current;
		const allowed = () =>
			mediaScopeRef.current === scope &&
			scope.active &&
			scope.live &&
			!isKickedByHost;
		if (!allowed()) return;
		if (
			typeof navigator === "undefined" ||
			!window.isSecureContext ||
			!navigator.mediaDevices?.getDisplayMedia
		) {
			toast.error(
				"This mobile browser does not expose screen sharing. Viewing and touch drawing still work; to broadcast your screen, use a browser/device where Share Screen is available.",
			);
			return;
		}
		if (transport === "livekit") {
			try {
				await liveKit.startScreenShare({
					resolution: config.resolution,
					fps: config.fps,
					audio: config.audioEnabled,
					bitrateKbps: config.bitrateKbps,
					codec: config.codec,
				});
				setIsBroadcasting(true);
				handleToggleStageMode("screens");
				if (roomCode) {
					mutationsRef.current
						.setSharingStatus({ roomCode, isSharing: true })
						.catch(() => {});
				}
				toast.success("LiveKit SFU broadcast started");
			} catch (err: any) {
				toast.error(
					"Failed to start LiveKit screen share: " +
						(err?.message || "Unknown error"),
				);
			}
			return;
		}
		try {
			const mediaStream = await captureDisplayIfAllowed(
				allowed,
				resolveScreenCaptureOptions(config),
			);

			if (!mediaStream) return;
			hostStreamRef.current = mediaStream;
			setIsBroadcasting(true);
			handleToggleStageMode("screens");
			try {
				const vTrack = mediaStream.getVideoTracks()[0];
				if (vTrack) {
					const surface = (vTrack.getSettings() as any)?.displaySurface;
					if (surface === "window" || surface === "monitor") {
						toast.info(
							"Window/monitor sharing is view-only. For browser control, stop sharing and choose this Ollashare tab.",
							{ duration: 6000 },
						);
					}
				}
			} catch {}
			mutationsRef.current
				.setSharingStatus({ roomCode, isSharing: true })
				.catch(() => {});

			const hostDevice: SharedDeviceStream = {
				id: "host-primary",
				deviceName: "Host Primary Screen",
				ownerId: myUserId ?? "host",
				ownerName: myName || "Host",
				isHost: true,
				stream: mediaStream,
				isLive: true,
				resolution: config.resolution,
				fps: config.fps,
				startedAt: Date.now(),
			};
			hostDeviceMetaRef.current = hostDevice;
			setSharedDevices((prev) => [
				hostDevice,
				...prev.filter((d) => d.id !== "host-primary"),
			]);

			const videoTrack = mediaStream.getVideoTracks()[0];
			if (videoTrack) {
				videoTrack.contentHint = "detail";
				videoTrack.onended = () => stopBroadcast();
			}

			// Mesh: offer to every peer currently in the room (deduplicated).
			const rawPeerIds: string[] = [];
			if (hostUserId && hostUserId !== myUserId) rawPeerIds.push(hostUserId);
			for (const viewer of realViewers) {
				if (viewer.id && viewer.id !== myUserId) rawPeerIds.push(viewer.id);
			}
			const uniquePeerIds = Array.from(new Set(rawPeerIds));
			for (const peerId of uniquePeerIds) {
				sendOfferToPeer(peerId, mediaStream, hostDevice);
			}

			toast.success(
				`Broadcasting Host Screen (${config.resolution} @ ${config.fps} FPS)`,
			);
		} catch (err) {
			const e = err as { name?: string; message?: string };
			if (e.name === "NotAllowedError") {
				toast.info("Screen selection was cancelled");
				return;
			}
			toast.error(`Could not start screen share: ${e.message || err}`);
		}
	}, [
		isHost,
		config,
		myUserId,
		myName,
		hostUserId,
		realViewers,
		sendOfferToPeer,
		stopBroadcast,
		handleToggleStageMode,
	]);

	// Guest: start screen sharing.
	const startGuestScreenshare = useCallback(async () => {
		if (isHost) return;
		const scope = mediaScopeRef.current;
		const allowed = () =>
			mediaScopeRef.current === scope &&
			scope.active &&
			scope.live &&
			!isKickedByHost;
		if (!allowed()) return;
		if (isControlledByHostRef.current) revokeGuestControlRef.current();
		sameTabConfirmedRef.current = false;
		setSameTabConfirmed(false);
		if (
			typeof navigator === "undefined" ||
			!window.isSecureContext ||
			!navigator.mediaDevices?.getDisplayMedia
		) {
			toast.error(
				"This mobile browser cannot broadcast its screen. Viewing and touch drawing remain available.",
			);
			return;
		}
		toast.info(
			"Choose any tab to share. Only this Ollashare tab supports remote control; other tabs, windows and monitors remain view-only.",
			{ duration: 8000 },
		);
		if (transport === "livekit") {
			try {
				if (!roomCode) throw new Error("Missing room code");
				const publishUpgrade = await mutationsRef.current.upgradeViewerToSharer(
					{ roomCode },
				);
				// Runtime permission upgrade: grants canPublish on the LIVE SFU session
				// (server-side, no reconnect). The fresh publish-capable token is stored
				// for future reconnects/token refreshes; the hook publishes on the
				// existing session so other participants see zero churn.
				setLiveKitTokenData(publishUpgrade);
				await liveKit.startScreenShare(
					{
						resolution: (config.resolution ||
							room?.resolution ||
							"1080p") as any,
						fps: config.fps || room?.fps || 60,
					},
					publishUpgrade.token,
				);
				setIsGuestSharing(true);
				handleToggleStageMode("screens");
				mutationsRef.current
					.setSharingStatus({ roomCode, isSharing: true })
					.catch(() => {});
				toast.success("LiveKit SFU screen share started");
			} catch (err: any) {
				if (roomCode)
					mutationsRef.current
						.setSharingStatus({ roomCode, isSharing: false })
						.catch(() => {});
				toast.error(
					"Failed to start LiveKit screen share: " +
						(err?.message || "Unknown error"),
				);
			}
			return;
		}
		try {
			if (!roomCode) throw new Error("Missing room code");
			// Mesh has no SFU token to upgrade. Reserve backend sharing authority
			// before opening the picker; rollback if capture is cancelled or fails.
			await mutationsRef.current.setSharingStatus({
				roomCode,
				isSharing: true,
			});
		} catch (error) {
			const message = String((error as Error)?.message ?? error);
			toast.error(
				/disabled by host|approval/i.test(message)
					? "Guest sharing is disabled. Ask the host to enable Guest Share or approve you."
					: "Screen sharing permission could not be granted.",
			);
			return;
		}
		try {
			const mediaStream = await captureDisplayIfAllowed(allowed, {
				video: { frameRate: { ideal: 60, max: 60 }, width: { ideal: 1920 } },
				audio: false,
				selfBrowserSurface: "include",
				preferCurrentTab: false,
				surfaceSwitching: "include",
			} as DisplayMediaStreamOptions);

			if (!mediaStream) return;
			guestStreamRef.current = mediaStream;
			const captureTrack = mediaStream.getVideoTracks()[0];
			localGuestCaptureRef.current = captureTrack
				? { deviceId: `guest-${myUserId}`, track: captureTrack }
				: null;
			sameTabConfirmedRef.current = false;
			setSameTabConfirmed(false);
			setIsGuestSharing(true);
			handleToggleStageMode("screens");
			try {
				const vTrack = mediaStream.getVideoTracks()[0];
				if (vTrack) {
					const surface = (vTrack.getSettings() as any)?.displaySurface;
					if (surface === "window" || surface === "monitor") {
						toast.info(
							"Window/monitor sharing is view-only. For browser control, stop sharing and choose this Ollashare tab.",
							{ duration: 6000 },
						);
					}
				}
			} catch {}
			const guestDevice: SharedDeviceStream = {
				id: `guest-${myUserId}`,
				deviceName: `${displayName}'s Device`,
				ownerId: myUserId ?? "guest",
				ownerName: displayName,
				isHost: false,
				stream: mediaStream,
				isLive: true,
				resolution: "1080p",
				fps: 60,
				startedAt: Date.now(),
			};
			guestDeviceMetaRef.current = guestDevice;
			setSharedDevices((prev) => [
				...prev.filter((d) => d.id !== guestDevice.id),
				guestDevice,
			]);

			const videoTrack = mediaStream.getVideoTracks()[0];
			if (videoTrack) {
				videoTrack.contentHint = "detail";
				videoTrack.onended = () => stopGuestScreenshare();
			}

			const rawPeerIds: string[] = [];
			if (hostUserId && hostUserId !== myUserId) rawPeerIds.push(hostUserId);
			for (const viewer of realViewers) {
				if (viewer.id && viewer.id !== myUserId) rawPeerIds.push(viewer.id);
			}
			const uniquePeerIds = Array.from(new Set(rawPeerIds));
			console.log(
				`[screenshare:startGuest] uniquePeerIds count=${uniquePeerIds.length}, ids=${JSON.stringify(uniquePeerIds)}, hostUserId=${hostUserId}, myUserId=${myUserId}`,
			);
			for (const peerId of uniquePeerIds) {
				sendOfferToPeer(peerId, mediaStream, guestDevice);
			}

			toast.success(
				`You are now sharing your screen (${guestDevice.deviceName})`,
			);
		} catch (err) {
			const e = err as { name?: string; message?: string };
			if (e.name === "NotAllowedError") {
				if (roomCode)
					mutationsRef.current
						.setSharingStatus({ roomCode, isSharing: false })
						.catch(() => {});
				toast.info("Screen selection was cancelled");
				return;
			}
			if (roomCode)
				mutationsRef.current
					.setSharingStatus({ roomCode, isSharing: false })
					.catch(() => {});
			toast.error(`Screen share failed: ${e.message || err}`);
		}
	}, [
		isHost,
		myUserId,
		myName,
		hostUserId,
		realViewers,
		sendOfferToPeer,
		stopGuestScreenshare,
		displayName,
		transport,
		liveKit.startScreenShare,
		roomCode,
		config.resolution,
		config.fps,
		room?.resolution,
		room?.fps,
		handleToggleStageMode,
	]);

	// Host: create a fresh room.
	const handleCreateRoom = useCallback(async () => {
		setCreatingRoom(true);
		try {
			let targetWsId = workspaceId;
			if (!targetWsId) {
				try {
					targetWsId = await ensureWorkspaceMutation({});
				} catch (wsErr) {
					console.warn("[screenshare] Failed to ensure workspace:", wsErr);
				}
			}
			if (!targetWsId) {
				toast.error("Initializing workspace, please try again in a moment.");
				return;
			}
			const chosenHostName =
				hostNameInput.trim() || customName || myName || "Host";
			if (typeof window !== "undefined") {
				localStorage.setItem("mira_user_name", chosenHostName);
			}
			setCustomName(chosenHostName);
			const result = await mutationsRef.current.createRoom({
				workspaceId: targetWsId,
				hostName: chosenHostName,
				title: "Screenshare Session",
				resolution: config.resolution,
				fps: config.fps,
				bitrateKbps: config.bitrateKbps,
				codec: config.codec,
				audioEnabled: config.audioEnabled,
				allowGuestSharing: true,
			});
			setRoomCode(result.code);
			// Reset the join gate so the join effect re-runs for the new room, then
			// queries activate once the join lands.
			hasJoinedRef.current = false;
			setJoinedRoom(false);
			setJoinError(null);
			if (typeof window !== "undefined") {
				const url = new URL(window.location.href);
				url.searchParams.set("room", result.code);
				window.history.replaceState({}, "", url);
			}
			toast.success(`Room created: ${result.code}`);
		} catch (err) {
			const e = err as { message?: string };
			toast.error(`Failed to create room: ${e?.message ?? "unknown error"}`);
		} finally {
			setCreatingRoom(false);
		}
	}, [workspaceId, config]);

	// Join session via invite link or room code with automatic URL parameter extraction and redirection
	const handleJoinByInviteLink = useCallback(
		(rawInput?: string) => {
			const input = (rawInput ?? inviteLinkInput).trim();
			if (!input) {
				toast.error("Please enter a valid guest invite link");
				return;
			}

			let targetUrl: URL;
			try {
				targetUrl = new URL(input, window.location.origin);
			} catch {
				toast.error("Paste the complete guest invite link from the host.");
				return;
			}
			if (
				targetUrl.origin !== window.location.origin ||
				!targetUrl.pathname.endsWith("/screenshare")
			) {
				toast.error("Paste a guest invite link for this Ollashare site.");
				return;
			}
			const codeToJoin =
				targetUrl.searchParams.get("room") ||
				targetUrl.searchParams.get("code") ||
				"";
			const guestInviteToken =
				new URLSearchParams(targetUrl.hash.slice(1)).get("guestInvite") || "";
			if (
				!/^MIRA-[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(
					codeToJoin.toUpperCase(),
				) ||
				!/^[a-f0-9]{64}$/i.test(guestInviteToken)
			) {
				toast.error("This is not a valid guest invite link.");
				return;
			}

			const nameToSave = guestJoinNameInput.trim() || customName || myName;
			if (nameToSave) {
				try {
					localStorage.setItem("mira_user_name", nameToSave);
				} catch {}
			}

			targetUrl.search = `?room=${encodeURIComponent(codeToJoin.toUpperCase())}`;
			targetUrl.hash = `guestInvite=${guestInviteToken}`;
			window.location.href = targetUrl.toString();
		},
		[inviteLinkInput, guestJoinNameInput, customName, myName],
	);

	// Host: persist config changes to the room doc (reactive for guests).
	// Mid-broadcast behavior is honest about what can change live:
	//   - bitrate: applies LIVE to every sender (no renegotiation needed)
	//   - fps: applies LIVE via track constraints where the browser supports it
	//   - resolution / codec: only take effect on the next share — the user is
	//     told to restart instead of being shown a lie.
	const handleConfigChange = useCallback(
		(patch: Partial<StreamQualityConfig>) => {
			if (!isHost) return;
			const next = { ...config, ...patch };
			setConfig(next);
			if (roomCode) {
				mutationsRef.current
					.updateRoomSettings({
						code: roomCode,
						...(patch.resolution !== undefined
							? { resolution: patch.resolution }
							: {}),
						...(patch.fps !== undefined ? { fps: patch.fps } : {}),
						...(patch.bitrateKbps !== undefined
							? { bitrateKbps: patch.bitrateKbps }
							: {}),
						...(patch.codec !== undefined ? { codec: patch.codec } : {}),
						...(patch.audioEnabled !== undefined
							? { audioEnabled: patch.audioEnabled }
							: {}),
					})
					.catch(() => {});
			}

			if (!isBroadcasting) return;

			if (patch.bitrateKbps !== undefined) {
				const track =
					hostStreamRef.current?.getVideoTracks()[0] ??
					guestStreamRef.current?.getVideoTracks()[0] ??
					null;
				updateLiveBitrate(
					peerConnectionsRef.current.values(),
					track,
					patch.bitrateKbps,
				)
					.then((applied) => {
						if (applied) {
							toast.success(
								`Bitrate now ${(patch.bitrateKbps ?? 0) / 1000} Mbps (live)`,
							);
						} else {
							toast.warning("Bitrate change will apply on the next share.");
						}
					})
					.catch(() => {});
			}
			if (patch.fps !== undefined) {
				const track =
					hostStreamRef.current?.getVideoTracks()[0] ??
					guestStreamRef.current?.getVideoTracks()[0] ??
					null;
				const liveFpsUpdate =
					transport === "livekit"
						? liveKit.updateScreenShareFps(patch.fps)
						: updateLiveFps(
								peerConnectionsRef.current.values(),
								track,
								patch.fps,
							);
				liveFpsUpdate
					.then((applied) => {
						if (applied) {
							setSharedDevices((current) =>
								current.map((device) =>
									device.ownerId === myUserId
										? { ...device, fps: patch.fps as ReadableMediaFps }
										: device,
								),
							);
							toast.success(`Outgoing stream capped at ${patch.fps} FPS`);
						} else {
							toast.info(
								"Frame rate changes apply when you restart your share.",
							);
						}
					})
					.catch(() => {});
			}
			if (patch.resolution !== undefined || patch.codec !== undefined) {
				toast.info(
					"Resolution/codec changes apply when you restart your share.",
				);
			}
		},
		[isHost, config, roomCode, isBroadcasting, liveKit, myUserId, transport],
	);

	// Host: toggle allowGuestSharing on the room
	const handleToggleGuestSharing = useCallback(async () => {
		if (!isHost || !roomCode || !room) return;
		const nextAllowed = !room.allowGuestSharing;
		try {
			await setAllowGuestSharingMutation({
				code: roomCode,
				allowed: nextAllowed,
			});
			toast.success(
				nextAllowed
					? "Guest sharing enabled: participants can broadcast their screen"
					: "Guest sharing restricted: only host can share screen",
			);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to update guest sharing",
			);
		}
	}, [isHost, roomCode, room, setAllowGuestSharingMutation]);

	// Host: toggle lock state on the room (prevents new guests from joining)
	const handleToggleRoomLock = useCallback(async () => {
		if (!isHost || !roomCode || !room) return;
		const nextLocked = !room.isLocked;
		try {
			await mutationsRef.current.setRoomLock({
				code: roomCode,
				locked: nextLocked,
			});
			toast.success(
				nextLocked
					? "Room is now locked (no new guests can enter)"
					: "Room unlocked",
			);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to update lock state",
			);
		}
	}, [isHost, roomCode, room]);

	// Host: remove a participant from the room (modal-confirmed)
	const [kickingViewer, setKickingViewer] = useState<{
		id: string;
		name: string;
	} | null>(null);

	const handleKickParticipant = useCallback(
		(viewerId: string, viewerName: string) => {
			if (!isHost || !roomCode) return;
			setKickingViewer({ id: viewerId, name: viewerName });
		},
		[isHost, roomCode],
	);

	const handleConfirmKick = useCallback(async () => {
		if (!kickingViewer || !roomCode) return;
		const target = kickingViewer;
		setKickingViewer(null);
		try {
			// 1. Immediately purge kicked guest's screen from Host's UI
			setSharedDevices((prev) =>
				prev.filter(
					(d) => d.ownerId !== target.id && d.id !== `guest-${target.id}`,
				),
			);
			if (zoomedDeviceId && zoomedDeviceId === `guest-${target.id}`) {
				setZoomedDeviceId(null);
			}

			// 2. Dispatch real-time KICK_NOTICE directly to the kicked guest over WebRTC DataChannel
			const kickNoticePayload = JSON.stringify({
				type: "KICK_NOTICE",
				kickedViewerId: target.id,
				kickedName: target.name,
				reason: "You have been kicked by the host.",
			});

			const targetDc = dataChannelsRef.current.get(target.id);
			if (targetDc && targetDc.readyState === "open") {
				try {
					targetDc.send(kickNoticePayload);
				} catch (err) {
					console.warn(
						"[chat:kick] Failed to send kick notice via data channel:",
						err,
					);
				}
			}

			// Also publish via LiveKit if in SFU transport
			if (
				transport === "livekit" &&
				liveKit.room &&
				(liveKit.room as any).state === "connected"
			) {
				try {
					liveKit.room.localParticipant.publishData(
						encodeLiveKitData(kickNoticePayload),
						{ reliable: true },
					);
				} catch {}
			}

			// 3. Immediately close and delete all WebRTC connections with target on Host side
			for (const [key, pc] of peerConnectionsRef.current.entries()) {
				if (key.includes(target.id)) {
					try {
						pc.close();
					} catch {}
					peerConnectionsRef.current.delete(key);
				}
			}
			if (targetDc) {
				try {
					targetDc.close();
				} catch {}
				dataChannelsRef.current.delete(target.id);
			}

			// 5. Execute Convex kick mutation / action
			if (mutationsRef.current.kickParticipantAction) {
				await mutationsRef.current.kickParticipantAction({
					roomCode,
					viewerId: target.id as Id<"users">,
					durationMs: 0,
				});
			} else {
				await mutationsRef.current.kickParticipant({
					roomCode,
					viewerId: target.id as Id<"users">,
					durationMs: 0,
				});
			}
			toast.success(`Kicked ${target.name} from session`);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to kick participant",
			);
		}
	}, [kickingViewer, roomCode, zoomedDeviceId, transport, liveKit.room]);

	// Issue 9: WebRTC stats collector (RTT & bitrate every ~5s, non-blocking)
	useEffect(() => {
		if (!roomCode) return;

		const interval = setInterval(async () => {
			if (peerConnectionsRef.current.size === 0) return;

			for (const [peerId, pc] of peerConnectionsRef.current.entries()) {
				if (pc.connectionState !== "connected") continue;
				try {
					const rawStats = await pc.getStats();
					const stats = extractPeerStats(rawStats);
					if (stats.rttMs !== undefined) {
						captureBreadcrumb(
							"webrtc.stats",
							`Peer ${peerId} RTT: ${stats.rttMs}ms`,
							{
								peerId,
								rttMs: stats.rttMs,
								bytesReceived: stats.bytesReceived,
								bytesSent: stats.bytesSent,
							},
						);
					}
				} catch {
					// Non-blocking
				}
			}
		}, 5000);

		return () => clearInterval(interval);
	}, [roomCode]);

	// Host: end the room (also stops broadcasting and returns to fresh state).
	const handleEndRoom = useCallback(() => {
		if (!isHost || !roomCode) return;
		const grant = pendingControlRequestRef.current;
		if (grant) handleReleaseRemoteControl(grant.deviceId, grant.guestId);
		stopBroadcast();
		mutationsRef.current
			.endRoom({ code: roomCode })
			.then(() => {
				setRoomCode("");
				setJoinedRoom(false);
				hasJoinedRef.current = false;
				if (typeof window !== "undefined") {
					const url = new URL(window.location.href);
					url.searchParams.delete("room");
					window.history.replaceState({}, "", url);
				}
				toast.info("Session ended");
			})
			.catch(() => {
				toast.error("Could not end the session.");
			});
	}, [isHost, roomCode, stopBroadcast, handleReleaseRemoteControl]);

	// Guests sync config from the room doc.
	useEffect(() => {
		if (isHost || !room) return;
		setConfig({
			resolution: room.resolution as StreamQualityConfig["resolution"],
			fps: room.fps as ReadableMediaFps,
			bitrateKbps: room.bitrateKbps,
			codec: room.codec as StreamQualityConfig["codec"],
			audioEnabled: room.audioEnabled,
		});
	}, [isHost, room]);

	// ---- Full View Mode & Fullscreen Handlers -------------------------------
	const theaterRef = useRef<HTMLDivElement>(null);
	const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

	const enterTheater = useCallback(() => {
		setTheaterMode(true);
	}, []);

	const exitTheater = useCallback(() => {
		setTheaterMode(false);
		if (typeof document !== "undefined" && document.fullscreenElement) {
			document.exitFullscreen().catch(() => {});
		}
	}, []);

	const toggleNativeFullscreen = useCallback(() => {
		if (typeof document === "undefined") return;
		if (!document.fullscreenElement) {
			const el = theaterRef.current ?? document.documentElement;
			if (el?.requestFullscreen) {
				el.requestFullscreen().catch(() => {});
			}
		} else {
			document.exitFullscreen().catch(() => {});
		}
	}, []);

	useEffect(() => {
		if (typeof document === "undefined") return;
		const handleFsChange = () => {
			setIsFullscreen(Boolean(document.fullscreenElement));
		};
		document.addEventListener("fullscreenchange", handleFsChange);
		return () =>
			document.removeEventListener("fullscreenchange", handleFsChange);
	}, []);

	// Esc key exits Zoom Mode (if zoomed) or exits Full View Mode.
	useEffect(() => {
		if (!theaterMode && !zoomedDeviceId && remoteControlStatus !== "active")
			return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (
					remoteControlStatusRef.current === "active" &&
					remoteControlTargetRef.current
				) {
					const dev = sharedDevices.find(
						(d) => d.id === remoteControlTargetRef.current,
					);
					handleReleaseRemoteControl(
						remoteControlTargetRef.current,
						dev?.ownerId || "",
					);
					return;
				}
				if (zoomedDeviceId) {
					setZoomedDeviceId(null);
				} else if (theaterMode) {
					exitTheater();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		theaterMode,
		zoomedDeviceId,
		remoteControlStatus,
		sharedDevices,
		exitTheater,
		handleReleaseRemoteControl,
	]);

	// ---- Kicked by host screen --------------------------------------------
	// When a guest is kicked by the host, completely unmount the session UI,
	// close all media tracks, and present a dedicated Apple-style frosted eviction screen.
	if (isKickedByHost) {
		return (
			<div className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-[#fafaff] px-4 py-16 text-[#08080b]">
				<SignupMesh />
				<div className="relative z-10 w-full max-w-md rounded-[22px] bg-white p-8 text-center shadow-[0_24px_65px_rgba(31,31,56,.14)] animate-in fade-in zoom-in-95 duration-300">
					<div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#ffe6e6] text-[#b52d2d]">
						<UserMinus className="h-8 w-8" />
					</div>
					<h2 className="text-xl font-bold tracking-tight text-[#08080b]">
						You have been kicked by the host
					</h2>
					<p className="mt-2.5 text-xs leading-relaxed text-[#666b77]">
						The host has removed you from this screenshare session. Your screen
						share has been closed and your chat access has been revoked.
					</p>
					<div className="mt-6 flex flex-col gap-2.5">
						<button
							type="button"
							onClick={() => {
								setIsKickedByHost(false);
								setRoomCode("");
								if (typeof window !== "undefined") {
									window.location.href = "/screenshare";
								}
							}}
							className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0a0a0d] py-3 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#292931] active:scale-98"
						>
							Start Your Own Session
						</button>
						<button
							type="button"
							onClick={() => {
								setIsKickedByHost(false);
								setRoomCode("");
								if (typeof window !== "undefined") {
									window.location.href = "/";
								}
							}}
							className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#f0f1f5] py-3 text-xs font-semibold text-[#4e535f] transition hover:bg-[#e5e7ed]"
						>
							Return to Dashboard
						</button>
					</div>
				</div>
			</div>
		);
	}

	// ---- Guest name gate screen -------------------------------------------
	// Guests arriving via invite link pick a display name before joining. This
	// runs before any room queries fire (join happens after the name is set).
	if (needsNameGate) {
		return (
			<div className="relative flex min-h-full w-full flex-col items-center justify-center overflow-hidden bg-[#fafaff] px-4 py-16 text-[#08080b]">
				<SignupMesh />
				<div className="relative z-10 w-full max-w-md rounded-[22px] bg-white p-7 shadow-[0_24px_65px_rgba(31,31,56,.14)]">
					<div className="mb-6 flex flex-col items-center text-center">
						<span
							className="mb-4 grid grid-cols-2 gap-[2px]"
							aria-hidden="true"
						>
							<i className="block h-4 w-4 rounded-[5px] bg-[#7659ef]" />
							<i className="block h-4 w-4 rounded-[5px] bg-[#a99dff]" />
							<i className="block h-4 w-4 rounded-[5px] bg-[#a99dff]" />
							<i className="block h-4 w-4 rounded-[5px] bg-[#7659ef]" />
						</span>
						<h1 className="text-2xl font-bold tracking-[-0.04em] text-[#08080b]">
							Join Screenshare Session
						</h1>
						<p className="mt-2 text-sm text-[#666b77]">
							You have been invited to room{" "}
							<strong className="rounded-md bg-[#ece9ff] px-2 py-1 font-semibold text-[#5d42d6]">
								{roomCode}
							</strong>
							. Enter your name so the host and other participants know who you
							are.
						</p>
					</div>

					<form
						className="mt-5"
						onSubmit={async (e) => {
							e.preventDefault();
							const nameValue = nameInputRef.current?.value?.trim();
							if (!nameValue || guestNameSubmitting || !roomCode) return;
							const chosen = nameValue.slice(0, 50);
							setGuestNameSubmitting(true);
							// Close the gate synchronously and persist before the idempotent
							// server rename. Reactive room/viewer updates can otherwise remount
							// this branch and detach the newly rendered Share button.
							localStorage.setItem("mira_user_name", chosen);
							setGuestName(chosen);
							try {
								await mutationsRef.current.joinRoom({ roomCode, name: chosen });
							} catch {
								localStorage.removeItem("mira_user_name");
								setGuestName(null);
								toast.error("Could not join the session. Please try again.");
							} finally {
								setGuestNameSubmitting(false);
							}
						}}
					>
						<label className="mb-1.5 block text-xs font-semibold text-[#30323a]">
							Your display name
						</label>
						<input
							ref={nameInputRef}
							type="text"
							autoFocus
							maxLength={50}
							placeholder="e.g. Priya Sharma"
							className="h-12 w-full rounded-xl border-0 bg-[#f0f1f5] px-4 text-sm text-[#111116] outline-none transition placeholder:text-[#878b96] focus:bg-white focus:ring-2 focus:ring-[#7659ef]"
						/>
						<button
							type="submit"
							disabled={guestNameSubmitting}
							className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#0a0a0d] px-4 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#292931] disabled:opacity-60"
						>
							<Play className="h-4 w-4 fill-current" />
							{guestNameSubmitting ? "Joining…" : "Join Session"}
						</button>
						<p className="mt-3 text-center text-[11px] leading-relaxed text-[#737885]">
							Joining as a viewer. You can share your own screen once you are in
							the session.
						</p>
					</form>
				</div>
			</div>
		);
	}

	const compactRoomActive = mobileLayout.isCompact && joinedRoom;
	const mobileSheetId = "mobile-room-sheet";
	const mobileSheetTitle =
		mobileSheet === "screens"
			? "Screens and view controls"
			: mobileSheet === "participants"
				? "Participants"
				: mobileSheet === "chat"
					? "Room chat"
					: "Room settings and invitations";
	const handleOpenMobileSheet = (sheet: MobileRoomSheetKind) => {
		setMobileSheet((current) => (current === sheet ? null : sheet));
		if (sheet === "chat") setUnreadCount(0);
	};
	const toggleOwnScreenShare = () => {
		if (isHost) {
			if (isBroadcasting) stopBroadcast();
			else void startBroadcast();
			return;
		}
		if (isGuestSharing) stopGuestScreenshare();
		else void startGuestScreenshare();
	};

	return (
		<div
			data-mira-dashboard-ui="true"
			data-mobile-room-compact={mobileLayout.isCompact ? "true" : "false"}
			data-mobile-room-orientation={mobileLayout.orientation}
			style={mobileLayout.viewportStyle}
			className={`flex min-h-0 w-full flex-col overflow-x-hidden bg-[#fafaff] text-[#08080b] selection:bg-[#7659ef]/20 font-sans ${compactRoomActive ? "h-[var(--mobile-room-viewport-height)] pb-[calc(4.5rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]" : "h-full"}`}
		>
			{joinedRoom && !compactRoomActive && (
				<p className="border-b border-[#d8d2ff] bg-[#ece9ff] px-3 py-2 text-[11px] leading-relaxed text-[#4f3abf] sm:px-6 sm:text-xs">
					Browser-only control supports this Ollashare tab only. Guests: choose
					this Ollashare tab in the share picker. Other tabs, windows and full
					monitors remain view-only. No downloads or desktop access.
				</p>
			)}
			{/* Top Control Bar */}
			<div
				className={`${compactRoomActive ? "hidden" : "flex"} flex-col gap-2 border-b border-black/5 bg-white px-2 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:px-6 sm:py-3`}
			>
				<div className="flex min-w-0 items-start gap-3">
					<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#ece9ff] text-[#5d42d6]">
						<ScreenShare className="h-5 w-5" />
					</div>
					<div>
						<h1 className="text-base font-semibold tracking-tight text-[#08080b]">
							Ollashare Screenshare Studio
						</h1>
						<div className="mt-1 flex max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain pb-1 text-xs text-[#666b77] touch-pan-x [scrollbar-width:none] [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible sm:pb-0">
							Room:{" "}
							<strong className="rounded-md bg-[#ece9ff] px-2 py-0.5 text-[#5d42d6]">
								{roomCode || "— create a room —"}
							</strong>
							{!identityLoading && isHost && (
								<button
									type="button"
									onClick={handleCreateRoom}
									disabled={creatingRoom}
									className="ml-1 inline-flex items-center gap-1 rounded border border-[#cfc5ff] bg-[#ece9ff] px-2 py-0.5 font-sans text-[10px] text-[#5d42d6] transition hover:bg-[#ded8ff]"
								>
									<Plus className="h-3 w-3" />
									{creatingRoom
										? "Creating…"
										: roomCode
											? "New Room"
											: "Create Room"}
								</button>
							)}
							<button
								type="button"
								onClick={() => {
									if (!roomCode) {
										setFrontpageTab("join");
									} else {
										setShowJoinModal(true);
									}
								}}
								className="ml-1 inline-flex items-center gap-1 rounded border border-[#dedee5] bg-[#f0f1f5] px-2 py-0.5 font-sans text-[10px] text-[#4e535f] transition hover:bg-[#e5e7ed] hover:text-[#08080b]"
								title="Join a session via invite link"
							>
								<Link2 className="h-3 w-3 text-[#7659ef]" />
								Join via Link
							</button>
							{!identityLoading && isHost && roomCode && room && (
								<>
									<button
										type="button"
										onClick={handleToggleRoomLock}
										className={`ml-1 inline-flex items-center gap-1 rounded border px-2 py-0.5 font-sans text-[10px] transition ${
											room?.isLocked
												? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
												: "border-[#dedee5] bg-[#f0f1f5] text-[#4e535f] hover:bg-[#e5e7ed] hover:text-[#08080b]"
										}`}
										title={
											room?.isLocked
												? "Unlock room"
												: "Lock room (prevent new guests)"
										}
									>
										{room?.isLocked ? (
											<Lock className="h-3 w-3" />
										) : (
											<Unlock className="h-3 w-3" />
										)}
										{room?.isLocked ? "Locked" : "Lock"}
									</button>
									<button
										type="button"
										onClick={handleToggleGuestSharing}
										className={`ml-1 inline-flex items-center gap-1 rounded border px-2 py-0.5 font-sans text-[10px] transition ${
											room?.allowGuestSharing
												? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
												: "border-[#dedee5] bg-[#f0f1f5] text-[#4e535f] hover:bg-[#e5e7ed] hover:text-[#08080b]"
										}`}
										title={
											room?.allowGuestSharing
												? "Guest sharing enabled (guests can publish screen)"
												: "Guest sharing restricted (guests require host approval to share)"
										}
									>
										<Share2 className="h-3 w-3" />
										{room?.allowGuestSharing
											? "Guest Share: ON"
											: "Guest Share: OFF"}
									</button>
									<button
										type="button"
										onClick={handleEndRoom}
										className="ml-1 inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-0.5 font-sans text-[10px] text-red-700 transition hover:bg-red-100"
									>
										End Room
									</button>
								</>
							)}
						</div>
					</div>
				</div>

				<div className="flex max-w-full flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain pb-1 touch-pan-x [scrollbar-width:none] [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible sm:pb-0 sm:gap-2.5">
					{/* Identity & Change Name (Issue 1 & 2) */}
					<div className="flex items-center gap-1.5 rounded-lg border border-[#dedee5] bg-[#f0f1f5] px-2.5 py-1 text-xs">
						<span className="text-[#666b77]">You:</span>
						<span
							suppressHydrationWarning
							className="font-semibold text-[#5d42d6] max-w-[120px] truncate"
							title={displayName}
						>
							{displayName}
						</span>
						<span
							suppressHydrationWarning
							className="rounded bg-white px-1 py-0.5 text-[10px] font-medium text-[#5d42d6]"
						>
							{isHost ? "Host" : "Guest"}
						</span>
						{roomCode && (
							<button
								type="button"
								onClick={() => {
									setNameEditValue(
										guestName ?? (isHost ? room?.hostName || myName : myName),
									);
									setShowNameModal(true);
								}}
								className="ml-1 flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[10px] text-[#4e535f] transition hover:bg-[#ece9ff] hover:text-[#5d42d6]"
								title="Change your display name"
							>
								<Edit2 className="h-2.5 w-2.5" />
								Change
							</button>
						)}
					</div>

					{!identityLoading && isHost && roomCode && (
						<>
							<button
								type="button"
								onClick={() => setShowInviteManager((current) => !current)}
								className="flex items-center gap-1.5 rounded-lg border border-[#cfc5ff] bg-[#ece9ff] px-3.5 py-1.5 text-xs font-medium text-[#5d42d6] transition hover:bg-[#ded8ff]"
								aria-expanded={showInviteManager}
								title="Manage secure guest invitation links"
							>
								<Link2 className="h-3.5 w-3.5" />
								Guest Invitations
							</button>

							<Link
								href="/activity"
								className="flex items-center gap-1.5 rounded-lg border border-[#dedee5] bg-[#f0f1f5] px-3 py-1.5 text-xs font-semibold text-[#4e535f] transition hover:bg-[#e5e7ed]"
								title="Open Administrative Live Sessions & Audit Trail"
							>
								<ShieldCheck className="h-3.5 w-3.5 text-[#7659ef]" />
								<span className="hidden sm:inline">Sessions & Audit</span>
							</Link>
						</>
					)}

					{/* In-Room Chat Quick Toggle (Apple UI) */}
					{joinedRoom && (
						<button
							type="button"
							onClick={() => {
								setSidebarTab("chat");
								setUnreadCount(0);
							}}
							className={`relative flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
								sidebarTab === "chat"
									? "border-[#cfc5ff] bg-[#ece9ff] text-[#5d42d6]"
									: "border-[#dedee5] bg-[#f0f1f5] text-[#666b77] hover:bg-[#e5e7ed] hover:text-[#08080b]"
							}`}
							title="Open In-Room Chat"
						>
							<MessageSquare className="h-3.5 w-3.5 text-[#7659ef]" />
							<span>Chat</span>
							{unreadCount > 0 && (
								<span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-white shadow-sm animate-pulse">
									{unreadCount}
								</span>
							)}
						</button>
					)}

					{/* Host quick viewers & moderation panel access */}
					{joinedRoom && isHost && (
						<button
							type="button"
							onClick={() => setSidebarTab("viewers")}
							className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
								sidebarTab === "viewers"
									? "border-[#cfc5ff] bg-[#ece9ff] text-[#5d42d6]"
									: "border-[#dedee5] bg-[#f0f1f5] text-[#666b77] hover:bg-[#e5e7ed] hover:text-[#08080b]"
							}`}
							title="Open Viewers & Moderation Panel"
						>
							<Users className="h-3.5 w-3.5 text-[#7659ef]" />
							<span>
								{realViewers.length}{" "}
								{realViewers.length === 1 ? "User" : "Users"}
							</span>
						</button>
					)}

					{/* Stage Mode Switcher: Screens vs Interactive Presentation Stage */}
					{joinedRoom && (
						<div className="flex w-full min-w-0 max-w-full flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain rounded-xl border border-[#dedee5] bg-[#f0f1f5] p-0.5 pb-1 touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:w-auto sm:pb-0">
							<button
								type="button"
								onClick={() => handleToggleStageMode("screens")}
								className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition sm:min-h-0 sm:px-2.5 sm:py-1 ${
									stageMode === "screens"
										? "bg-[#7659ef] text-white font-semibold"
										: "text-[#666b77] hover:bg-white hover:text-[#08080b]"
								}`}
								title="View active screen shares"
							>
								<ScreenShare className="h-3 w-3" />
								<span>Screens ({sharedDevices.length})</span>
							</button>
							<button
								type="button"
								onClick={() => handleToggleStageMode("presentation")}
								className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition sm:min-h-0 sm:px-2.5 sm:py-1 ${
									stageMode === "presentation"
										? "bg-[#7659ef] text-white font-semibold"
										: "text-[#666b77] hover:bg-white hover:text-[#08080b]"
								}`}
								title="Open interactive collaborative presentation stage (Zero mismatch, pure web)"
							>
								<Presentation className="h-3 w-3" />
								<span>Presentation Stage</span>
							</button>
							<button
								type="button"
								onClick={() => handleToggleStageMode("shared-browser")}
								className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition sm:min-h-0 sm:px-2.5 sm:py-1 ${
									stageMode === "shared-browser"
										? "bg-[#7659ef] text-white font-semibold"
										: "text-[#666b77] hover:bg-white hover:text-[#08080b]"
								}`}
								title="Open an isolated Shared Browser using a short-lived backend grant"
							>
								<Globe2 className="h-3 w-3" />
								<span>Shared Browser</span>
								{sharedBrowserViewerState === "connected" && (
									<span
										className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700"
										title="Shared Browser remains connected in the background"
									>
										<span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
										{stageMode === "shared-browser"
											? "Connected"
											: "Background"}
									</span>
								)}
							</button>
						</div>
					)}

					{/* Mode Controls: Zoom Mode & Full View Mode */}
					{joinedRoom &&
						stageMode === "screens" &&
						sharedDevices.length > 0 && (
							<>
								<button
									type="button"
									onClick={() =>
										setZoomedDeviceId((prev) =>
											prev ? null : sharedDevices[0]?.id ?? null,
										)
									}
									className={`flex items-center gap-1.5 rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition ${
										zoomedDeviceId
											? "border-sky-500 bg-sky-500/20 text-sky-300 shadow"
											: "border-slate-700 bg-slate-900/80 text-slate-300 hover:bg-slate-800"
									}`}
									title="Zoom Mode: focus on a particular device screen share"
								>
									{zoomedDeviceId ? (
										<>
											<LayoutGrid className="h-3.5 w-3.5" />
											Exit Zoom
										</>
									) : (
										<>
											<ZoomIn className="h-3.5 w-3.5" />
											Zoom Mode
										</>
									)}
								</button>

								<button
									type="button"
									onClick={enterTheater}
									className="flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3.5 py-1.5 text-xs font-semibold text-sky-300 shadow transition hover:bg-sky-500/20 hover:text-white"
									title="Full View Mode: expand video view across the entire window with zero sidebars"
								>
									<Maximize2 className="h-3.5 w-3.5" />
									Full View
								</button>
							</>
						)}

					{identityLoading ? (
						<span className="text-[11px] text-slate-500">Connecting…</span>
					) : isHost ? (
						isBroadcasting ? (
							<button
								type="button"
								onClick={stopBroadcast}
								className="flex items-center gap-2 rounded-lg bg-red-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-red-500/20 transition hover:bg-red-400"
							>
								<Square className="h-3.5 w-3.5 fill-current" />
								Stop Screen
							</button>
						) : (
							roomCode && (
								<button
									type="button"
									onClick={startBroadcast}
									disabled={isLiveKitConnecting}
									className={`flex items-center gap-2 rounded-lg bg-[#7659ef] px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-[#6247da] ${
										isLiveKitConnecting ? "cursor-not-allowed opacity-60" : ""
									}`}
								>
									{isLiveKitConnecting ? (
										<>
											<span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white" />
											Connecting…
										</>
									) : (
										<>
											<Play className="h-3.5 w-3.5 fill-current" />
											Share My Screen
										</>
									)}
								</button>
							)
						)
					) : isGuestSharing ? (
						<button
							type="button"
							onClick={stopGuestScreenshare}
							className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/20 px-3.5 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/30"
						>
							<Square className="h-3.5 w-3.5 fill-current" />
							Stop My Screen
						</button>
					) : (
						<button
							type="button"
							onClick={startGuestScreenshare}
							disabled={isLiveKitConnecting}
							className={`flex items-center gap-1.5 rounded-lg bg-[#7659ef] px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-[#6247da] ${
								isLiveKitConnecting ? "cursor-not-allowed opacity-60" : ""
							}`}
						>
							{isLiveKitConnecting ? (
								<>
									<span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white" />
									Connecting…
								</>
							) : (
								<>
									<ScreenShare className="h-3.5 w-3.5" />
									Share My Screen
								</>
							)}
						</button>
					)}
				</div>
			</div>

			{/* Main Work Area */}
			<div
				className={`flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden ${compactRoomActive ? "overflow-hidden" : "overflow-y-auto"}`}
			>
				<RoomLocalRecording
					roomCode={roomCode}
					joined={joinedRoom}
					roomLive={room?.status === "live"}
					isHost={isHost}
					compact={mobileLayout.isCompact}
					controlsPortalTarget={recordingControlsPortalTarget}
					sourceAvailable={
						isBroadcasting ||
						isGuestSharing ||
						sharedDevices.some((device) => device.isLive)
					}
					screenSources={sharedDevices}
					liveKitScreenAudioTracks={liveKit.screenAudioTracks}
					focusedSourceId={zoomedDeviceId}
					screenAnnotations={annotationStrokes}
					screenAnnotationDrafts={recordingAnnotationDrafts}
					sharedBrowserFrame={
						sharedBrowserFrame ??
						(sharedBrowserViewerState === "loading"
							? lastConnectedSharedBrowserFrameRef.current
							: null)
					}
					sharedBrowserViewerState={sharedBrowserViewerState}
					sharedBrowserAnnotations={sharedBrowserAnnotationStrokes}
					sharedBrowserAnnotationDraft={sharedBrowserRecordingDraft}
				/>
				{/* Video Stage */}
				<div
					className={`relative flex min-w-0 flex-1 flex-col items-center justify-center bg-[#f1efff] ${compactRoomActive ? "min-h-0 overflow-auto p-1" : "min-h-[48dvh] overflow-y-auto p-2 sm:min-h-[55vh] sm:p-4 lg:min-h-0"}`}
				>
					{/* Host Mismatch Notice: if user opened role=host but belongs to someone else */}
					{roleParam === "host" && room && room.hostId !== myUserId && (
						<div className="mb-4 flex w-full max-w-5xl items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
							<div className="flex items-center gap-2.5">
								<AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
								<span>
									You opened a host link for room <strong>{roomCode}</strong>,
									but this room was created by another host. To become the host,
									create your own session.
								</span>
							</div>
							<button
								type="button"
								onClick={() => {
									setRoomCode("");
									hasJoinedRef.current = false;
									setJoinedRoom(false);
									if (typeof window !== "undefined") {
										const url = new URL(window.location.href);
										url.searchParams.delete("room");
										window.history.replaceState({}, "", url);
									}
								}}
								className="shrink-0 rounded-lg bg-sky-500 px-3 py-1 font-semibold text-white shadow hover:bg-sky-400 transition"
							>
								Create My Own Room as Host
							</button>
						</div>
					)}
					{/* Issue 4: Mesh topology guardrail warning */}
					{joinedRoom &&
						!joinError &&
						(sharedDevices.length > 3 || realViewers.length > 8) && (
							<div className="mb-3 flex w-full max-w-5xl items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
								<div className="flex items-center gap-2.5">
									<AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
									<span>
										<strong>Large room detected:</strong> {realViewers.length}{" "}
										participants connected, {sharedDevices.length} simultaneous
										screen shares. In full P2P mesh, video quality or framerate
										may degrade on congested connections (Recommended: ≤8
										viewers, ≤3 sharers).
									</span>
								</div>
								<span className="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[10px] text-amber-300">
									P2P Mesh
								</span>
							</div>
						)}
					{!identityLoading && roomCode && (
						<div
							data-stage-layer="shared-browser"
							aria-hidden={stageMode !== "shared-browser"}
							inert={stageMode !== "shared-browser" ? true : undefined}
							className={`absolute z-40 flex min-h-0 items-stretch justify-stretch ${compactRoomActive ? "inset-1" : "inset-2 sm:inset-4"} ${stageMode === "shared-browser" ? "visible pointer-events-auto" : "invisible pointer-events-none"}`}
						>
							<SharedBrowserPanel
								roomCode={roomCode}
								participantId={myUserId ?? ""}
								hostId={hostUserId ?? undefined}
								isHost={isHost}
								isActive={stageMode === "shared-browser"}
								participants={realViewers.map((viewer) => ({
									id: viewer.id,
									name: viewer.name,
								}))}
								annotationPermissions={{
									allowedUserIds: sharedBrowserAnnotationPermissions,
								}}
								annotationStrokes={sharedBrowserAnnotationStrokes}
								onAnnotationSubmit={sendSharedBrowserAnnotation}
								onAnnotationSubscribe={subscribeControllerMessages}
								onSessionChange={setSharedBrowserSessionId}
								onSetAnnotationPermission={setSharedBrowserAnnotationPermission}
								onControllerChanged={broadcastSharedBrowserControllerChanged}
								onViewerStateChange={setSharedBrowserViewerState}
								onFrameHandleChange={handleSharedBrowserFrameChange}
							/>
						</div>
					)}
					{joinError ? (
						<div className="relative flex aspect-video w-full max-w-5xl flex-col items-center justify-center rounded-xl border border-red-500/30 bg-slate-950 p-8 text-center shadow-2xl">
							<div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10 text-red-400">
								<Square className="h-8 w-8" />
							</div>
							<h3 className="mb-2 text-xl font-bold text-white">{joinError}</h3>
							<p className="mb-6 max-w-md text-xs leading-relaxed text-slate-400">
								Ask your host for a fresh invite link, or start your own session
								from a new room.
							</p>
							<button
								type="button"
								onClick={() => {
									setRoomCode("");
									setJoinError(null);
									hasJoinedRef.current = false;
								}}
								className="flex items-center gap-2 rounded-lg bg-sky-500 px-6 py-2.5 text-xs font-semibold text-white shadow-lg shadow-sky-500/25 transition hover:bg-sky-400"
							>
								<Plus className="h-4 w-4" />
								Start Fresh
							</button>
						</div>
					) : identityLoading ? (
						<div className="flex flex-col items-center justify-center gap-3 text-slate-400">
							<span className="h-2 w-2 animate-ping rounded-full bg-emerald-400" />
							<p className="text-xs font-medium">
								Connecting to session {roomCode}…
							</p>
						</div>
					) : stageMode === "shared-browser" ? null : stageMode ===
						"presentation" ? (
						/* Interactive In-Studio Presentation Stage (Pure Web, Zero Mismatch, No-EXE) */
						<div className="relative flex h-full w-full max-w-5xl flex-col mx-auto min-h-0 select-none animate-in fade-in zoom-in-95 duration-200">
							{/* Presentation Stage Container Card */}
							<div className="relative flex flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-slate-900/90 to-slate-950/95 shadow-2xl backdrop-blur-2xl">
								{/* Stage Header */}
								<div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-slate-900/80 px-5 py-3">
									<div className="flex items-center gap-3">
										<span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400 border border-sky-500/30">
											<Presentation className="h-4 w-4" />
										</span>
										<div>
											<h2 className="text-sm font-semibold text-white tracking-tight">
												{presentationSlide === 0
													? "Ollashare Screenshare Studio • Architecture Overview"
													: presentationSlide === 1
														? "Ultra-Low Latency Transport & Live Stream Health"
														: presentationSlide === 2
															? "Interactive Feature Decision Poll"
															: "Collaborative Action Plan & Live Notes"}
											</h2>
											<p className="text-[11px] text-slate-400">
												Slide {presentationSlide + 1} of 4 • Synchronized across
												all connected peers (Zero Mismatch)
											</p>
										</div>
									</div>

									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={() => handleChangeSlide(presentationSlide - 1)}
											disabled={presentationSlide === 0}
											className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
										>
											<ChevronLeft className="h-3.5 w-3.5" />
											Prev
										</button>
										<span className="font-mono text-xs text-sky-400 px-1 font-semibold">
											{presentationSlide + 1} / 4
										</span>
										<button
											type="button"
											onClick={() => handleChangeSlide(presentationSlide + 1)}
											disabled={presentationSlide === 3}
											className="flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/20 px-3 py-1.5 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
										>
											Next
											<ChevronRight className="h-3.5 w-3.5" />
										</button>
									</div>
								</div>

								{/* Slide Body */}
								<div className="relative flex flex-1 flex-col overflow-y-auto p-6 min-h-0">
									{presentationSlide === 0 && (
										<div className="flex flex-1 flex-col justify-center max-w-3xl mx-auto w-full space-y-6">
											<div className="text-center space-y-2">
												<span className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300">
													<Sparkles className="h-3.5 w-3.5 text-sky-400" /> Pure
													In-Browser Collaborative Presentation
												</span>
												<h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
													Ollashare Screenshare Studio
												</h1>
												<p className="text-sm text-slate-400 max-w-xl mx-auto">
													Ultra-low latency screen sharing with dual-mode WebRTC
													transport and in-studio interactive presentation
													stage.
												</p>
											</div>

											<div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
												<div className="rounded-xl border border-white/10 bg-slate-950/60 p-4 transition hover:border-sky-500/40 hover:bg-slate-900/60 shadow-lg">
													<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400 mb-3 border border-sky-500/30">
														<ScreenShare className="h-4 w-4" />
													</div>
													<h3 className="text-sm font-semibold text-white">
														Direct Peer Mesh
													</h3>
													<p className="text-xs text-slate-400 mt-1">
														P2P WebRTC with SCTP-throttled data channels for
														sub-25ms input delivery.
													</p>
												</div>

												<div className="rounded-xl border border-white/10 bg-slate-950/60 p-4 transition hover:border-indigo-500/40 hover:bg-slate-900/60 shadow-lg">
													<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400 mb-3 border border-indigo-500/30">
														<Activity className="h-4 w-4" />
													</div>
													<h3 className="text-sm font-semibold text-white">
														LiveKit SFU Route
													</h3>
													<p className="text-xs text-slate-400 mt-1">
														Scalable multi-party media routing with dynamic
														token issuance and admission control.
													</p>
												</div>

												<div className="rounded-xl border border-white/10 bg-slate-950/60 p-4 transition hover:border-emerald-500/40 hover:bg-slate-900/60 shadow-lg">
													<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400 mb-3 border border-emerald-500/30">
														<ShieldCheck className="h-4 w-4" />
													</div>
													<h3 className="text-sm font-semibold text-white">
														Convex Realtime
													</h3>
													<p className="text-xs text-slate-400 mt-1">
														Zero-polling reactive signals, room lifecycle
														watchdogs, and security audits.
													</p>
												</div>
											</div>

											<div className="flex items-center justify-center pt-4">
												<button
													type="button"
													onClick={() => handleChangeSlide(1)}
													className="flex items-center gap-2 rounded-xl border border-sky-400/40 bg-gradient-to-r from-sky-500 to-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg shadow-sky-500/25 transition hover:from-sky-400 hover:to-indigo-500 active:scale-95"
												>
													<span>Explore Live Stream Metrics</span>
													<ArrowRight className="h-3.5 w-3.5" />
												</button>
											</div>
										</div>
									)}

									{presentationSlide === 1 && (
										<div className="flex flex-1 flex-col justify-center max-w-3xl mx-auto w-full space-y-6">
											<div className="text-center space-y-1">
												<h2 className="text-xl font-bold text-white tracking-tight">
													WebRTC Media Pipeline & Quality Protection
												</h2>
												<p className="text-xs text-slate-400">
													Real-time stream parameters enforced across all
													participant peers.
												</p>
											</div>

											<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
												<div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-center shadow">
													<span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
														Resolution
													</span>
													<p className="text-base font-bold text-sky-400 mt-1 font-mono">
														1080p
													</p>
													<span className="text-[10px] text-emerald-400">
														maintain-resolution
													</span>
												</div>
												<div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-center shadow">
													<span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
														Target Bitrate
													</span>
													<p className="text-base font-bold text-sky-400 mt-1 font-mono">
														8.0 Mbps
													</p>
													<span className="text-[10px] text-emerald-400">
														Crisp Text Detail
													</span>
												</div>
												<div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-center shadow">
													<span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
														Input Latency
													</span>
													<p className="text-base font-bold text-emerald-400 mt-1 font-mono">
														&lt; 15 ms
													</p>
													<span className="text-[10px] text-slate-400">
														Direct DataChannel
													</span>
												</div>
												<div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-center shadow">
													<span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
														SCTP Queue
													</span>
													<p className="text-base font-bold text-emerald-400 mt-1 font-mono">
														0 KB
													</p>
													<span className="text-[10px] text-slate-400">
														Rate-Limited
													</span>
												</div>
											</div>

											<div className="rounded-xl border border-white/10 bg-slate-950/60 p-4 space-y-2">
												<div className="flex items-center justify-between text-xs font-semibold text-slate-200">
													<span>Real-Time Encoder Health</span>
													<span className="text-emerald-400 font-mono">
														OPTIMAL
													</span>
												</div>
												<div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
													<div className="h-full w-full bg-gradient-to-r from-sky-400 via-indigo-500 to-emerald-400 animate-pulse" />
												</div>
												<p className="text-[11px] text-slate-400">
													Screen capture tracks enforce{" "}
													<code className="text-sky-300">
														contentHint = "detail"
													</code>{" "}
													to eliminate blur and downscaling under packet
													fluctuations.
												</p>
											</div>

											<div className="flex items-center justify-between pt-2">
												<button
													type="button"
													onClick={() => handleChangeSlide(0)}
													className="flex items-center gap-1.5 text-xs font-medium text-slate-400 transition hover:text-white"
												>
													← Back to Overview
												</button>
												<button
													type="button"
													onClick={() => handleChangeSlide(2)}
													className="flex items-center gap-2 rounded-xl border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/30"
												>
													<span>Go to Live Decision Poll</span>
													<ArrowRight className="h-3.5 w-3.5" />
												</button>
											</div>
										</div>
									)}

									{presentationSlide === 2 && (
										<div className="flex flex-1 flex-col justify-center max-w-3xl mx-auto w-full space-y-6">
											<div className="text-center space-y-1">
												<span className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-300">
													<Vote className="h-3 w-3 text-sky-400" /> Interactive
													Collaboration
												</span>
												<h2 className="text-xl font-bold text-white tracking-tight">
													Live Peer Voting: Next Core Feature
												</h2>
												<p className="text-xs text-slate-400">
													Click any option below. Votes synchronize across Host
													and Guests instantaneously.
												</p>
											</div>

											{(() => {
												const total =
													(presentationVotes.A || 0) +
													(presentationVotes.B || 0) +
													(presentationVotes.C || 0);
												const pctA =
													total > 0
														? Math.round(
																((presentationVotes.A || 0) / total) * 100,
															)
														: 0;
												const pctB =
													total > 0
														? Math.round(
																((presentationVotes.B || 0) / total) * 100,
															)
														: 0;
												const pctC =
													total > 0
														? Math.round(
																((presentationVotes.C || 0) / total) * 100,
															)
														: 0;

												return (
													<div className="space-y-3">
														<button
															type="button"
															onClick={() => handleVoteOption("A")}
															className={`w-full rounded-xl border p-3.5 text-left transition relative overflow-hidden group ${
																userVoted === "A"
																	? "border-sky-400 bg-sky-500/20 shadow-lg shadow-sky-500/20"
																	: "border-white/10 bg-slate-950/60 hover:border-white/20 hover:bg-slate-900/60"
															}`}
														>
															<div
																className="absolute left-0 top-0 bottom-0 bg-sky-500/15 transition-all duration-500"
																style={{ width: `${pctA}%` }}
															/>
															<div className="relative flex items-center justify-between z-10">
																<div>
																	<span className="text-xs font-semibold text-white">
																		Option A: Cloud Session Recording & HLS
																		Streaming
																	</span>
																	<p className="text-[11px] text-slate-400">
																		Store and replay studio screen sessions with
																		full audio.
																	</p>
																</div>
																<span className="font-mono text-xs font-bold text-sky-400 ml-4 shrink-0">
																	{presentationVotes.A || 0} votes ({pctA}%)
																</span>
															</div>
														</button>

														<button
															type="button"
															onClick={() => handleVoteOption("B")}
															className={`w-full rounded-xl border p-3.5 text-left transition relative overflow-hidden group ${
																userVoted === "B"
																	? "border-indigo-400 bg-indigo-500/20 shadow-lg shadow-indigo-500/20"
																	: "border-white/10 bg-slate-950/60 hover:border-white/20 hover:bg-slate-900/60"
															}`}
														>
															<div
																className="absolute left-0 top-0 bottom-0 bg-indigo-500/15 transition-all duration-500"
																style={{ width: `${pctB}%` }}
															/>
															<div className="relative flex items-center justify-between z-10">
																<div>
																	<span className="text-xs font-semibold text-white">
																		Option B: Spatial Audio & Multi-Channel
																		Voice Mix
																	</span>
																	<p className="text-[11px] text-slate-400">
																		3D directional participant voice with noise
																		reduction.
																	</p>
																</div>
																<span className="font-mono text-xs font-bold text-indigo-400 ml-4 shrink-0">
																	{presentationVotes.B || 0} votes ({pctB}%)
																</span>
															</div>
														</button>

														<button
															type="button"
															onClick={() => handleVoteOption("C")}
															className={`w-full rounded-xl border p-3.5 text-left transition relative overflow-hidden group ${
																userVoted === "C"
																	? "border-emerald-400 bg-emerald-500/20 shadow-lg shadow-emerald-500/20"
																	: "border-white/10 bg-slate-950/60 hover:border-white/20 hover:bg-slate-900/60"
															}`}
														>
															<div
																className="absolute left-0 top-0 bottom-0 bg-emerald-500/15 transition-all duration-500"
																style={{ width: `${pctC}%` }}
															/>
															<div className="relative flex items-center justify-between z-10">
																<div>
																	<span className="text-xs font-semibold text-white">
																		Option C: AI Presentation Summarizer &
																		Real-Time Action Items
																	</span>
																	<p className="text-[11px] text-slate-400">
																		Automated meeting transcripts and action
																		checklists.
																	</p>
																</div>
																<span className="font-mono text-xs font-bold text-emerald-400 ml-4 shrink-0">
																	{presentationVotes.C || 0} votes ({pctC}%)
																</span>
															</div>
														</button>
													</div>
												);
											})()}

											<div className="flex items-center justify-between pt-2">
												<button
													type="button"
													onClick={() => handleChangeSlide(1)}
													className="flex items-center gap-1.5 text-xs font-medium text-slate-400 transition hover:text-white"
												>
													← Back to Stream Health
												</button>
												<button
													type="button"
													onClick={() => handleChangeSlide(3)}
													className="flex items-center gap-2 rounded-xl border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/30"
												>
													<span>Shared Collaborative Notes</span>
													<ArrowRight className="h-3.5 w-3.5" />
												</button>
											</div>
										</div>
									)}

									{presentationSlide === 3 && (
										<div className="flex flex-1 flex-col justify-center max-w-3xl mx-auto w-full space-y-4">
											<div className="text-center space-y-1">
												<span className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-300">
													<FileText className="h-3 w-3 text-sky-400" />{" "}
													Real-Time Shared Canvas
												</span>
												<h2 className="text-xl font-bold text-white tracking-tight">
													Session Notes & Action Plan
												</h2>
												<p className="text-xs text-slate-400">
													Type below or edit action items. Content synchronizes
													across all peers in the room.
												</p>
											</div>

											<div className="rounded-xl border border-white/10 bg-slate-950/80 p-4 shadow-xl">
												<textarea
													value={presentationNotes}
													onChange={(e) => handleUpdateNotes(e.target.value)}
													placeholder="Type shared session notes here..."
													rows={6}
													className="w-full rounded-lg border border-slate-800 bg-slate-900/90 p-3 font-mono text-xs text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/50 resize-none"
												/>
											</div>

											<div className="flex items-center justify-between pt-2">
												<button
													type="button"
													onClick={() => handleChangeSlide(0)}
													className="flex items-center gap-1.5 text-xs font-semibold text-sky-400 transition hover:text-sky-300"
												>
													↺ Restart from Beginning
												</button>

												<button
													type="button"
													onClick={() => handleToggleStageMode("screens")}
													className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 shadow"
												>
													<ScreenShare className="h-3.5 w-3.5 text-sky-400" />
													<span>Return to Screens Grid</span>
												</button>
											</div>
										</div>
									)}
								</div>

								{/* Stage Footer Bar */}
								<div className="flex shrink-0 items-center justify-between border-t border-white/10 bg-slate-900/80 px-5 py-2.5 text-xs">
									<div className="flex items-center gap-2 text-slate-400">
										<span className="relative flex h-2 w-2">
											<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
											<span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
										</span>
										<span className="font-medium text-slate-300">
											Interactive Web Stage Active
										</span>
										<span className="text-slate-500">•</span>
										<span>
											100% In-Browser Remote Collaboration (Zero Mismatch)
										</span>
									</div>

									<div className="flex items-center gap-2">
										<span className="text-[11px] font-mono text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 rounded">
											Room: {roomCode}
										</span>
									</div>
								</div>
							</div>
						</div>
					) : sharedDevices.length === 0 ? (
						realViewers.some((v) => v.isSharing && v.id !== myUserId) ? (
							<div className="relative flex aspect-video w-full max-w-5xl flex-col items-center justify-center rounded-xl border border-sky-500/30 bg-slate-950 p-8 text-center shadow-2xl">
								<div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-sky-500/20 bg-sky-500/10 text-sky-400">
									<span className="h-8 w-8 animate-spin rounded-full border-2 border-sky-400/20 border-t-sky-400" />
								</div>
								<h3 className="mb-2 text-xl font-bold text-white">
									Connecting Live Screen Share
								</h3>
								<p className="mb-6 max-w-md text-xs leading-relaxed text-slate-400">
									{realViewers
										.filter((v) => v.isSharing && v.id !== myUserId)
										.map((v) => v.name)
										.join(", ")}{" "}
									started sharing. Establishing secure WebRTC media stream…
								</p>
								<div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs text-emerald-400">
									<span className="h-2 w-2 animate-ping rounded-full bg-emerald-400" />
									<span>
										Stream negotiation in progress — ready to display live video
									</span>
								</div>
							</div>
						) : (
							<div className="relative flex h-full min-h-full w-full max-w-none flex-col items-center justify-center overflow-hidden rounded-none bg-white px-4 py-6 text-center shadow-[0_20px_55px_rgba(31,31,56,.10)] sm:rounded-[22px] sm:px-8 sm:py-8">
								{!roomCode && <SignupMesh />}
								<div
									className="relative z-10 mb-4 grid grid-cols-2 gap-[3px]"
									aria-hidden="true"
								>
									<i className="block h-7 w-7 rounded-[8px] bg-[#7659ef]" />
									<i className="block h-7 w-7 rounded-[8px] bg-[#a99dff]" />
									<i className="block h-7 w-7 rounded-[8px] bg-[#a99dff]" />
									<i className="block h-7 w-7 rounded-[8px] bg-[#7659ef]" />
								</div>
								{isHost ? (
									<>
										<h3 className="relative z-10 mb-2 text-2xl font-bold tracking-[-0.045em] text-[#08080b] sm:text-[30px] sm:leading-tight">
											{roomCode
												? "Share Your Screen"
												: frontpageTab === "host"
													? "Start a Screenshare Session"
													: "Join a Screenshare Session"}
										</h3>
										<p className="relative z-10 mb-7 max-w-2xl text-sm leading-relaxed text-[#666b77] sm:text-[15px]">
											{roomCode
												? "Broadcast your desktop or window. Guests joining via your invite link can also share their screens."
												: frontpageTab === "host"
													? "Launch a high-performance session as host, or switch to join an existing session via invite link."
													: "Enter or paste the invite link or room code provided by the session host to connect immediately."}
										</p>

										{!roomCode && (
											<div className="relative z-10 mb-7 grid w-full max-w-xl grid-cols-2 gap-1.5 rounded-2xl bg-[#f0f1f5] p-1.5">
												<button
													type="button"
													onClick={() => setFrontpageTab("host")}
													className={`flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition ${
														frontpageTab === "host"
															? "bg-[#7659ef] text-white shadow-[0_8px_22px_rgba(118,89,239,.28)]"
															: "text-[#5f6470] hover:bg-white hover:text-[#08080b]"
													}`}
												>
													<Plus className="h-3.5 w-3.5" />
													Host Session
												</button>
												<button
													type="button"
													onClick={() => setFrontpageTab("join")}
													className={`flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition ${
														frontpageTab === "join"
															? "bg-[#7659ef] text-white shadow-[0_8px_22px_rgba(118,89,239,.28)]"
															: "text-[#5f6470] hover:bg-white hover:text-[#08080b]"
													}`}
												>
													<Link2 className="h-3.5 w-3.5" />
													Join via Invite Link
												</button>
											</div>
										)}

										{roomCode ? (
											<button
												type="button"
												onClick={startBroadcast}
												disabled={isLiveKitConnecting}
												className={`flex min-h-11 w-full max-w-xs items-center justify-center gap-2 rounded-lg bg-sky-500 px-5 py-3 text-xs font-semibold text-white shadow-lg shadow-sky-500/25 transition hover:bg-sky-400 sm:w-auto sm:px-6 sm:py-2.5 ${
													isLiveKitConnecting
														? "cursor-not-allowed opacity-60"
														: ""
												}`}
											>
												{isLiveKitConnecting ? (
													<>
														<span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
														Connecting to LiveKit…
													</>
												) : (
													<>
														<ScreenShare className="h-4 w-4" />
														Select Screen to Share
													</>
												)}
											</button>
										) : frontpageTab === "host" ? (
											<div className="relative z-10 w-full max-w-xl rounded-[20px] bg-[#fafaff] p-5 text-left sm:p-7">
												<label className="mb-1.5 block text-xs font-semibold text-[#30323a]">
													Host Display Name
												</label>
												<input
													type="text"
													value={hostNameInput}
													onChange={(e) =>
														setHostNameInput(e.target.value.slice(0, 50))
													}
													placeholder="e.g. Alex (Host)"
													maxLength={50}
													onKeyDown={(e) => {
														if (e.key === "Enter") {
															e.preventDefault();
															handleCreateRoom();
														}
													}}
													className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-white outline-none transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
												/>
												<button
													type="button"
													onClick={handleCreateRoom}
													disabled={creatingRoom}
													className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#0a0a0d] px-4 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#292931] disabled:opacity-60 active:scale-98"
												>
													<Plus className="h-4 w-4" />
													{creatingRoom
														? "Creating Room…"
														: "Start Session as Host"}
												</button>
												<div className="mt-3.5 border-t border-slate-800/80 pt-2.5 text-center">
													<button
														type="button"
														onClick={() => setFrontpageTab("join")}
														className="inline-flex items-center gap-1.5 text-[11px] font-medium text-sky-400 transition hover:text-sky-300"
													>
														<Link2 className="h-3 w-3" />
														Have an invite link? Join session →
													</button>
												</div>
											</div>
										) : (
											<div className="relative z-10 w-full max-w-xl rounded-[20px] bg-[#fafaff] p-5 text-left sm:p-7">
												<div className="space-y-3">
													<div>
														<label className="mb-1.5 block text-xs font-semibold text-[#30323a]">
															Guest Invite Link
														</label>
														<input
															type="text"
															value={inviteLinkInput}
															onChange={(e) =>
																setInviteLinkInput(e.target.value)
															}
															placeholder="Paste the complete guest invite link"
															onKeyDown={(e) => {
																if (e.key === "Enter") {
																	e.preventDefault();
																	handleJoinByInviteLink();
																}
															}}
															className="h-11 w-full rounded-xl border-0 bg-[#f0f1f5] px-3.5 text-xs text-[#111116] outline-none transition placeholder:text-[#878b96] focus:bg-white focus:ring-2 focus:ring-[#7659ef]"
														/>
													</div>
													<div>
														<label className="mb-1.5 block text-xs font-semibold text-[#30323a]">
															Your Display Name{" "}
															<span className="text-slate-500 font-normal">
																(optional)
															</span>
														</label>
														<input
															type="text"
															value={guestJoinNameInput}
															onChange={(e) =>
																setGuestJoinNameInput(
																	e.target.value.slice(0, 50),
																)
															}
															placeholder={customName || myName || "e.g. Maya"}
															maxLength={50}
															onKeyDown={(e) => {
																if (e.key === "Enter") {
																	e.preventDefault();
																	handleJoinByInviteLink();
																}
															}}
															className="h-11 w-full rounded-xl border-0 bg-[#f0f1f5] px-3.5 text-xs text-[#111116] outline-none transition placeholder:text-[#878b96] focus:bg-white focus:ring-2 focus:ring-[#7659ef]"
														/>
													</div>
													<button
														type="button"
														onClick={() => handleJoinByInviteLink()}
														className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#0a0a0d] px-4 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#292931] active:scale-98"
													>
														<ArrowRight className="h-4 w-4" />
														Join Host Session
													</button>
													<div className="mt-3.5 border-t border-slate-800/80 pt-2.5 text-center">
														<button
															type="button"
															onClick={() => setFrontpageTab("host")}
															className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400 transition hover:text-white"
														>
															← Start your own session as host
														</button>
													</div>
												</div>
											</div>
										)}
									</>
								) : (
									<>
										<h3 className="mb-2 text-xl font-bold text-white">
											Multi-Device Screen Share Stage
										</h3>
										<p
											className="mb-6 max-w-md text-xs leading-relaxed text-slate-400"
											suppressHydrationWarning
										>
											Connected as{" "}
											<strong className="font-semibold text-sky-300">
												{guestName ?? myName}
											</strong>
											{roomCode && (
												<>
													{" "}
													to room{" "}
													<strong className="font-mono text-sky-400">
														{roomCode}
													</strong>
												</>
											)}
											. Standing by for the host or guests to share their
											screens.
										</p>
										<div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3.5 py-1.5 text-xs text-slate-400">
											<span className="h-2 w-2 animate-ping rounded-full bg-emerald-400" />
											<span>Listening for active screen broadcasts…</span>
										</div>
									</>
								)}
							</div>
						)
					) : zoomedDevice ? (
						/* Studio Zoom Mode: Focused screen large + thumbnail strip */
						<div className="flex h-full w-full max-w-6xl min-h-0 flex-col gap-3 mx-auto">
							<div className="relative min-h-0 flex-1 flex flex-col overflow-hidden rounded-xl border border-sky-500/30 bg-slate-950 shadow-2xl">
								{/* Top Info Bar: Just Above Screen Tab */}
								<div className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900/95 px-4 py-2 text-xs">
									<div className="flex min-w-0 items-center gap-2">
										<ScreenShare className="h-4 w-4 text-sky-400 shrink-0" />
										<span className="font-semibold text-slate-100">
											{zoomedDevice.deviceName}
										</span>
										<span className="font-mono text-xs text-slate-400">
											({zoomedDevice.ownerName})
										</span>
										{zoomedDevice.stream && (
											<span className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[9px] font-medium text-emerald-400">
												<span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
												LIVE
											</span>
										)}
										<span className="flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 font-sans text-[11px] text-sky-300">
											<ZoomIn className="h-3 w-3" /> Zoom Mode
										</span>
									</div>

									<div className="flex items-center gap-2 shrink-0">
										{zoomedDevice.ownerId === myUserId && (
											<button
												type="button"
												onClick={
													zoomedDevice.isHost
														? stopBroadcast
														: stopGuestScreenshare
												}
												{...{ [MIRA_REMOTE_GUARD_ATTR]: "true" }}
												className="flex items-center gap-1 rounded border border-red-500/40 bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:bg-red-500/25"
												title="Stop this screen share"
											>
												<Square className="h-3 w-3 fill-current" />
												Stop Share
											</button>
										)}
										{isHost && zoomedDevice.ownerId !== myUserId && (
											<>
												<button
													type="button"
													onClick={() =>
														setAnnotationDeviceId((current) =>
															current === zoomedDevice.id
																? null
																: zoomedDevice.id,
														)
													}
													className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition shadow-sm ${
														annotationDeviceId === zoomedDevice.id
															? "border-amber-400/60 bg-amber-500/25 text-amber-100"
															: "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
													}`}
													title="Draw annotations over this shared screen"
												>
													<Pencil className="h-3 w-3" />
													<span>
														{annotationDeviceId === zoomedDevice.id
															? "Drawing"
															: "Draw"}
													</span>
												</button>
												{(annotationStrokes[zoomedDevice.id]?.length ?? 0) >
													0 && (
													<button
														type="button"
														onClick={() =>
															handleClearAnnotations(zoomedDevice.id, "all")
														}
														className="flex items-center gap-1.5 rounded-full border border-slate-600 bg-slate-800/80 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:bg-slate-700"
														title="Clear all annotations"
													>
														<Trash2 className="h-3 w-3" />
														<span>Clear all</span>
													</button>
												)}
												{remoteControlTargetId === zoomedDevice.id &&
												remoteControlStatus === "active" ? (
													<button
														type="button"
														onClick={() =>
															handleReleaseRemoteControl(
																zoomedDevice.id,
																zoomedDevice.ownerId,
															)
														}
														className="flex items-center gap-1.5 rounded-full border border-sky-400/50 bg-sky-500/20 px-3 py-1 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/30 animate-pulse shadow-sm"
														title="Click to release remote control"
													>
														<MousePointer className="h-3 w-3 text-sky-400" />
														<span>Release Control</span>
													</button>
												) : remoteControlTargetId === zoomedDevice.id &&
													remoteControlStatus === "requesting" ? (
													<button
														type="button"
														disabled
														className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-300 opacity-90 shadow-sm"
													>
														<span className="h-2 w-2 rounded-full bg-amber-400 animate-ping mr-1" />
														<span>Requesting…</span>
													</button>
												) : (
													<button
														type="button"
														onClick={() =>
															handleRequestRemoteControl(zoomedDevice)
														}
														className="flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-300 transition hover:border-sky-400/50 hover:bg-sky-500/20 hover:text-white shadow-sm"
														title={`Request remote mouse & keyboard control of ${zoomedDevice.ownerName || "guest"}'s screen`}
													>
														<MousePointer className="h-3 w-3" />
														<span>Remote Control</span>
													</button>
												)}
												<button
													type="button"
													onClick={() =>
														handleKickParticipant(
															zoomedDevice.ownerId,
															zoomedDevice.ownerName,
														)
													}
													className="flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:bg-red-500/20"
													title={`Kick ${zoomedDevice.ownerName || "participant"} from session`}
												>
													<UserMinus className="h-3 w-3" />
													Kick
												</button>
											</>
										)}
										{canDrawAnnotations && (
											<ScreenAnnotationToolbar
												deviceId={zoomedDevice.id}
												activeDeviceId={annotationDeviceId}
												color={annotationColor}
												width={annotationWidth}
												tool={annotationTool}
												canClear={
													annotationStrokes[zoomedDevice.id]?.some(
														(stroke) => isHost || stroke.authorId === myUserId,
													) ?? false
												}
												clearLabel={
													isHost
														? "Clear all annotations"
														: "Clear my annotations"
												}
												onToggle={() =>
													setAnnotationDeviceId((current) =>
														current === zoomedDevice.id
															? null
															: zoomedDevice.id,
													)
												}
												onColorChange={setAnnotationColor}
												onWidthChange={setAnnotationWidth}
												onToolChange={setAnnotationTool}
												onClear={() =>
													handleClearAnnotations(
														zoomedDevice.id,
														isHost ? "all" : "own",
													)
												}
											/>
										)}
									</div>
								</div>

								{/* Clean Video Area */}
								<div
									className="relative min-h-0 flex-1 cursor-pointer bg-black flex items-center justify-center overflow-hidden"
									// Suppress zoom-exit while remote-controlling this screen: a host
									// double-click is remote input, not a local navigation gesture.
									onDoubleClick={
										remoteControlTargetId === zoomedDevice.id
											? undefined
											: () => setZoomedDeviceId(null)
									}
									title={
										remoteControlTargetId === zoomedDevice.id
											? undefined
											: "Double-click to return to all screens"
									}
								>
									<DeviceVideoPlayer
										device={zoomedDevice}
										isOwner={zoomedDevice.ownerId === myUserId}
										annotationEnabled={
											canDrawAnnotations &&
											annotationDeviceId === zoomedDevice.id
										}
										annotationCanEraseAll={isHost}
										annotationStrokes={annotationStrokes[zoomedDevice.id] ?? []}
										onAnnotationStroke={(stroke) =>
											handleAnnotationStroke(zoomedDevice.id, stroke)
										}
										onAnnotationErase={(strokeId) =>
											handleAnnotationErase(zoomedDevice.id, strokeId)
										}
										annotationAuthor={{ id: myUserId ?? "", name: displayName }}
										annotationColor={annotationColor}
										annotationWidth={annotationWidth}
										annotationTool={annotationTool}
										isRemoteControlled={
											remoteControlTargetId === zoomedDevice.id &&
											remoteControlStatus === "active"
										}
										onSendInput={(input) =>
											handleSendRemoteInput(
												zoomedDevice.ownerId,
												zoomedDevice.id,
												input,
											)
										}
										onReleaseControl={() =>
											handleReleaseRemoteControl(
												zoomedDevice.id,
												zoomedDevice.ownerId,
											)
										}
										onStopStream={
											zoomedDevice.ownerId === myUserId
												? zoomedDevice.isHost
													? stopBroadcast
													: stopGuestScreenshare
												: undefined
										}
									/>
								</div>

								{/* Bottom Presenter bar: Just Below Screen Tab */}
								<div className="flex shrink-0 items-center justify-between border-t border-slate-800 bg-slate-900/95 px-4 py-2.5">
									<div className="flex items-center gap-2.5">
										<span
											className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
												zoomedDevice.isHost
													? "bg-gradient-to-br from-sky-500 to-indigo-600"
													: "bg-gradient-to-br from-emerald-400 to-teal-600"
											}`}
										>
											{(zoomedDevice.ownerName || "?").charAt(0).toUpperCase()}
										</span>
										<span className="text-sm font-semibold text-slate-100">
											{zoomedDevice.ownerName || "Unknown"}
										</span>
										{zoomedDevice.isHost && (
											<span className="rounded border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[9px] text-sky-400">
												HOST
											</span>
										)}
										<span className="font-mono text-xs text-slate-400">
											• {zoomedDevice.resolution || "1080p"} (
											{zoomedDevice.fps || 60}fps)
										</span>
									</div>
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={() => setZoomedDeviceId(null)}
											className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
										>
											<LayoutGrid className="h-3.5 w-3.5" />
											All Screens ({sharedDevices.length})
										</button>
									</div>
								</div>
							</div>

							{/* Filmstrip thumbnails if multiple screens */}
							{sharedDevices.length > 1 && (
								<div className="flex shrink-0 items-center gap-2.5 overflow-x-auto py-1 px-1">
									<span className="text-[11px] font-medium text-slate-400 shrink-0 mr-1">
										Screens:
									</span>
									{sharedDevices.map((device) => {
										const isSelected = device.id === zoomedDevice.id;
										return (
											<button
												key={device.id}
												type="button"
												onClick={() => setZoomedDeviceId(device.id)}
												className={`relative flex h-20 w-36 shrink-0 flex-col overflow-hidden rounded-lg border text-left transition ${
													isSelected
														? "border-sky-500 ring-2 ring-sky-500/50 bg-slate-900"
														: "border-slate-800 bg-slate-950 opacity-75 hover:border-slate-600 hover:opacity-100"
												}`}
											>
												<div className="relative min-h-0 flex-1 pointer-events-none">
													<DeviceVideoPlayer device={device} isOwner={false} />
												</div>
												<div className="flex shrink-0 items-center justify-between border-t border-slate-800/80 bg-slate-900/90 px-2 py-1 text-[10px]">
													<span className="truncate font-semibold text-slate-200">
														{device.ownerName}
													</span>
													{device.stream && (
														<span className="text-[9px] font-mono text-emerald-400">
															LIVE
														</span>
													)}
												</div>
											</button>
										);
									})}
								</div>
							)}
						</div>
					) : (
						/* Studio Multi-Screen Grid */
						<div
							className={`grid w-full gap-5 items-center justify-center ${
								sharedDevices.length === 1
									? "grid-cols-1 max-w-4xl mx-auto"
									: sharedDevices.length === 2
										? "grid-cols-1 md:grid-cols-2 max-w-6xl mx-auto"
										: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 max-w-7xl mx-auto"
							}`}
						>
							{sharedDevices.map((device) => (
								<div
									key={device.id}
									className="group flex w-full flex-col overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950 shadow-2xl transition hover:border-slate-700"
								>
									{/* Top Info Bar: Just Above Screen Tab */}
									<div className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900/95 px-3.5 py-2 text-xs">
										<div className="flex min-w-0 items-center gap-2">
											<ScreenShare className="h-3.5 w-3.5 text-sky-400 shrink-0" />
											<span className="truncate font-semibold text-slate-100">
												{device.deviceName}
											</span>
											<span className="shrink-0 font-mono text-[11px] text-slate-400">
												({device.ownerName})
											</span>
											{(device.stream || device.liveKitTrack) && (
												<span className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[9px] font-medium text-emerald-400">
													<span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
													LIVE
												</span>
											)}
										</div>

										<div className="flex items-center gap-1.5 shrink-0">
											{device.ownerId === myUserId && (
												<button
													type="button"
													onClick={
														device.isHost ? stopBroadcast : stopGuestScreenshare
													}
													{...{ [MIRA_REMOTE_GUARD_ATTR]: "true" }}
													className="flex items-center gap-1 rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/25"
													title="Stop this screen share"
												>
													<Square className="h-2.5 w-2.5 fill-current" />
													Stop Share
												</button>
											)}
											{canDrawAnnotations && (
												<ScreenAnnotationToolbar
													deviceId={device.id}
													activeDeviceId={annotationDeviceId}
													color={annotationColor}
													width={annotationWidth}
													tool={annotationTool}
													canClear={
														annotationStrokes[device.id]?.some(
															(stroke) =>
																isHost || stroke.authorId === myUserId,
														) ?? false
													}
													clearLabel={
														isHost
															? "Clear all annotations"
															: "Clear my annotations"
													}
													compact
													onToggle={() =>
														setAnnotationDeviceId((current) =>
															current === device.id ? null : device.id,
														)
													}
													onColorChange={setAnnotationColor}
													onWidthChange={setAnnotationWidth}
													onToolChange={setAnnotationTool}
													onClear={() =>
														handleClearAnnotations(
															device.id,
															isHost ? "all" : "own",
														)
													}
												/>
											)}
											{isHost && device.ownerId !== myUserId && (
												<>
													{remoteControlTargetId === device.id &&
													remoteControlStatus === "active" ? (
														<button
															type="button"
															onClick={() =>
																handleReleaseRemoteControl(
																	device.id,
																	device.ownerId,
																)
															}
															className="flex items-center gap-1 rounded border border-sky-400/50 bg-sky-500/20 px-2 py-0.5 text-[10px] font-semibold text-sky-200 transition hover:bg-sky-500/30 animate-pulse shadow-sm"
															title="Click to release remote control"
														>
															<MousePointer className="h-2.5 w-2.5 text-sky-400" />
															Release
														</button>
													) : remoteControlTargetId === device.id &&
														remoteControlStatus === "requesting" ? (
														<button
															type="button"
															disabled
															className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300 opacity-90"
														>
															<span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-ping mr-0.5" />
															Requesting…
														</button>
													) : (
														<button
															type="button"
															onClick={() => handleRequestRemoteControl(device)}
															className="flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-300 transition hover:border-sky-400/50 hover:bg-sky-500/20 hover:text-white"
															title={`Request remote mouse & keyboard control of ${device.ownerName || "guest"}'s screen`}
														>
															<MousePointer className="h-2.5 w-2.5" />
															Control
														</button>
													)}
													<button
														type="button"
														onClick={() =>
															handleKickParticipant(
																device.ownerId,
																device.ownerName,
															)
														}
														className="flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/20"
														title={`Kick ${device.ownerName || "participant"} from session`}
													>
														<UserMinus className="h-2.5 w-2.5" />
														Kick
													</button>
												</>
											)}
										</div>
									</div>

									{/* Screen Tab Video Area */}
									<div
										className="relative aspect-video w-full cursor-pointer overflow-hidden bg-black flex items-center justify-center"
										onDoubleClick={
											remoteControlTargetId === device.id
												? undefined
												: () => setZoomedDeviceId(device.id)
										}
										title={
											remoteControlTargetId === device.id
												? undefined
												: "Double-click to focus this screen"
										}
									>
										<DeviceVideoPlayer
											device={device}
											isOwner={device.ownerId === myUserId}
											annotationEnabled={
												canDrawAnnotations && annotationDeviceId === device.id
											}
											annotationCanEraseAll={isHost}
											annotationStrokes={annotationStrokes[device.id] ?? []}
											onAnnotationStroke={(stroke) =>
												handleAnnotationStroke(device.id, stroke)
											}
											onAnnotationErase={(strokeId) =>
												handleAnnotationErase(device.id, strokeId)
											}
											annotationAuthor={{
												id: myUserId ?? "",
												name: displayName,
											}}
											annotationColor={annotationColor}
											annotationWidth={annotationWidth}
											annotationTool={annotationTool}
											isRemoteControlled={
												remoteControlTargetId === device.id &&
												remoteControlStatus === "active"
											}
											onSendInput={(input) =>
												handleSendRemoteInput(device.ownerId, device.id, input)
											}
											onReleaseControl={() =>
												handleReleaseRemoteControl(device.id, device.ownerId)
											}
											onStopStream={
												device.ownerId === myUserId
													? device.isHost
														? stopBroadcast
														: stopGuestScreenshare
													: undefined
											}
										/>
										{/* Hover quick-zoom action — suppressed while this tile is under remote
                        control: this overlay is a SIBLING of DeviceVideoPlayer, so a
                        pointer-events-auto focus pill under the cursor would swallow every
                        mousedown/mouseup the host sends and they would never reach the
                        player's input handlers (cursor moves would still work mid-flight,
                        clicks at tile center would silently do nothing). */}
										{remoteControlTargetId !== device.id && (
											<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:opacity-100">
												<button
													type="button"
													aria-label={`Focus ${device.ownerName || "shared"} screen`}
													className="pointer-events-auto flex min-h-11 items-center gap-1.5 rounded-lg border border-sky-400/40 bg-slate-900/90 px-3 py-2 text-xs font-medium text-sky-300 shadow-xl backdrop-blur-md transition hover:bg-sky-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 motion-reduce:transition-none"
													onClick={(e) => {
														e.stopPropagation();
														setZoomedDeviceId(device.id);
													}}
												>
													<ZoomIn className="h-3.5 w-3.5" />
													Focus / Zoom Screen
												</button>
											</div>
										)}
									</div>

									{/* Bottom Info Bar: Just Below Screen Tab */}
									<div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-800 bg-slate-900/95 px-3.5 py-2 text-xs">
										<div className="flex min-w-0 items-center gap-2">
											<span
												className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
													device.isHost
														? "bg-gradient-to-br from-sky-500 to-indigo-600"
														: "bg-gradient-to-br from-emerald-400 to-teal-600"
												}`}
											>
												{(device.ownerName || "?").charAt(0).toUpperCase()}
											</span>
											<span className="truncate font-semibold text-slate-200">
												{device.ownerName || "Unknown"}
											</span>
											{device.isHost && (
												<span className="rounded border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[9px] text-sky-400">
													HOST
												</span>
											)}
											<span className="font-mono text-[10px] text-slate-400">
												• {device.resolution || "1080p"} ({device.fps || 60}fps)
											</span>
										</div>

										<div className="flex items-center gap-1.5 shrink-0">
											<button
												type="button"
												onClick={() => setZoomedDeviceId(device.id)}
												className="flex min-h-11 items-center gap-1 rounded border border-slate-700 bg-slate-800/80 px-3 py-2 text-[11px] font-medium text-slate-300 transition hover:border-sky-500/50 hover:bg-sky-500/20 hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 motion-reduce:transition-none"
												title="Focus this screen in Zoom Mode"
											>
												<ZoomIn className="h-3 w-3" />
												<span>Focus</span>
											</button>
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				{/* Right Rail (Spacious Apple Frosted Glass Drawer) */}
				{!compactRoomActive && (
					<div className="flex max-h-[44dvh] min-h-[280px] w-full shrink-0 flex-col overflow-hidden border-t border-[#dedee5] bg-white lg:max-h-none lg:min-h-0 lg:w-[380px] lg:border-l lg:border-t-0">
						{/* Apple Segmented Control - Spacious & Uncongested */}
						<div className="shrink-0 border-b border-[#dedee5] bg-[#fbfbfd] p-3.5">
							<div className="flex items-center gap-1 rounded-xl bg-[#f0f1f5] p-1">
								<button
									type="button"
									disabled={!isChatViable}
									onClick={() => {
										if (!isChatViable) return;
										setSidebarTab("chat");
										setUnreadCount(0);
									}}
									className={`relative flex-1 py-2 px-2.5 text-xs font-semibold rounded-xl transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
										!isChatViable
											? "opacity-50 cursor-not-allowed text-slate-500 hover:text-slate-500"
											: sidebarTab === "chat"
												? "bg-[#ece9ff] text-[#5d42d6]"
												: "text-[#666b77] hover:bg-white hover:text-[#08080b]"
									}`}
									title={
										!isChatViable
											? "Join the session to access room chat"
											: "Room Chat"
									}
								>
									{!isChatViable ? (
										<Lock className="h-3.5 w-3.5 shrink-0 text-slate-500" />
									) : (
										<MessageSquare className="h-3.5 w-3.5 shrink-0" />
									)}
									<span>Chat</span>
									{isChatViable && unreadCount > 0 && sidebarTab !== "chat" && (
										<span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-white shadow-sm animate-pulse">
											{unreadCount}
										</span>
									)}
								</button>

								<button
									type="button"
									onClick={() => setSidebarTab("viewers")}
									className={`relative flex-1 py-2 px-2.5 text-xs font-semibold rounded-xl transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
										sidebarTab === "viewers"
											? "bg-white/15 text-white shadow-md backdrop-blur-xl border border-white/15"
											: "text-slate-400 hover:text-slate-200 hover:bg-white/5"
									}`}
								>
									<Users className="h-3.5 w-3.5 shrink-0" />
									<span>Viewers</span>
									<span className="rounded-full bg-white/10 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-slate-300">
										{realViewers.length}
									</span>
								</button>

								<button
									type="button"
									onClick={() => setSidebarTab("settings")}
									className={`relative flex-1 py-2 px-2.5 text-xs font-semibold rounded-xl transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
										sidebarTab === "settings"
											? "bg-white/15 text-white shadow-md backdrop-blur-xl border border-white/15"
											: "text-slate-400 hover:text-slate-200 hover:bg-white/5"
									}`}
								>
									<Sliders className="h-3.5 w-3.5 shrink-0" />
									<span>Settings</span>
								</button>
							</div>
						</div>

						<div className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
							{sidebarTab === "chat" ? (
								!isChatViable ? (
									/* Apple Frosted Glass Locked Chat State */
									<div className="flex flex-1 flex-col items-center justify-center bg-[#fafaff] p-8 text-center">
										<div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#ece9ff] text-[#5d42d6]">
											<Lock className="h-6 w-6" />
										</div>
										<h4 className="text-sm font-semibold text-[#08080b]">
											Chat Locked
										</h4>
										<p className="mt-2 max-w-[220px] text-xs leading-relaxed text-[#666b77]">
											Live in-room chat becomes available once you join the
											session with your display name.
										</p>
										<div className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#ece9ff] px-3 py-1 text-[10px] font-semibold text-[#5d42d6]">
											<span>Join session to unlock</span>
										</div>
									</div>
								) : (
									/* Apple iMessage Real-Time Chat View */
									<div className="flex flex-1 flex-col h-full min-h-0 overflow-hidden">
										<div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-4 py-2 shrink-0">
											<div className="flex items-center gap-2">
												<span className="relative flex h-2 w-2">
													<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
													<span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
												</span>
												<span className="text-[11px] font-medium text-slate-300">
													Live Room Chat
												</span>
											</div>
											<span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-0.5 font-mono text-[10px] text-slate-400">
												{realViewers.length} online
											</span>
										</div>

										{/* Message stream */}
										<div
											ref={chatScrollRef}
											className="flex-1 overflow-y-auto p-4 space-y-3.5 scroll-smooth"
										>
											{messages.length === 0 ? (
												<div className="flex h-full flex-col items-center justify-center p-6 text-center">
													<div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-500/10 text-sky-400 shadow-lg shadow-sky-500/10">
														<MessageSquare className="h-7 w-7" />
													</div>
													<h4 className="text-sm font-semibold text-white">
														No Messages Yet
													</h4>
													<p className="mt-1.5 max-w-[200px] text-xs leading-relaxed text-slate-400">
														Say hello! Messages are delivered peer-to-peer
														across the room with zero lag.
													</p>
												</div>
											) : (
												messages.map((msg) => {
													if (msg.isSystem) {
														return (
															<div
																key={msg.id}
																className="flex justify-center my-2"
															>
																<span className="rounded-full border border-white/5 bg-white/5 px-3 py-0.5 font-mono text-[10px] text-slate-400">
																	{msg.text}
																</span>
															</div>
														);
													}
													const isMe =
														msg.senderId === myUserId ||
														msg.senderName === displayName;
													return (
														<div
															key={msg.id}
															className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}
														>
															{!isMe && (
																<div className="mb-1 flex items-center gap-1.5 px-1.5">
																	<span className="text-[11px] font-semibold text-slate-300">
																		{msg.senderName}
																	</span>
																	{msg.senderRole === "host" && (
																		<span className="rounded-full border border-sky-400/30 bg-sky-500/20 px-1.5 py-0.2 font-mono text-[9px] font-semibold text-sky-300">
																			Host
																		</span>
																	)}
																</div>
															)}

															<div
																className={`max-w-[85%] px-3.5 py-2 text-xs leading-relaxed break-words shadow-md transition-all ${
																	isMe
																		? "rounded-2xl rounded-br-xs bg-gradient-to-br from-blue-600 via-sky-600 to-sky-500 text-white font-normal shadow-sky-500/15"
																		: "rounded-2xl rounded-bl-xs bg-slate-800/90 text-slate-100 border border-white/10 backdrop-blur-xl"
																}`}
															>
																{msg.text}
															</div>

															<span className="mt-0.5 px-1.5 text-[9px] font-mono text-slate-400">
																{formatChatTime(msg.timestamp)}
															</span>
														</div>
													);
												})
											)}
											<div ref={chatBottomRef} />
										</div>

										{/* Apple Message Input Capsule */}
										<form
											onSubmit={handleSendMessage}
											className="border-t border-white/10 bg-slate-950/70 p-3 backdrop-blur-2xl shrink-0"
										>
											<div className="flex items-center gap-2 rounded-full border border-white/15 bg-slate-900/90 px-3.5 py-1.5 shadow-inner focus-within:border-sky-400/60 focus-within:ring-2 focus-within:ring-sky-400/20 transition-all">
												<input
													type="text"
													value={chatInput}
													onChange={(e) => setChatInput(e.target.value)}
													onKeyDown={(e) => {
														if (e.key === "Enter" && !e.shiftKey) {
															e.preventDefault();
															handleSendMessage();
														}
													}}
													placeholder="iMessage to room..."
													maxLength={1000}
													className="flex-1 bg-transparent text-xs text-white placeholder:text-slate-400 focus:outline-none"
												/>
												<button
													type="button"
													onClick={() => handleSendMessage()}
													disabled={!chatInput.trim()}
													className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all ${
														chatInput.trim()
															? "bg-sky-500 text-white shadow-md shadow-sky-500/30 hover:bg-sky-400 active:scale-90 cursor-pointer"
															: "bg-white/10 text-slate-400 cursor-not-allowed"
													}`}
													title="Send Message (Enter)"
												>
													<ArrowUp className="h-4 w-4 stroke-[2.5]" />
												</button>
											</div>
										</form>
									</div>
								)
							) : sidebarTab === "settings" ? (
								<div className="flex-1 space-y-6 overflow-y-auto p-5 sm:p-6 text-xs">
									<>
										{isHost && roomCode && showInviteManager && (
											<RoomInviteManager roomCode={roomCode} />
										)}

										{/* Live-change honesty banner while broadcasting */}
										{isHost && isBroadcasting && (
											<div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-[11px] leading-relaxed text-amber-200/90 shadow-sm backdrop-blur-md">
												<div className="flex items-center gap-2 mb-1.5 font-semibold text-amber-300">
													<AlertTriangle className="h-4 w-4 shrink-0" />
													<span>Live Stream Quality Notice</span>
												</div>
												<p>
													<strong className="text-amber-300">
														Live adjustments:
													</strong>{" "}
													Bitrate and frame rate adapt instantaneously to
													current viewers.
												</p>
												<p className="mt-1">
													<strong className="text-amber-300">
														Next stream:
													</strong>{" "}
													Resolution and codec changes take effect upon
													restarting screen sharing.
												</p>
											</div>
										)}

										{/* Video Codec */}
										<div className="space-y-2.5">
											<div className="flex items-center justify-between">
												<div>
													<label className="text-xs font-semibold text-slate-200 tracking-wide block">
														Video Codec
													</label>
													<p className="text-[11px] text-slate-400 font-normal">
														Hardware video compression pipeline
													</p>
												</div>
												{!isHost && (
													<span className="rounded-full border border-slate-700 bg-slate-800/80 px-2.5 py-0.5 text-[10px] font-medium text-slate-400">
														Host Only
													</span>
												)}
											</div>
											<div className="grid grid-cols-3 gap-2 rounded-2xl bg-slate-950/70 p-1.5 border border-white/10 backdrop-blur-md shadow-inner">
												{(["H.264", "VP9", "AV1"] as const).map((codec) => (
													<button
														type="button"
														key={codec}
														disabled={!isHost}
														onClick={() => handleConfigChange({ codec })}
														className={`rounded-xl py-2.5 text-center font-mono text-xs font-semibold transition-all ${
															config.codec === codec
																? "bg-sky-500/20 border border-sky-400/40 text-sky-300 shadow-sm"
																: "border border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/5"
														} ${!isHost ? "cursor-not-allowed opacity-60" : "cursor-pointer active:scale-95"}`}
													>
														{codec}
													</button>
												))}
											</div>
										</div>

										{/* Resolution */}
										<div className="space-y-2.5">
											<div className="flex items-center justify-between">
												<div>
													<label className="text-xs font-semibold text-slate-200 tracking-wide block">
														Resolution
													</label>
													<p className="text-[11px] text-slate-400 font-normal">
														Display canvas dimensions and detail
													</p>
												</div>
												{!isHost && (
													<span className="rounded-full border border-slate-700 bg-slate-800/80 px-2.5 py-0.5 text-[10px] font-medium text-slate-400">
														Host Only
													</span>
												)}
											</div>
											<div className="relative">
												<select
													id="quality-resolution-select"
													disabled={!isHost}
													value={config.resolution}
													onChange={(e) =>
														isHost &&
														handleConfigChange({
															resolution: e.target
																.value as StreamQualityConfig["resolution"],
														})
													}
													className={`w-full appearance-none rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-xs font-medium text-slate-100 shadow-inner backdrop-blur-md hover:border-white/20 focus:border-sky-400/60 focus:ring-2 focus:ring-sky-400/20 focus:outline-none transition-all ${
														!isHost
															? "cursor-not-allowed opacity-60"
															: "cursor-pointer"
													}`}
												>
													<option value="1080p">
														1080p Full HD (1920 x 1080) — Recommended
													</option>
													<option value="720p">
														720p HD (1280 x 720) — High Performance
													</option>
													<option value="360p">
														360p (640 x 360) — Low Bandwidth
													</option>
												</select>
												<ChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
											</div>
											<p className="text-[11px] text-emerald-300">
												LiveKit subscribers adapt across 360p, 720p, and 1080p
												layers.
											</p>
										</div>

										{/* FPS */}
										<div className="space-y-2.5">
											<div className="flex items-center justify-between">
												<div>
													<label className="text-xs font-semibold text-slate-200 tracking-wide block">
														Frame Rate
													</label>
													<p className="text-[11px] text-slate-400 font-normal">
														Target motion smoothness
													</p>
												</div>
												{!isHost && (
													<span className="rounded-full border border-slate-700 bg-slate-800/80 px-2.5 py-0.5 text-[10px] font-medium text-slate-400">
														Host Only
													</span>
												)}
											</div>
											<div className="relative">
												<select
													id="quality-fps-select"
													disabled={!isHost}
													value={String(config.fps)}
													onChange={(e) =>
														isHost &&
														handleConfigChange({
															fps: Number(e.target.value) as ReadableMediaFps,
														})
													}
													className={`w-full appearance-none rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-xs font-medium text-slate-100 shadow-inner backdrop-blur-md hover:border-white/20 focus:border-sky-400/60 focus:ring-2 focus:ring-sky-400/20 focus:outline-none transition-all ${
														!isHost
															? "cursor-not-allowed opacity-60"
															: "cursor-pointer"
													}`}
												>
													<option value="25">25 FPS — Efficient Motion</option>
													<option value="30">30 FPS — Standard Motion</option>
													<option value="60">
														60 FPS — High Fluidity (Recommended)
													</option>
													{config.fps === 120 && (
														<option value="120" disabled>
															120 FPS — Legacy room value
														</option>
													)}
												</select>
												<ChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
											</div>
										</div>

										{/* Bitrate */}
										<div className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/40 p-4 backdrop-blur-md shadow-sm">
											<div className="flex items-center justify-between">
												<div>
													<label className="text-xs font-semibold text-slate-200 tracking-wide block">
														Target Bitrate
													</label>
													<p className="text-[11px] text-slate-400 font-normal">
														Bandwidth allocated for streaming
													</p>
												</div>
												<span className="rounded-full border border-sky-400/30 bg-sky-500/15 px-3 py-1 font-mono text-xs font-bold text-sky-400 shadow-sm">
													{(config.bitrateKbps / 1000).toFixed(1)} Mbps
												</span>
											</div>
											<div className="pt-2">
												<input
													type="range"
													disabled={!isHost}
													min="400"
													max="25000"
													step="1000"
													value={config.bitrateKbps}
													onChange={(e) =>
														isHost &&
														handleConfigChange({
															bitrateKbps: Number(e.target.value),
														})
													}
													className={`w-full h-2 rounded-lg bg-slate-800 accent-sky-500 ${!isHost ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
												/>
												<div className="mt-2.5 flex items-center justify-between font-mono text-[10px] text-slate-400">
													<span>2.0 Mbps (Low)</span>
													<span>12.5 Mbps</span>
													<span>25.0 Mbps (Ultra)</span>
												</div>
											</div>
										</div>
									</>
								</div>
							) : (
								<div className="flex-1 space-y-5 overflow-y-auto p-5 sm:p-6 text-xs">
									<div className="space-y-4">
										<div className="flex items-center justify-between pt-1">
											<div>
												<h4 className="text-xs font-semibold text-slate-200 tracking-wide">
													Connected Viewers
												</h4>
												<p className="text-[11px] text-slate-400">
													Active participants in this session
												</p>
											</div>
											<span className="rounded-full border border-sky-400/30 bg-sky-500/15 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-sky-400 shadow-sm">
												{realViewers.length} live
											</span>
										</div>

										{isHost &&
											realViewers.some(
												(viewer) =>
													viewer.role !== "host" && viewer.id !== myUserId,
											) && (
												<section
													aria-labelledby="drawing-permissions-heading"
													className="rounded-2xl border border-amber-400/20 bg-amber-500/5 p-3.5"
												>
													<div className="flex flex-wrap items-center justify-between gap-2">
														<div>
															<h5
																id="drawing-permissions-heading"
																className="text-xs font-semibold text-amber-100"
															>
																Drawing permissions
															</h5>
															<p className="mt-0.5 text-[11px] text-slate-400">
																Allow guests to annotate any active shared
																screen. Changes apply immediately.
															</p>
														</div>
														<div className="flex max-w-full flex-wrap items-center gap-2">
															{realViewers
																.filter(
																	(viewer) =>
																		viewer.role !== "host" &&
																		viewer.id !== myUserId,
																)
																.map((viewer) => {
																	const allowed =
																		screenAnnotationPermissions.has(viewer.id);
																	return (
																		<button
																			key={`drawing-permission-${viewer.id}`}
																			type="button"
																			aria-pressed={allowed}
																			onClick={() =>
																				void handleSetAnnotationPermission(
																					viewer.id,
																					!allowed,
																				)
																			}
																			className={`min-h-11 rounded-lg border px-3 py-2 text-xs font-semibold transition ${allowed ? "border-amber-400/40 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30" : "border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700"}`}
																		>
																			{allowed
																				? `Revoke ${viewer.name}`
																				: `Allow ${viewer.name}`}
																		</button>
																	);
																})}
														</div>
													</div>
												</section>
											)}

										{realViewers.length === 0 ? (
											<div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8 text-center backdrop-blur-md">
												<div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-slate-400">
													<Users className="h-6 w-6" />
												</div>
												<p className="text-xs font-semibold text-slate-200">
													No guests connected yet
												</p>
												<p className="mt-1.5 text-[11px] leading-relaxed text-slate-400 max-w-[220px] mx-auto">
													{isHost
														? "Share your room invite code with peers to join this live broadcast."
														: "You are connected as a viewer in this room."}
												</p>
											</div>
										) : (
											realViewers.map((viewer) => {
												const isSharing = Boolean(
													viewer.isSharing ||
														sharedDevices.some((d) => d.ownerId === viewer.id),
												);
												const isMe = viewer.id === myUserId;
												const isThisViewerHost = viewer.role === "host";
												return (
													<div
														key={viewer.id}
														className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/70 p-3.5 shadow-sm backdrop-blur-md hover:border-white/20 transition-all"
													>
														<div className="flex items-center gap-2.5 min-w-0">
															<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-800 text-slate-300 font-semibold text-[11px] border border-white/10">
																{viewer.name.charAt(0).toUpperCase()}
															</div>
															<div className="min-w-0">
																<div className="flex items-center gap-1.5">
																	<span className="truncate font-semibold text-slate-200 text-xs">
																		{viewer.name}
																	</span>
																	{isMe && (
																		<span className="text-[10px] text-slate-400 font-normal">
																			(You)
																		</span>
																	)}
																</div>
																<div className="flex items-center gap-1.5 mt-0.5">
																	{isThisViewerHost && (
																		<span className="rounded-full border border-sky-400/30 bg-sky-500/20 px-1.5 py-0.2 font-mono text-[9px] font-semibold text-sky-300">
																			Host
																		</span>
																	)}
																	{screenAnnotationPermissions.has(viewer.id) &&
																		!isThisViewerHost && (
																			<span className="rounded-full border border-amber-400/30 bg-amber-500/15 px-1.5 py-0.2 font-mono text-[9px] font-semibold text-amber-200">
																				Can draw
																			</span>
																		)}
																	{isSharing ? (
																		<span className="flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/20 px-2 py-0.2 font-mono text-[9px] font-semibold text-emerald-300">
																			<span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
																			Sharing
																		</span>
																	) : (
																		<span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.2 font-mono text-[9px] text-slate-400">
																			Viewing
																		</span>
																	)}
																</div>
															</div>
														</div>

														{/* Host can control or kick non-host participants */}
														{isHost &&
															!isThisViewerHost &&
															viewer.id !== myUserId && (
																<div className={PARTICIPANT_ACTION_ROW_CLASS}>
																	<button
																		type="button"
																		onClick={() =>
																			void handleSetAnnotationPermission(
																				viewer.id,
																				!screenAnnotationPermissions.has(
																					viewer.id,
																				),
																			)
																		}
																		className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold transition ${
																			screenAnnotationPermissions.has(viewer.id)
																				? "border-amber-400/40 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30"
																				: "border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700"
																		}`}
																		title={
																			screenAnnotationPermissions.has(viewer.id)
																				? `Revoke drawing from ${viewer.name}`
																				: `Allow ${viewer.name} to draw`
																		}
																	>
																		<Pencil className="h-2.5 w-2.5" />
																		{screenAnnotationPermissions.has(viewer.id)
																			? "Revoke draw"
																			: "Allow draw"}
																	</button>
																	{isSharing &&
																		(() => {
																			const matchingDevice = sharedDevices.find(
																				(d) => d.ownerId === viewer.id,
																			);
																			if (!matchingDevice) return null;
																			const isControlled =
																				remoteControlTargetId ===
																					matchingDevice.id &&
																				remoteControlStatus === "active";
																			const isReq =
																				remoteControlTargetId ===
																					matchingDevice.id &&
																				remoteControlStatus === "requesting";
																			if (isControlled) {
																				return (
																					<button
																						type="button"
																						onClick={() =>
																							handleReleaseRemoteControl(
																								matchingDevice.id,
																								viewer.id,
																							)
																						}
																						className="flex items-center gap-1 rounded-full border border-sky-400/50 bg-sky-500/20 px-2 py-1 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/30 transition animate-pulse"
																						title="Release control"
																					>
																						<MousePointer className="h-2.5 w-2.5" />
																						Release
																					</button>
																				);
																			}
																			if (isReq) {
																				return (
																					<button
																						type="button"
																						disabled
																						className="flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-300 opacity-90"
																					>
																						<span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-ping mr-0.5" />
																						Wait
																					</button>
																				);
																			}
																			return (
																				<button
																					type="button"
																					onClick={() =>
																						handleRequestRemoteControl(
																							matchingDevice,
																						)
																					}
																					className="flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] font-semibold text-sky-300 hover:bg-sky-500/20 hover:text-white transition"
																					title="Request remote control"
																				>
																					<MousePointer className="h-2.5 w-2.5" />
																					Control
																				</button>
																			);
																		})()}
																	<button
																		type="button"
																		onClick={() =>
																			handleKickParticipant(
																				viewer.id,
																				viewer.name,
																			)
																		}
																		className="flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/20 active:scale-95 shadow-sm"
																		title="Remove participant from session"
																	>
																		<UserMinus className="h-3 w-3" />
																		Kick
																	</button>
																</div>
															)}
													</div>
												);
											})
										)}
									</div>
								</div>
							)}
						</div>
					</div>
				)}
			</div>

			{compactRoomActive && (
				<>
					<MobileRoomControlDock
						isSharing={isBroadcasting || isGuestSharing}
						shareDisabled={identityLoading || isLiveKitConnecting || !roomCode}
						activeSheet={mobileSheet}
						sheetId={mobileSheetId}
						participantCount={realViewers.length}
						unreadCount={unreadCount}
						onToggleShare={toggleOwnScreenShare}
						onOpenSheet={handleOpenMobileSheet}
					/>
					<MobileRoomSheet
						id={mobileSheetId}
						open={mobileSheet !== null}
						title={mobileSheetTitle}
						orientation={mobileLayout.orientation}
						viewportHeight={mobileLayout.viewportHeight}
						viewportOffsetTop={mobileLayout.viewportOffsetTop}
						viewportOffsetLeft={mobileLayout.viewportOffsetLeft}
						isKeyboardOpen={mobileLayout.isKeyboardOpen}
						onClose={() => setMobileSheet(null)}
					>
						{mobileSheet === "participants" ? (
							<RoomParticipantList
								participants={realViewers.map((viewer) => {
									const matchingDevice = sharedDevices.find(
										(device) => device.ownerId === viewer.id,
									);
									return {
										...viewer,
										isSharing: Boolean(viewer.isSharing || matchingDevice),
										canAnnotate: screenAnnotationPermissions.has(viewer.id),
										controlStatus:
											matchingDevice &&
											remoteControlTargetId === matchingDevice.id
												? remoteControlStatus
												: "idle",
									};
								})}
								currentParticipantId={myUserId}
								isHost={isHost}
								onToggleAnnotation={(participantId, allowed) =>
									void handleSetAnnotationPermission(participantId, allowed)
								}
								onRequestControl={(participantId) => {
									const device = sharedDevices.find(
										(candidate) => candidate.ownerId === participantId,
									);
									if (device) handleRequestRemoteControl(device);
								}}
								onReleaseControl={(participantId) => {
									const device = sharedDevices.find(
										(candidate) => candidate.ownerId === participantId,
									);
									if (device)
										handleReleaseRemoteControl(device.id, participantId);
								}}
								onKick={handleKickParticipant}
							/>
						) : mobileSheet === "chat" ? (
							<div className="flex min-h-[18rem] flex-col gap-3">
								<div
									role="log"
									aria-live="polite"
									className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-2xl bg-slate-950 p-3 text-white"
								>
									{messages.length === 0 ? (
										<p className="py-8 text-center text-sm text-slate-400">
											No messages yet.
										</p>
									) : (
										messages.map((message) => (
											<div
												key={message.id}
												className={`flex flex-col ${message.senderId === myUserId ? "items-end" : "items-start"}`}
											>
												<span className="mb-1 text-[11px] text-slate-400">
													{message.senderName} ·{" "}
													{formatChatTime(message.timestamp)}
												</span>
												<p className="max-w-[90%] rounded-2xl bg-slate-800 px-3 py-2 text-xs leading-relaxed">
													{message.text}
												</p>
											</div>
										))
									)}
								</div>
								<form
									onSubmit={handleSendMessage}
									className="sticky bottom-0 flex items-center gap-2 bg-white pb-[max(0.25rem,env(safe-area-inset-bottom))]"
								>
									<label htmlFor="mobile-room-chat-input" className="sr-only">
										Message the room
									</label>
									<input
										id="mobile-room-chat-input"
										value={chatInput}
										onChange={(event) => setChatInput(event.target.value)}
										maxLength={1000}
										placeholder="Message the room"
										className="min-h-11 min-w-0 flex-1 rounded-xl border border-[#dedee5] px-3 text-sm outline-none focus:border-[#7659ef] focus:ring-2 focus:ring-[#7659ef]/20"
									/>
									<button
										type="submit"
										disabled={!chatInput.trim()}
										aria-label="Send message"
										className="flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-[#7659ef] text-white disabled:opacity-45"
									>
										<Send className="h-5 w-5" />
									</button>
								</form>
							</div>
						) : mobileSheet === "screens" ? (
							<div className="space-y-3">
								<div className="grid grid-cols-3 gap-2">
									{(["screens", "presentation", "shared-browser"] as const).map(
										(mode) => (
											<button
												key={mode}
												type="button"
												aria-pressed={stageMode === mode}
												onClick={() => {
													handleToggleStageMode(mode);
													setMobileSheet(null);
												}}
												className={`min-h-11 rounded-xl px-2 py-2 text-xs font-semibold ${stageMode === mode ? "bg-[#7659ef] text-white" : "bg-[#f0f1f5] text-[#4e535f]"}`}
											>
												{mode === "screens"
													? "Screens"
													: mode === "presentation"
														? "Present"
														: "Browser"}
											</button>
										),
									)}
								</div>
								<button
									type="button"
									onClick={() => {
										enterTheater();
										setMobileSheet(null);
									}}
									disabled={sharedDevices.length === 0}
									className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 text-sm font-semibold text-sky-800 disabled:opacity-45"
								>
									<Maximize2 className="h-4 w-4" /> Full View
								</button>
								{sharedDevices.length === 0 ? (
									<p className="rounded-xl bg-[#f0f1f5] p-4 text-center text-sm text-[#666b77]">
										No active screens.
									</p>
								) : (
									sharedDevices.map((device) => (
										<button
											key={device.id}
											type="button"
											onClick={() => {
												setZoomedDeviceId(device.id);
												handleToggleStageMode("screens");
												setMobileSheet(null);
											}}
											className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-[#dedee5] bg-white px-3 py-2 text-left"
										>
											<span className="min-w-0">
												<span className="block truncate text-sm font-semibold">
													{device.ownerName}
												</span>
												<span className="block truncate text-xs text-[#666b77]">
													{device.deviceName}
												</span>
											</span>
											<span className="shrink-0 text-xs font-semibold text-[#5d42d6]">
												Focus
											</span>
										</button>
									))
								)}
							</div>
						) : (
							<div className="space-y-4">
								{isHost && roomCode && (
									<div
										className="grid grid-cols-2 gap-2"
										role="tablist"
										aria-label="More room controls"
									>
										<button
											type="button"
											role="tab"
											aria-selected={mobileMoreTab === "settings"}
											onClick={() => setMobileMoreTab("settings")}
											className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${mobileMoreTab === "settings" ? "bg-[#7659ef] text-white" : "bg-[#f0f1f5] text-[#4e535f]"}`}
										>
											Settings
										</button>
										<button
											type="button"
											role="tab"
											aria-selected={mobileMoreTab === "invitations"}
											onClick={() => setMobileMoreTab("invitations")}
											className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${mobileMoreTab === "invitations" ? "bg-[#7659ef] text-white" : "bg-[#f0f1f5] text-[#4e535f]"}`}
										>
											Invitations
										</button>
									</div>
								)}
								{mobileMoreTab === "invitations" && isHost && roomCode ? (
									<RoomInviteManager roomCode={roomCode} />
								) : (
									<div className="space-y-3">
										<label className="block text-xs font-semibold text-[#30323a]">
											Resolution
											<select
												value={config.resolution}
												disabled={!isHost}
												onChange={(event) =>
													handleConfigChange({
														resolution: event.target
															.value as StreamQualityConfig["resolution"],
													})
												}
												className="mt-1 min-h-11 w-full rounded-xl border border-[#dedee5] bg-white px-3 text-sm disabled:bg-[#f0f1f5]"
											>
												<option value="1080p">1080p</option>
												<option value="720p">720p</option>
												<option value="360p">360p</option>
											</select>
										</label>
										<label className="block text-xs font-semibold text-[#30323a]">
											Frame rate
											<select
												value={String(config.fps)}
												disabled={!isHost}
												onChange={(event) =>
													handleConfigChange({
														fps: Number(event.target.value) as ReadableMediaFps,
													})
												}
												className="mt-1 min-h-11 w-full rounded-xl border border-[#dedee5] bg-white px-3 text-sm disabled:bg-[#f0f1f5]"
											>
												<option value="25">25 FPS</option>
												<option value="30">30 FPS</option>
												<option value="60">60 FPS</option>
												{config.fps === 120 && (
													<option value="120" disabled>
														120 FPS (Legacy)
													</option>
												)}
											</select>
										</label>
										<button
											type="button"
											onClick={() => {
												enterTheater();
												setMobileSheet(null);
											}}
											disabled={sharedDevices.length === 0}
											className="min-h-11 w-full rounded-xl bg-slate-950 px-3 text-sm font-semibold text-white disabled:opacity-45"
										>
											Open Full View
										</button>
										{isHost && roomCode && (
											<button
												type="button"
												onClick={handleEndRoom}
												className="min-h-11 w-full rounded-xl border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700"
											>
												End room
											</button>
										)}
									</div>
								)}
							</div>
						)}
					</MobileRoomSheet>
				</>
			)}

			{/* ---- FULL VIEW MODE (PORTALED TO BODY: NO SIDEBARS, FULL WINDOW) ---- */}
			{mounted &&
				theaterMode &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						ref={theaterRef}
						className="fixed inset-0 z-[99999] flex h-[100dvh] w-screen flex-col overflow-hidden bg-slate-950 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-slate-100 select-none"
					>
						{/* When Remote Control is Active: Edge-to-Edge True Fullscreen Stage */}
						{isHost &&
						remoteControlStatus === "active" &&
						Boolean(
							zoomedDevice ||
								(remoteControlTargetId
									? sharedDevices.find((d) => d.id === remoteControlTargetId)
									: null) ||
								sharedDevices[0],
						) ? (
							(() => {
								const activeDevice =
									zoomedDevice ||
									(remoteControlTargetId
										? sharedDevices.find((d) => d.id === remoteControlTargetId)
										: null) ||
									sharedDevices[0];
								if (!activeDevice) return null;
								const interaction = getFullViewInteractionState({
									mode: fullViewInteractionMode,
									remoteControlActive: true,
									annotationAllowed: canDrawAnnotations,
									annotationSelected: annotationDeviceId === activeDevice.id,
								});
								return (
									<div className="relative h-full w-full flex-1 bg-black overflow-hidden flex items-center justify-center select-none">
										{/* Floating Non-Intrusive Remote Control HUD */}
										<div
											{...{ [MIRA_REMOTE_GUARD_ATTR]: "true" }}
											className={`absolute left-1/2 top-3 z-50 max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-xl border border-sky-400/40 bg-slate-900/90 px-2 py-1.5 shadow-2xl backdrop-blur-xl animate-in fade-in transition-opacity hover:opacity-100 opacity-95 select-none ${FULL_VIEW_CONTROL_ROW_CLASS}`}
											onPointerDown={(e) => e.stopPropagation()}
											onPointerUp={(e) => e.stopPropagation()}
											onClick={(e) => e.stopPropagation()}
											onWheel={(e) => e.stopPropagation()}
										>
											<span className="relative flex h-2.5 w-2.5">
												<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
												<span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
											</span>
											<span className="whitespace-nowrap text-xs font-semibold text-white">
												{fullViewInteractionMode === "control"
													? "Controlling"
													: "Drawing on"}{" "}
												{activeDevice.ownerName}
											</span>
											<div
												className="flex shrink-0 rounded-lg border border-slate-700 bg-slate-950/80 p-0.5"
												role="group"
												aria-label="Full View interaction mode"
											>
												<button
													type="button"
													aria-pressed={fullViewInteractionMode === "draw"}
													disabled={!canDrawAnnotations}
													onClick={() => {
														setAnnotationDeviceId(activeDevice.id);
														setFullViewInteractionMode("draw");
													}}
													className={`min-h-11 rounded-md px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${fullViewInteractionMode === "draw" ? "bg-amber-500/25 text-amber-100" : "text-slate-300 hover:bg-slate-800"}`}
												>
													Draw
												</button>
												<button
													type="button"
													aria-pressed={fullViewInteractionMode === "control"}
													onClick={() => setFullViewInteractionMode("control")}
													className={`min-h-11 rounded-md px-3 text-xs font-semibold transition ${fullViewInteractionMode === "control" ? "bg-sky-500/25 text-sky-100" : "text-slate-300 hover:bg-slate-800"}`}
												>
													Control
												</button>
											</div>
											{fullViewInteractionMode === "draw" &&
												canDrawAnnotations && (
													<ScreenAnnotationToolbar
														deviceId={activeDevice.id}
														activeDeviceId={annotationDeviceId}
														color={annotationColor}
														width={annotationWidth}
														tool={annotationTool}
														canClear={
															annotationStrokes[activeDevice.id]?.some(
																(stroke) =>
																	isHost || stroke.authorId === myUserId,
															) ?? false
														}
														clearLabel={
															isHost
																? "Clear all annotations"
																: "Clear my annotations"
														}
														compact
														onToggle={() =>
															setAnnotationDeviceId((current) =>
																current === activeDevice.id
																	? null
																	: activeDevice.id,
															)
														}
														onColorChange={setAnnotationColor}
														onWidthChange={setAnnotationWidth}
														onToolChange={setAnnotationTool}
														onClear={() =>
															handleClearAnnotations(
																activeDevice.id,
																isHost ? "all" : "own",
															)
														}
													/>
												)}
											<span className="hidden whitespace-nowrap text-[10px] text-slate-400 font-mono sm:inline">
												(Esc releases control)
											</span>
											<button
												type="button"
												onClick={() =>
													handleReleaseRemoteControl(
														activeDevice.id,
														activeDevice.ownerId,
													)
												}
												className="rounded-lg border border-red-500/40 bg-red-500/20 px-2.5 py-1 text-xs font-bold text-red-300 hover:bg-red-500/40 transition active:scale-95"
											>
												Release Control
											</button>
											<button
												type="button"
												onClick={toggleNativeFullscreen}
												className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition active:scale-95"
												title="Toggle edge-to-edge browser fullscreen"
											>
												{isFullscreen ? "Window" : "Full Screen"}
											</button>
										</div>

										{/* Video Player takes 100% of viewport with ZERO padding or squashing */}
										<div className="absolute inset-0 h-full w-full">
											<DeviceVideoPlayer
												device={activeDevice}
												isOwner={activeDevice.ownerId === myUserId}
												annotationEnabled={interaction.annotationEnabled}
												annotationCanEraseAll={isHost}
												annotationStrokes={
													annotationStrokes[activeDevice.id] ?? []
												}
												onAnnotationStroke={(stroke) =>
													handleAnnotationStroke(activeDevice.id, stroke)
												}
												onAnnotationErase={(strokeId) =>
													handleAnnotationErase(activeDevice.id, strokeId)
												}
												annotationAuthor={{
													id: myUserId ?? "",
													name: displayName,
												}}
												annotationColor={annotationColor}
												annotationWidth={annotationWidth}
												annotationTool={annotationTool}
												isRemoteControlled={interaction.remoteInputEnabled}
												onSendInput={(input) =>
													handleSendRemoteInput(
														activeDevice.ownerId,
														activeDevice.id,
														input,
													)
												}
												onReleaseControl={() =>
													handleReleaseRemoteControl(
														activeDevice.id,
														activeDevice.ownerId,
													)
												}
												onStopStream={
													activeDevice.ownerId === myUserId
														? activeDevice.isHost
															? stopBroadcast
															: stopGuestScreenshare
														: undefined
												}
											/>
										</div>
									</div>
								);
							})()
						) : (
							<>
								{/* Top Control Bar */}
								<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/95 px-3 py-2 backdrop-blur-md sm:px-4 sm:py-2.5">
									<div className="flex min-w-0 items-center gap-3 overflow-x-auto touch-pan-x">
										<span className="rounded-lg border border-slate-700/80 bg-slate-950 px-2.5 py-1 font-mono text-xs text-sky-400">
											{roomCode}
										</span>
										<span className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-400">
											<span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
											{sharedDevices.length} screen
											{sharedDevices.length === 1 ? "" : "s"} live
										</span>
										{zoomedDevice && (
											<span className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/15 px-2.5 py-1 font-sans text-xs text-sky-300">
												<ZoomIn className="h-3.5 w-3.5" />
												Focusing: {zoomedDevice.ownerName} (
												{zoomedDevice.deviceName})
											</span>
										)}
									</div>

									<div className={FULL_VIEW_CONTROL_ROW_CLASS}>
										{sharedDevices.length > 1 && (
											<button
												type="button"
												onClick={() =>
													setZoomedDeviceId((prev) =>
														prev ? null : sharedDevices[0]?.id ?? null,
													)
												}
												className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
												title="Toggle between Multi-Grid and Focused Zoom mode"
											>
												{zoomedDeviceId ? (
													<>
														<LayoutGrid className="h-3.5 w-3.5" />
														Show All Screens
													</>
												) : (
													<>
														<ZoomIn className="h-3.5 w-3.5" />
														Focus Mode
													</>
												)}
											</button>
										)}

										{canDrawAnnotations && zoomedDevice && (
											<ScreenAnnotationToolbar
												deviceId={zoomedDevice.id}
												activeDeviceId={annotationDeviceId}
												color={annotationColor}
												width={annotationWidth}
												tool={annotationTool}
												canClear={
													annotationStrokes[zoomedDevice.id]?.some(
														(stroke) => isHost || stroke.authorId === myUserId,
													) ?? false
												}
												clearLabel={
													isHost
														? "Clear all annotations"
														: "Clear my annotations"
												}
												onToggle={() =>
													setAnnotationDeviceId((current) =>
														current === zoomedDevice.id
															? null
															: zoomedDevice.id,
													)
												}
												onColorChange={setAnnotationColor}
												onWidthChange={setAnnotationWidth}
												onToolChange={setAnnotationTool}
												onClear={() =>
													handleClearAnnotations(
														zoomedDevice.id,
														isHost ? "all" : "own",
													)
												}
											/>
										)}

										{isHost && zoomedDevice && !zoomedDevice.isHost && (
											<>
												{remoteControlTargetId === zoomedDevice.id &&
												remoteControlStatus === "active" ? (
													<button
														type="button"
														onClick={() =>
															handleReleaseRemoteControl(
																zoomedDevice.id,
																zoomedDevice.ownerId,
															)
														}
														className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-200 shadow-sm transition hover:bg-red-500/30"
														title="Release remote control"
													>
														<Square className="h-3.5 w-3.5 fill-current text-red-400" />
														<span>Release Control</span>
													</button>
												) : (
													<button
														type="button"
														onClick={() =>
															handleRequestRemoteControl(zoomedDevice)
														}
														disabled={remoteControlStatus === "requesting"}
														className="flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/20 px-3 py-1.5 text-xs font-semibold text-sky-200 shadow-sm transition hover:bg-sky-500/30 active:scale-95 disabled:opacity-50"
														title="Request remote control"
													>
														<MousePointer className="h-3.5 w-3.5 text-sky-400" />
														<span>
															{remoteControlStatus === "requesting"
																? "Requesting..."
																: "Control Screen"}
														</span>
													</button>
												)}
											</>
										)}

										{isHost
											? isBroadcasting && (
													<button
														type="button"
														onClick={stopBroadcast}
														{...{ [MIRA_REMOTE_GUARD_ATTR]: "true" }}
														className="flex items-center gap-1.5 rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-400"
													>
														<Square className="h-3.5 w-3.5 fill-current" />
														Stop Screen
													</button>
												)
											: isGuestSharing && (
													<button
														type="button"
														onClick={stopGuestScreenshare}
														className="flex items-center gap-1.5 rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-400"
													>
														<Square className="h-3.5 w-3.5 fill-current" />
														Stop My Screen
													</button>
												)}

										<button
											type="button"
											onClick={toggleNativeFullscreen}
											className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
											title="Toggle browser edge-to-edge fullscreen"
										>
											{isFullscreen ? (
												<>
													<Minimize className="h-3.5 w-3.5" />
													<span className="hidden sm:inline">Window</span>
												</>
											) : (
												<>
													<Maximize className="h-3.5 w-3.5" />
													<span className="hidden sm:inline">Fullscreen</span>
												</>
											)}
										</button>

										<button
											type="button"
											onClick={exitTheater}
											className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg shadow-sky-500/25 transition hover:bg-sky-400"
											title="Exit Full View (Esc)"
										>
											<Minimize2 className="h-3.5 w-3.5" />
											Exit Full View
										</button>
									</div>
								</div>

								{/* Full View Content Stage */}
								<div className="flex flex-1 flex-col overflow-hidden p-3 min-h-0 bg-black">
									{zoomedDevice ? (
										/* Full View Focused Zoom Mode */
										<div className="flex h-full w-full min-h-0 flex-1 flex-col gap-3">
											<div className="relative min-h-0 flex-1 flex flex-col overflow-hidden rounded-xl border border-sky-500/30 bg-slate-950 shadow-2xl">
												<div
													className="relative min-h-0 flex-1 cursor-pointer"
													onDoubleClick={
														remoteControlTargetId === zoomedDevice.id
															? undefined
															: () => setZoomedDeviceId(null)
													}
													title={
														remoteControlTargetId === zoomedDevice.id
															? undefined
															: "Double-click to return to all screens"
													}
												>
													<DeviceVideoPlayer
														device={zoomedDevice}
														isOwner={zoomedDevice.ownerId === myUserId}
														annotationEnabled={
															canDrawAnnotations &&
															annotationDeviceId === zoomedDevice.id
														}
														annotationCanEraseAll={isHost}
														annotationStrokes={
															annotationStrokes[zoomedDevice.id] ?? []
														}
														onAnnotationStroke={(stroke) =>
															handleAnnotationStroke(zoomedDevice.id, stroke)
														}
														onAnnotationErase={(strokeId) =>
															handleAnnotationErase(zoomedDevice.id, strokeId)
														}
														annotationAuthor={{
															id: myUserId ?? "",
															name: displayName,
														}}
														annotationColor={annotationColor}
														annotationWidth={annotationWidth}
														annotationTool={annotationTool}
														isRemoteControlled={
															remoteControlTargetId === zoomedDevice.id &&
															remoteControlStatus === "active"
														}
														onSendInput={(input) =>
															handleSendRemoteInput(
																zoomedDevice.ownerId,
																zoomedDevice.id,
																input,
															)
														}
														onReleaseControl={() =>
															handleReleaseRemoteControl(
																zoomedDevice.id,
																zoomedDevice.ownerId,
															)
														}
														onStopStream={
															zoomedDevice.ownerId === myUserId
																? zoomedDevice.isHost
																	? stopBroadcast
																	: stopGuestScreenshare
																: undefined
														}
													/>
												</div>
												{/* Presenter name bar */}
												<div className="flex shrink-0 items-center justify-between border-t border-slate-800 bg-slate-900/95 px-4 py-2.5">
													<div className="flex items-center gap-2.5">
														<span
															className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
																zoomedDevice.isHost
																	? "bg-gradient-to-br from-sky-500 to-indigo-600"
																	: "bg-gradient-to-br from-emerald-400 to-teal-600"
															}`}
														>
															{(zoomedDevice.ownerName || "?")
																.charAt(0)
																.toUpperCase()}
														</span>
														<span className="text-sm font-semibold text-slate-100">
															{zoomedDevice.ownerName || "Unknown"}
														</span>
														{zoomedDevice.isHost && (
															<span className="rounded border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[9px] text-sky-400">
																HOST
															</span>
														)}
														<span className="font-mono text-xs text-slate-400">
															• {zoomedDevice.deviceName}
														</span>
														<span className="flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 font-sans text-[11px] text-sky-300">
															<ZoomIn className="h-3 w-3" /> Zoom Mode Active
														</span>
													</div>
													<div className="flex items-center gap-2">
														{zoomedDevice.stream && (
															<span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
																LIVE
															</span>
														)}
														<button
															type="button"
															onClick={() => setZoomedDeviceId(null)}
															className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
														>
															<LayoutGrid className="h-3.5 w-3.5" />
															Show All Screens
														</button>
													</div>
												</div>
											</div>

											{/* Filmstrip thumbnails if multiple screens */}
											{sharedDevices.length > 1 && (
												<div className="flex shrink-0 items-center gap-2.5 overflow-x-auto py-1 px-1">
													<span className="text-[11px] font-medium text-slate-400 shrink-0 mr-1">
														Screens:
													</span>
													{sharedDevices.map((device) => {
														const isSelected = device.id === zoomedDevice.id;
														return (
															<button
																key={device.id}
																type="button"
																onClick={() => setZoomedDeviceId(device.id)}
																className={`relative flex h-20 w-36 shrink-0 flex-col overflow-hidden rounded-lg border text-left transition ${
																	isSelected
																		? "border-sky-500 ring-2 ring-sky-500/50 bg-slate-900"
																		: "border-slate-800 bg-slate-950 opacity-75 hover:border-slate-600 hover:opacity-100"
																}`}
															>
																<div className="relative min-h-0 flex-1 pointer-events-none">
																	<DeviceVideoPlayer
																		device={device}
																		isOwner={false}
																	/>
																</div>
																<div className="flex shrink-0 items-center justify-between border-t border-slate-800/80 bg-slate-900/90 px-2 py-1 text-[10px]">
																	<span className="truncate font-semibold text-slate-200">
																		{device.ownerName}
																	</span>
																	{device.stream && (
																		<span className="text-[9px] font-mono text-emerald-400">
																			LIVE
																		</span>
																	)}
																</div>
															</button>
														);
													})}
												</div>
											)}
										</div>
									) : (
										/* Full View Multi-Screen Grid */
										<div
											className={`grid h-full w-full gap-3 ${
												sharedDevices.length === 1
													? "grid-cols-1"
													: sharedDevices.length === 2
														? "grid-cols-1 md:grid-cols-2"
														: "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
											}`}
										>
											{sharedDevices.map((device) => (
												<div
													key={device.id}
													className="group flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-2xl transition hover:border-slate-700"
												>
													<div
														className="relative min-h-0 flex-1 cursor-pointer"
														onDoubleClick={
															remoteControlTargetId === device.id
																? undefined
																: () => setZoomedDeviceId(device.id)
														}
														title={
															remoteControlTargetId === device.id
																? undefined
																: "Double-click to focus this screen"
														}
													>
														<DeviceVideoPlayer
															device={device}
															isOwner={device.ownerId === myUserId}
															annotationEnabled={
																canDrawAnnotations &&
																annotationDeviceId === device.id
															}
															annotationCanEraseAll={isHost}
															annotationStrokes={
																annotationStrokes[device.id] ?? []
															}
															onAnnotationStroke={(stroke) =>
																handleAnnotationStroke(device.id, stroke)
															}
															onAnnotationErase={(strokeId) =>
																handleAnnotationErase(device.id, strokeId)
															}
															annotationAuthor={{
																id: myUserId ?? "",
																name: displayName,
															}}
															annotationColor={annotationColor}
															annotationWidth={annotationWidth}
															annotationTool={annotationTool}
															isRemoteControlled={
																remoteControlTargetId === device.id &&
																remoteControlStatus === "active"
															}
															onSendInput={(input) =>
																handleSendRemoteInput(
																	device.ownerId,
																	device.id,
																	input,
																)
															}
															onReleaseControl={() =>
																handleReleaseRemoteControl(
																	device.id,
																	device.ownerId,
																)
															}
															onStopStream={
																device.ownerId === myUserId
																	? device.isHost
																		? stopBroadcast
																		: stopGuestScreenshare
																	: undefined
															}
														/>
														{/* Hover quick-zoom action — suppressed while this tile is under remote
                            control (see Screens-tab tile for rationale: a pointer-events-auto
                            pill under the host cursor swallows every down/up before the
                            player's handlers ever see it). */}
														{remoteControlTargetId !== device.id && (
															<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
																<span
																	className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-sky-400/40 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-sky-300 shadow-xl backdrop-blur-md transition hover:bg-sky-500 hover:text-white"
																	onClick={(e) => {
																		e.stopPropagation();
																		setZoomedDeviceId(device.id);
																	}}
																>
																	<ZoomIn className="h-3.5 w-3.5" />
																	Focus / Zoom Screen
																</span>
															</div>
														)}
													</div>
													{/* Presenter name bar */}
													<div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-800 bg-slate-900/95 px-3 py-2">
														<div className="flex min-w-0 items-center gap-2">
															<span
																className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
																	device.isHost
																		? "bg-gradient-to-br from-sky-500 to-indigo-600"
																		: "bg-gradient-to-br from-emerald-400 to-teal-600"
																}`}
															>
																{(device.ownerName || "?")
																	.charAt(0)
																	.toUpperCase()}
															</span>
															<span className="truncate text-xs font-semibold text-slate-200">
																{device.ownerName || "Unknown"}
															</span>
															{device.isHost && (
																<span className="rounded border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[9px] text-sky-400">
																	HOST
																</span>
															)}
															<span className="hidden sm:inline font-mono text-[10px] text-slate-400">
																• {device.deviceName}
															</span>
														</div>

														<div className="flex max-w-full shrink-0 items-center gap-1.5 overflow-x-auto touch-pan-x">
															{canDrawAnnotations && (
																<ScreenAnnotationToolbar
																	deviceId={device.id}
																	activeDeviceId={annotationDeviceId}
																	color={annotationColor}
																	width={annotationWidth}
																	tool={annotationTool}
																	canClear={
																		annotationStrokes[device.id]?.some(
																			(stroke) =>
																				isHost || stroke.authorId === myUserId,
																		) ?? false
																	}
																	clearLabel={
																		isHost
																			? "Clear all annotations"
																			: "Clear my annotations"
																	}
																	compact
																	onToggle={() =>
																		setAnnotationDeviceId((current) =>
																			current === device.id ? null : device.id,
																		)
																	}
																	onColorChange={setAnnotationColor}
																	onWidthChange={setAnnotationWidth}
																	onToolChange={setAnnotationTool}
																	onClear={() =>
																		handleClearAnnotations(
																			device.id,
																			isHost ? "all" : "own",
																		)
																	}
																/>
															)}
															{device.stream && (
																<span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
																	LIVE
																</span>
															)}
															<button
																type="button"
																onClick={() => setZoomedDeviceId(device.id)}
																className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-[11px] font-medium text-slate-300 transition hover:border-sky-500/50 hover:bg-sky-500/20 hover:text-sky-300"
																title="Focus this screen in Zoom Mode"
															>
																<ZoomIn className="h-3 w-3" />
																<span>Focus</span>
															</button>
														</div>
													</div>
												</div>
											))}
										</div>
									)}
								</div>
							</>
						)}
						<div
							ref={setRecordingControlsPortalTarget}
							data-full-view-recording-footer
							className="shrink-0"
						/>
					</div>,
					document.body,
				)}

			{/* Modal: Change Display Name (Issue 1 & 2) */}
			{showNameModal && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
					<div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
						<h3 className="text-base font-bold text-white mb-1.5">
							Change Display Name
						</h3>
						<p className="text-xs text-slate-400 mb-4">
							Update how your name appears to everyone in the room.
						</p>
						<input
							type="text"
							value={nameEditValue}
							onChange={(e) => setNameEditValue(e.target.value.slice(0, 50))}
							maxLength={50}
							className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
							autoFocus
						/>
						<div className="mt-4 flex justify-end gap-2">
							<button
								type="button"
								onClick={() => setShowNameModal(false)}
								className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={async () => {
									const trimmed = nameEditValue.trim();
									if (!trimmed) return;
									if (isHost) {
										setCustomName(trimmed);
										setHostNameInput(trimmed);
									} else {
										setGuestName(trimmed);
									}
									if (typeof window !== "undefined") {
										localStorage.setItem("mira_user_name", trimmed);
									}
									if (roomCode) {
										await mutationsRef.current
											.joinRoom({
												roomCode,
												name: isHost ? `${trimmed} (Host)` : trimmed,
											})
											.catch(() => {});
									}
									setShowNameModal(false);
									toast.success(`Display name updated to ${trimmed}`);
								}}
								className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-400"
							>
								Save Name
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Modal: Join via Invite Link */}
			{showJoinModal && (
				<div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md">
					<div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/95 p-6 shadow-2xl backdrop-blur-2xl animate-in fade-in zoom-in-95 duration-200">
						<div className="flex items-center justify-between border-b border-white/10 pb-3">
							<div className="flex items-center gap-2.5 text-white">
								<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
									<Link2 className="h-4 w-4" />
								</div>
								<div>
									<h3 className="text-sm font-bold">Join via Invite Link</h3>
									<p className="text-[11px] text-slate-400">
										Paste the complete guest link created by the host
									</p>
								</div>
							</div>
							<button
								type="button"
								onClick={() => setShowJoinModal(false)}
								className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white"
							>
								<X className="h-4 w-4" />
							</button>
						</div>

						<div className="mt-4 space-y-3.5">
							<div>
								<label className="mb-1.5 block text-xs font-medium text-slate-300">
									Guest Invite Link
								</label>
								<input
									type="text"
									value={inviteLinkInput}
									onChange={(e) => setInviteLinkInput(e.target.value)}
									placeholder="https://.../screenshare?room=MIRA-XXX or MIRA-XXX-YYY-ZZZ"
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleJoinByInviteLink();
										}
									}}
									className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-xs font-mono text-white outline-none transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500 placeholder:font-sans placeholder:text-slate-500"
								/>
							</div>

							<div>
								<label className="mb-1.5 block text-xs font-medium text-slate-300">
									Your Display Name{" "}
									<span className="text-slate-500 font-normal">(optional)</span>
								</label>
								<input
									type="text"
									value={guestJoinNameInput}
									onChange={(e) =>
										setGuestJoinNameInput(e.target.value.slice(0, 50))
									}
									placeholder={customName || myName || "e.g. Maya"}
									maxLength={50}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleJoinByInviteLink();
										}
									}}
									className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-white outline-none transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
								/>
							</div>

							<div className="flex justify-end gap-2 pt-2 border-t border-white/10">
								<button
									type="button"
									onClick={() => setShowJoinModal(false)}
									className="rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700"
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={() => handleJoinByInviteLink()}
									className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/25 transition hover:bg-sky-400"
								>
									<ArrowRight className="h-3.5 w-3.5" />
									Join Host Session
								</button>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Modal: Kick Participant Confirmation */}
			{kickingViewer && (
				<div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
					<div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-slate-900 p-6 shadow-2xl">
						<div className="flex items-center gap-3 text-red-400">
							<AlertTriangle className="h-6 w-6" />
							<h3 className="text-base font-bold text-white">
								Kick Participant
							</h3>
						</div>
						<p className="mt-2 text-xs text-slate-300 leading-relaxed">
							Are you sure you want to kick{" "}
							<strong className="text-white">{kickingViewer.name}</strong> from
							this session? They will be disconnected immediately. They can
							rejoin if they have the room link.
						</p>
						<div className="mt-6 flex justify-end gap-2 border-t border-slate-800 pt-3">
							<button
								type="button"
								onClick={() => setKickingViewer(null)}
								className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleConfirmKick}
								className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-red-600/30 hover:bg-red-500"
							>
								Kick Participant
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Apple-style Interactive Permission Dialog for Remote Control (PORTALED to top-layer for fullscreen & theaterMode) */}
			{incomingControlRequest &&
				mounted &&
				typeof document !== "undefined" &&
				(() => {
					const controlEligibilityError = getControlEligibilityError(
						incomingControlRequest.deviceId,
					);
					return createPortal(
						<div
							{...{ [MIRA_REMOTE_GUARD_ATTR]: "true" }}
							className="fixed inset-0 z-[100000] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-md animate-in fade-in duration-200"
						>
							<div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-sky-500/30 bg-slate-900/90 p-6 shadow-2xl backdrop-blur-2xl transition-all">
								<div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-sky-500/10 blur-2xl pointer-events-none" />
								<div className="absolute -left-10 -bottom-10 h-36 w-36 rounded-full bg-indigo-500/10 blur-2xl pointer-events-none" />

								<div className="relative flex flex-col items-center text-center">
									<div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/30 bg-gradient-to-br from-sky-500/20 to-indigo-500/20 text-sky-400 shadow-inner">
										<MousePointer className="h-7 w-7 animate-pulse" />
									</div>

									<h3 className="text-lg font-semibold tracking-tight text-white">
										Remote Control Request
									</h3>
									<p className="mt-2 text-sm text-slate-300">
										<span className="font-semibold text-sky-400">
											{incomingControlRequest.hostName || "Host"}
										</span>{" "}
										is requesting browser-only pointer and keyboard control of
										this Ollashare tab. Share this Ollashare tab in the picker,
										not another tab, a window or your entire screen. External
										tabs and desktop applications cannot be controlled.
									</p>

									<div className="mt-4 w-full rounded-xl border border-white/10 bg-slate-950/60 p-3 text-left space-y-2">
										<div className="flex items-center gap-2 text-xs text-slate-300">
											<ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
											<span>
												Synthetic browser input only; some trusted browser
												actions are unavailable
											</span>
										</div>
										<div className="flex items-center gap-2 text-xs text-slate-400">
											<Lock className="h-4 w-4 text-sky-400 shrink-0" />
											<span>
												You can instantly revoke control at any time via Esc or
												the on-screen button
											</span>
										</div>
									</div>

									<label className="mt-4 flex items-start gap-2 text-left text-xs text-slate-200">
										<input
											type="checkbox"
											checked={sameTabConfirmed}
											onChange={(event) => {
												sameTabConfirmedRef.current = event.target.checked;
												setSameTabConfirmed(event.target.checked);
											}}
										/>
										<span>I am sharing this Ollashare tab</span>
									</label>
									<p className="mt-2 text-left text-[11px] text-slate-400">
										Tab identity is verified with Capture Handle where
										supported. Without it, this confirmation is best-effort: the
										browser only identifies the capture as a tab. Detected
										source changes end control; without this API, stop control
										before switching tabs and re-share to confirm again.
									</p>
									{controlEligibilityError && (
										<div
											role="alert"
											className="mt-3 w-full rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-left text-xs font-medium text-amber-200"
										>
											{controlEligibilityError}
										</div>
									)}
									<div className="mt-6 flex w-full items-center justify-end gap-3">
										<button
											type="button"
											onClick={handleDenyControlRequest}
											className="flex-1 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-2.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 active:scale-95"
										>
											Deny
										</button>
										<button
											type="button"
											onClick={handleAcceptControlRequest}
											disabled={isSendingControlResponse}
											aria-disabled={Boolean(controlEligibilityError)}
											className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border border-sky-400/40 bg-gradient-to-r from-sky-500 to-indigo-600 px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 transition hover:from-sky-400 hover:to-indigo-500 active:scale-95 disabled:cursor-wait disabled:opacity-60"
										>
											<MousePointer className="h-3.5 w-3.5" />
											{isSendingControlResponse
												? "Sending approval…"
												: "Accept & Allow"}
										</button>
									</div>
								</div>
							</div>
						</div>,
						document.fullscreenElement ??
							(theaterMode && theaterRef.current
								? theaterRef.current
								: document.body),
					);
				})()}

			{/* Guest: Floating Active Remote Control Apple Pill with Instant Revoke (PORTALED to top-layer) */}
			{isControlledByHost &&
				mounted &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						{...{ [MIRA_REMOTE_GUARD_ATTR]: "true" }}
						className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full border border-sky-400/40 bg-slate-900/90 px-4 py-2 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-top-3"
					>
						<div className="flex items-center gap-2">
							<span className="relative flex h-2.5 w-2.5">
								<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
								<span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-sky-500"></span>
							</span>
							<span className="text-xs font-semibold text-white">
								Host ({controllingHostName || "Host"}) is controlling this
								Ollashare tab only
							</span>
						</div>
						<button
							type="button"
							onClick={handleRevokeControlByGuest}
							className="flex items-center gap-1 rounded-full border border-red-500/50 bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-200 transition hover:bg-red-500/30 active:scale-95 shadow-sm"
							title="Immediately revoke remote control (Esc)"
						>
							<X className="h-3 w-3" />
							<span>Revoke Control (Esc)</span>
						</button>
					</div>,
					document.fullscreenElement ??
						(theaterMode && theaterRef.current
							? theaterRef.current
							: document.body),
				)}

			{/* Guest: Live Visual Cursor Tracking Host Pointer with Clicks.
            Rendered via a PORTAL into the fullscreen element when one is active —
            a `fixed` overlay outside the fullscreened subtree is hidden by the UA's
            top layer, which previously made the remote cursor vanish the moment the
            guest entered fullscreen. Re-rendering on `fullscreenchange` (the
            isFullscreen state) re-evaluates the portal target; position lives in
            remoteCursorElRef + refs, so remount never loses cursor state. The
            `fixed` positioning stays correct inside the fullscreen element because
            it is itself viewport-sized. Pointer events stay off (never intercepts). */}
			{isControlledByHost &&
				mounted &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						ref={remoteCursorElRef}
						aria-hidden="true"
						className="pointer-events-none fixed left-0 top-0 z-[9999999] will-change-transform select-none"
						style={{
							transform: lastCursorPosRef.current
								? `translate3d(${lastCursorPosRef.current.x}px, ${lastCursorPosRef.current.y}px, 0)`
								: "translate3d(-100px, -100px, 0)",
							opacity: lastCursorPosRef.current ? "1" : "0",
						}}
					>
						{/* Standard white arrow pointer aligned so SVG tip at (5.5, 3.2) is exactly at (0, 0) */}
						<div className="-translate-x-[4px] -translate-y-[2.5px]">
							<svg
								width="22"
								height="22"
								viewBox="0 0 28 28"
								fill="none"
								className="drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] filter"
							>
								<path
									d="M5.5 3.2v20.6a1 1 0 0 0 1.8.6l4.4-5.1 3.1 6.5a1 1 0 0 0 1.3.5l2.6-1.2a1 1 0 0 0 .5-1.3l-3.2-6.6 6.7-.6a1 1 0 0 0 .6-1.8L6.7 2.5a1 1 0 0 0-1.2.7z"
									fill="#ffffff"
									stroke="#0f172a"
									strokeWidth="1.6"
									strokeLinejoin="round"
								/>
							</svg>
						</div>
						<span className="absolute left-4 top-4 whitespace-nowrap rounded-md bg-slate-900/95 px-1.5 py-0.5 text-[10px] font-bold text-sky-300 shadow-md ring-1 ring-sky-400/40">
							{controllingHostName || "Host"}
						</span>
						{remoteCursor?.clicking && (
							<span className="absolute -left-1.5 -top-1.5 h-8 w-8 rounded-full border-2 border-sky-400 animate-ping pointer-events-none" />
						)}
					</div>,
					document.fullscreenElement ??
						(theaterMode && theaterRef.current
							? theaterRef.current
							: document.body),
				)}
		</div>
	);
}

// parent re-renders on viewers/config/signals updates.
const DeviceVideoPlayer = memo(function DeviceVideoPlayer({
	device,
	isOwner,
	onStopStream,
	isRemoteControlled,
	onSendInput,
	onReleaseControl,
	annotationEnabled,
	annotationCanEraseAll = false,
	annotationStrokes = [],
	onAnnotationStroke,
	onAnnotationErase,
	annotationAuthor,
	annotationColor = ANNOTATION_COLORS[0],
	annotationWidth = ANNOTATION_WIDTHS[1],
	annotationTool = "pen",
}: {
	device: SharedDeviceStream;
	isOwner: boolean;
	onStopStream?: () => void;
	isRemoteControlled?: boolean;
	onSendInput?: (input: SharerInputMessage) => void;
	onReleaseControl?: () => void;
	annotationEnabled?: boolean;
	annotationCanEraseAll?: boolean;
	annotationStrokes?: ScreenAnnotationStroke[];
	onAnnotationStroke?: (stroke: ScreenAnnotationStroke) => void;
	onAnnotationErase?: (strokeId: string) => void;
	annotationAuthor?: { id: string; name: string };
	annotationColor?: string;
	annotationWidth?: number;
	annotationTool?: AnnotationTool;
}) {
	const vidRef = useRef<HTMLVideoElement>(null);
	// Input container ref — used by the native non-passive wheel listener while controlled.
	const containerRef = useRef<HTMLDivElement>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const [isPlaying, setIsPlaying] = useState<boolean>(false);
	const [playBlocked, setPlayBlocked] = useState<boolean>(false);
	const [draftStroke, setDraftStroke] = useState<ScreenAnnotationStroke | null>(
		null,
	);

	// Coordinate computation relative to native video resolution with letterbox/pillarbox adjustment.
	// Returns stream pixels (x,y,sw,sh) AND the normalized
	// u,v (0..1 within the ACTIVE VIDEO IMAGE) which is the authoritative mapping for
	// v2 guests: immune to host/guest resolution differences, letterboxing, and
	// window/fullscreen size changes on either side.
	const [videoSize, setVideoSize] = useState<{ width: number; height: number }>(
		{ width: 0, height: 0 },
	);

	const computeCoordinates = useCallback(
		(e: { clientX: number; clientY: number }) => {
			const video = vidRef.current;
			if (
				!video ||
				video.readyState < 1 ||
				!video.videoWidth ||
				!video.videoHeight
			)
				return null;
			// Read live decoded-frame dimensions on EVERY gesture: no guessed resolution
			// or stale metadata after stream adaptation, window resize or fullscreen.
			const point = calculateNormalizedVideoCoordinates(
				e.clientX,
				e.clientY,
				video.getBoundingClientRect(),
				video.videoWidth,
				video.videoHeight,
			);
			return point
				? { ...point, sw: video.videoWidth, sh: video.videoHeight }
				: null;
		},
		[],
	);

	const annotationPoint = useCallback(
		(event: { clientX: number; clientY: number }) => {
			const video = vidRef.current;
			if (!video || !video.videoWidth || !video.videoHeight) return null;
			const point = calculateNormalizedVideoCoordinates(
				event.clientX,
				event.clientY,
				video.getBoundingClientRect(),
				video.videoWidth,
				video.videoHeight,
			);
			return point ? { u: point.u, v: point.v } : null;
		},
		[],
	);

	const activeAnnotationPointerRef = useRef<number | null>(null);
	const draftStrokeRef = useRef<ScreenAnnotationStroke | null>(null);
	draftStrokeRef.current = draftStroke;
	useEffect(() => {
		window.dispatchEvent(
			new CustomEvent("mira-screen-annotation-draft", {
				detail: { deviceId: device.id, draft: draftStroke },
			}),
		);
		return () => {
			window.dispatchEvent(
				new CustomEvent("mira-screen-annotation-draft", {
					detail: { deviceId: device.id, draft: null },
				}),
			);
		};
	}, [device.id, draftStroke]);

	const cancelAnnotation = useCallback(
		(element?: Element, pointerId = activeAnnotationPointerRef.current) => {
			if (element && pointerId !== null)
				tryReleasePointerCapture(element, pointerId);
			activeAnnotationPointerRef.current = null;
			draftStrokeRef.current = null;
			setDraftStroke(null);
		},
		[],
	);

	const beginAnnotation = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (
				!annotationEnabled ||
				isRemoteControlled ||
				activeAnnotationPointerRef.current !== null
			)
				return;
			const point = annotationPoint(event);
			if (!point || !annotationAuthor?.id) return;
			const annotationAuthorId = annotationAuthor.id;
			if (annotationTool === "eraser") {
				const nearest = findNearestErasableStroke(
					annotationStrokes,
					point,
					annotationAuthorId,
					annotationCanEraseAll,
				);
				if (nearest) onAnnotationErase?.(nearest.id);
				return;
			}
			trySetPointerCapture(event.currentTarget, event.pointerId);
			activeAnnotationPointerRef.current = event.pointerId;
			setDraftStroke({
				id: createAnnotationStrokeId(),
				authorId: annotationAuthorId,
				authorName: annotationAuthor.name || "Participant",
				targetType: "screen",
				targetId: device.id,
				color: annotationColor,
				width: annotationWidth,
				tool: annotationTool === "highlighter" ? "highlighter" : "pen",
				opacity: annotationTool === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
				points: [point],
				createdAt: Date.now(),
			});
		},
		[
			annotationAuthor,
			annotationCanEraseAll,
			annotationColor,
			annotationEnabled,
			annotationPoint,
			annotationStrokes,
			annotationTool,
			annotationWidth,
			device.id,
			isRemoteControlled,
			onAnnotationErase,
		],
	);

	const continueAnnotation = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (
				activeAnnotationPointerRef.current !== event.pointerId ||
				!draftStrokeRef.current
			)
				return;
			const point = annotationPoint(event);
			if (!point) return;
			setDraftStroke((stroke) =>
				stroke && stroke.points.length < ANNOTATION_LIMITS.maxPoints
					? { ...stroke, points: [...stroke.points, point] }
					: stroke,
			);
		},
		[annotationPoint],
	);

	const finishAnnotation = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (activeAnnotationPointerRef.current !== event.pointerId) return;
			const completedStroke = draftStrokeRef.current;
			tryReleasePointerCapture(event.currentTarget, event.pointerId);
			activeAnnotationPointerRef.current = null;
			draftStrokeRef.current = null;
			setDraftStroke(null);
			if (completedStroke && completedStroke.points.length > 1)
				onAnnotationStroke?.(completedStroke);
		},
		[onAnnotationStroke],
	);

	useEffect(() => {
		if (!annotationEnabled || isRemoteControlled)
			cancelAnnotation(containerRef.current ?? undefined);
	}, [annotationEnabled, cancelAnnotation, isRemoteControlled]);

	useEffect(() => {
		const cancelOnBlur = () =>
			cancelAnnotation(containerRef.current ?? undefined);
		window.addEventListener("blur", cancelOnBlur);
		return () => {
			window.removeEventListener("blur", cancelOnBlur);
			cancelAnnotation(containerRef.current ?? undefined);
		};
	}, [cancelAnnotation]);

	// Stable callbacks avoid canceling a held gesture on unrelated parent renders.
	const inputPropsRef = useRef({ onSendInput, onReleaseControl });
	inputPropsRef.current = { onSendInput, onReleaseControl };
	useEffect(() => {
		const container = containerRef.current;
		if (!container || !isRemoteControlled) return;
		return attachBrowserInputCapture(container, {
			coordinates: computeCoordinates,
			send: (input) => inputPropsRef.current.onSendInput?.(input),
			release: () => inputPropsRef.current.onReleaseControl?.(),
		});
	}, [isRemoteControlled, device.id, computeCoordinates]);

	// LiveKit track attachment
	useEffect(() => {
		const video = vidRef.current;
		if (!video || !device.liveKitTrack) return;
		try {
			device.liveKitTrack.attach(video);
		} catch (err) {
			console.warn("[DeviceVideoPlayer] LiveKit attach error:", err);
		}
		return () => {
			try {
				device.liveKitTrack?.detach(video);
			} catch {}
		};
	}, [device.liveKitTrack]);

	// MediaStream playback and track unmute handler (Mesh + Fallback)
	useEffect(() => {
		const video = vidRef.current;
		if (!video) return;

		// Enforce vital DOM properties directly on the element
		video.muted = true;
		video.playsInline = true;
		video.autoplay = true;

		if (device.liveKitTrack) {
			// LiveKit manages attachment and events directly
			return;
		}

		if (!device.stream) {
			video.srcObject = null;
			streamRef.current = null;
			setIsPlaying(false);
			return;
		}

		const currentTrack = (
			video.srcObject as MediaStream | null
		)?.getVideoTracks()[0];
		const newTrack = device.stream.getVideoTracks()[0];

		if (
			video.srcObject !== device.stream ||
			(currentTrack && newTrack && currentTrack.id !== newTrack.id)
		) {
			streamRef.current = device.stream;
			video.srcObject = device.stream;
		}

		const tryPlay = () => {
			if (!video) return;
			video.muted = true;
			const playPromise = video.play();
			if (playPromise) {
				playPromise
					.then(() => {
						setIsPlaying(true);
						setPlayBlocked(false);
					})
					.catch((err) => {
						if (err?.name === "AbortError") {
							return; // Benign: component unmounted or changed view during play()
						}
						console.warn(
							"[DeviceVideoPlayer] Autoplay delayed or blocked:",
							err,
						);
						setPlayBlocked(true);
						captureError(err, "videoPlay", { deviceName: device.deviceName });
					});
			}
		};

		tryPlay();

		video.onloadedmetadata = tryPlay;
		video.oncanplay = tryPlay;
		video.onplaying = () => {
			setIsPlaying(true);
			setPlayBlocked(false);
		};

		if (newTrack) {
			newTrack.onunmute = tryPlay;
		}

		return () => {
			video.onloadedmetadata = null;
			video.oncanplay = null;
			video.onplaying = null;
			if (newTrack) {
				newTrack.onunmute = null;
			}
		};
	}, [device.stream, device.liveKitTrack, device.deviceName]);

	const handleManualPlay = () => {
		const video = vidRef.current;
		if (video) {
			video.muted = true;
			video
				.play()
				.then(() => {
					setIsPlaying(true);
					setPlayBlocked(false);
				})
				.catch(() => {});
		}
	};

	return (
		<div
			ref={containerRef}
			tabIndex={isRemoteControlled ? 0 : undefined}
			data-mira-rc-input={isRemoteControlled ? "true" : undefined}
			style={{ touchAction: isRemoteControlled ? "none" : undefined }}
			onPointerDown={beginAnnotation}
			onPointerMove={continueAnnotation}
			onPointerUp={finishAnnotation}
			onPointerCancel={(event) =>
				cancelAnnotation(event.currentTarget, event.pointerId)
			}
			onLostPointerCapture={(event) =>
				cancelAnnotation(event.currentTarget, event.pointerId)
			}
			className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-slate-950 select-none ${
				isRemoteControlled
					? "ring-2 ring-sky-500/80 outline-none [cursor:URL('/remote-cursor.svg')_4_2,auto]"
					: annotationEnabled
						? "ring-2 ring-amber-400/80 cursor-crosshair"
						: ""
			}`}
		>
			<video
				ref={vidRef}
				autoPlay
				playsInline
				muted
				onLoadedMetadata={(e) => {
					const v = e.currentTarget;
					if (v.videoWidth && v.videoHeight) {
						setVideoSize({ width: v.videoWidth, height: v.videoHeight });
					}
				}}
				aria-label={`Live screen share stream from ${device.deviceName}`}
				className={`h-full w-full bg-slate-950 object-contain ${isRemoteControlled ? "pointer-events-none" : ""}`}
				style={{ touchAction: annotationEnabled ? "none" : undefined }}
			/>

			{(annotationStrokes.length > 0 || draftStroke) && (
				<svg
					aria-label="Screen annotations"
					viewBox={`0 0 ${videoSize.width || 1000} ${videoSize.height || 1000}`}
					preserveAspectRatio="xMidYMid meet"
					className="pointer-events-none absolute inset-0 z-20 h-full w-full"
				>
					{[...annotationStrokes, ...(draftStroke ? [draftStroke] : [])].map(
						(stroke) => {
							const renderStyle = getAnnotationStrokeRenderStyle(stroke);
							return (
								<polyline
									key={stroke.id}
									points={stroke.points
										.map(
											(point) =>
												`${point.u * (videoSize.width || 1000)},${point.v * (videoSize.height || 1000)}`,
										)
										.join(" ")}
									fill="none"
									stroke={stroke.color}
									strokeWidth={renderStyle.lineWidth}
									strokeOpacity={renderStyle.opacity}
									strokeLinecap="round"
									strokeLinejoin="round"
									vectorEffect="non-scaling-stroke"
								/>
							);
						},
					)}
				</svg>
			)}

			{annotationEnabled && (
				<div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full border border-amber-400/40 bg-slate-900/90 px-3 py-1 text-[11px] font-semibold text-amber-200 shadow-lg backdrop-blur-md">
					Draw mode active
				</div>
			)}

			{/* Floating Active Remote Control indicator inside video player */}
			{isRemoteControlled && (
				<div
					{...{ [MIRA_REMOTE_GUARD_ATTR]: "true" }}
					className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full border border-sky-400/40 bg-slate-900/90 px-3 py-1 shadow-lg backdrop-blur-md animate-in fade-in"
					// The badge is INSIDE the input container, so its presses would bubble into
					// pointerdown/pointerup and produce phantom input on the guest's screen
					// (e.g. releasing control also "clicks" the guest's UI under the badge).
					onPointerDown={(e) => e.stopPropagation()}
					onPointerUp={(e) => e.stopPropagation()}
					onPointerMove={(e) => e.stopPropagation()}
					onPointerCancel={(e) => e.stopPropagation()}
					onClick={(e) => e.stopPropagation()}
					onWheel={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
					onKeyUp={(e) => e.stopPropagation()}
				>
					<span className="flex h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
					<span className="text-[11px] font-semibold text-white">
						Remote Control Active
					</span>
					{onReleaseControl && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onReleaseControl();
							}}
							className="ml-1 rounded border border-red-500/40 bg-red-500/20 px-1.5 py-0.5 text-[9px] font-bold text-red-300 hover:bg-red-500/40 transition"
							title="Release remote control"
						>
							Release
						</button>
					)}
				</div>
			)}

			{!device.stream && !device.liveKitTrack && (
				<div className="absolute inset-0 z-0 flex flex-col items-center justify-center bg-slate-950/90 pointer-events-none">
					<p className="text-xs font-semibold text-slate-200">
						Connecting video feed…
					</p>
					<p className="mt-1 font-mono text-[11px] text-slate-400">
						{device.deviceName}
					</p>
				</div>
			)}

			{/* Manual play overlay if browser blocked autoplay */}
			{playBlocked && !isPlaying && (
				<button
					type="button"
					onClick={handleManualPlay}
					className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/80 p-4 text-center cursor-pointer transition hover:bg-slate-950/70"
				>
					<Play className="h-10 w-10 text-sky-400 mb-2 animate-bounce" />
					<p className="text-sm font-semibold text-white">
						Click to View Screen
					</p>
					<p className="text-xs text-slate-400 mt-1">
						Browser blocked video autoplay
					</p>
				</button>
			)}
		</div>
	);
});
