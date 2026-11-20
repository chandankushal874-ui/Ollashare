"use client";

import type {
	AnnotationOperation,
	AnnotationPermissionSnapshot,
	AnnotationStroke,
} from "@/lib/annotation-types";
import {
	AlertTriangle,
	Expand,
	Eye,
	LoaderCircle,
	Maximize2,
	Minimize2,
	MousePointer2,
	Power,
	RefreshCw,
	ShieldCheck,
	Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SharedBrowserAnnotationOverlay } from "./annotation-overlay";
import { SharedBrowserRequestError, sharedBrowserClient } from "./client";
import {
	createSharedBrowserFrameHandle,
	type SharedBrowserFrameHandle,
} from "./frame-source";
import type {
	SharedBrowserAccess,
	SharedBrowserGrant,
	SharedBrowserSession,
} from "./contract";

export type SharedBrowserViewerState =
	| "checking"
	| "disconnected"
	| "loading"
	| "connected"
	| "failed";

interface SharedBrowserPanelProps {
	roomCode: string;
	participantId: string;
	hostId?: string;
	isHost: boolean;
	isActive?: boolean;
	participants?: Array<{ id: string; name: string }>;
	annotationPermissions?: AnnotationPermissionSnapshot;
	annotationStrokes?: AnnotationStroke[];
	onAnnotationSubmit?: (operation: AnnotationOperation) => Promise<unknown>;
	onAnnotationSubscribe?: (
		listener: (message: unknown, senderId?: string) => void,
	) => () => void;
	onSessionChange?: (sessionId: string | null) => void;
	onSetAnnotationPermission?: (
		participantId: string,
		allowed: boolean,
	) => Promise<void> | void;
	onControllerChanged?: (participantId: string) => void;
	onViewerStateChange?: (state: SharedBrowserViewerState) => void;
	onFrameHandleChange?: (handle: SharedBrowserFrameHandle | null) => void;
}

export function SharedBrowserPanel({
	roomCode,
	participantId,
	isHost,
	isActive = true,
	participants = [],
	hostId,
	annotationPermissions = { allowedUserIds: new Set<string>() },
	annotationStrokes = [],
	onAnnotationSubmit,
	onAnnotationSubscribe,
	onSessionChange,
	onSetAnnotationPermission,
	onControllerChanged,
	onViewerStateChange,
	onFrameHandleChange,
}: SharedBrowserPanelProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [toolbarContainer, setToolbarContainer] =
		useState<HTMLDivElement | null>(null);
	const viewerFrameRef = useRef<HTMLIFrameElement>(null);
	const sessionRequestRef = useRef(0);
	const recoveryGenerationRef = useRef(0);
	const grantFlightRef = useRef<{
		sessionId: string;
		access: SharedBrowserAccess;
		promise: Promise<SharedBrowserGrant>;
	} | null>(null);
	const [session, setSession] = useState<SharedBrowserSession | null>(null);
	const [grant, setGrant] = useState<SharedBrowserGrant | null>(null);
	const [access, setAccess] = useState<SharedBrowserAccess>(
		isHost ? "controller" : "view-only",
	);
	const [viewerState, setViewerState] =
		useState<SharedBrowserViewerState>("checking");
	const [error, setError] = useState<string | null>(null);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [controllerTarget, setControllerTarget] = useState("");
	const [controllerMutationTarget, setControllerMutationTarget] = useState<
		string | null
	>(null);
	const issueGrantSingleFlight = useCallback(
		(sessionId: string, requestedAccess: SharedBrowserAccess = "view-only") => {
			const active = grantFlightRef.current;
			if (active && active.sessionId === sessionId) return active.promise;
			const promise = sharedBrowserClient.issueGrant(sessionId, {
				roomCode,
				access: requestedAccess,
			});
			grantFlightRef.current = { sessionId, access: requestedAccess, promise };
			void promise.then(
				() => {
					if (grantFlightRef.current?.promise === promise)
						grantFlightRef.current = null;
				},
				() => {
					if (grantFlightRef.current?.promise === promise)
						grantFlightRef.current = null;
				},
			);
			return promise;
		},
		[roomCode],
	);
	const recoverViewer = useCallback(async () => {
		if (!roomCode || (!isHost && !participantId)) return;
		const generation = ++recoveryGenerationRef.current;
		setViewerState("loading");
		setError(null);
		for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
			if (delay)
				await new Promise((resolve) => window.setTimeout(resolve, delay));
			if (generation !== recoveryGenerationRef.current) return;
			try {
				const current = await sharedBrowserClient.getSession(roomCode);
				const activeSession = current?.state === "ready" ? current : null;
				if (generation !== recoveryGenerationRef.current) return;
				if (!activeSession) {
					setGrant(null);
					setSession(null);
					setViewerState("disconnected");
					return;
				}
				setSession(activeSession);
				const issued = await issueGrantSingleFlight(
					activeSession.id,
					"view-only",
				);
				if (generation !== recoveryGenerationRef.current) return;
				setGrant(issued);
				setViewerState("loading");
				return;
			} catch (cause) {
				if (
					cause instanceof SharedBrowserRequestError &&
					[401, 403, 404, 410].includes(cause.status)
				) {
					setGrant(null);
					if (cause.status === 410) setSession(null);
					setViewerState("disconnected");
					setError(
						cause.status === 410 && isHost
							? null
							: "This Shared Browser session ended or access was revoked.",
					);
					return;
				}
			}
		}
		if (generation !== recoveryGenerationRef.current) return;
		setGrant(null);
		setViewerState("failed");
		setError(
			"Shared Browser is temporarily reconnecting. Retry if the connection does not recover.",
		);
	}, [isHost, issueGrantSingleFlight, participantId, roomCode]);

	const refreshControllerGrant = useCallback(async () => {
		if (!session || isHost) return;
		const current = await sharedBrowserClient.getSession(roomCode);
		setSession(current);
		if (!current?.isController) return;
		const issued = await issueGrantSingleFlight(current.id, "view-only");
		setGrant(issued);
		setViewerState("loading");
	}, [isHost, issueGrantSingleFlight, roomCode, session]);

	const loadSession = useCallback(async () => {
		if (!roomCode) return;
		const requestId = ++sessionRequestRef.current;
		setViewerState("checking");
		setError(null);
		try {
			const current = await sharedBrowserClient.getSession(roomCode);
			const activeSession = current?.state === "ready" ? current : null;
			if (requestId !== sessionRequestRef.current) return;
			setSession(activeSession);
			if (activeSession && !isHost && participantId) {
				setViewerState("loading");
				const issued = await issueGrantSingleFlight(
					activeSession.id,
					"view-only",
				);
				if (requestId !== sessionRequestRef.current) return;
				setGrant(issued);
				return;
			}
			setViewerState("disconnected");
		} catch (cause) {
			if (requestId !== sessionRequestRef.current) return;
			setViewerState("loading");
			setError(null);
			void recoverViewer();
		}
	}, [isHost, issueGrantSingleFlight, participantId, recoverViewer, roomCode]);
	useEffect(() => {
		onViewerStateChange?.(viewerState);
	}, [onViewerStateChange, viewerState]);
	useEffect(() => {
		if (!onFrameHandleChange) return;
		if (viewerState !== "connected" || !session?.id || !viewerFrameRef.current) {
			onFrameHandleChange(null);
			return;
		}
		const publish = () => {
			const iframe = viewerFrameRef.current;
			onFrameHandleChange(
				iframe
					? createSharedBrowserFrameHandle({
						iframe,
						sessionId: session.id,
						connectionState: viewerState,
					})
					: null,
			);
		};
		publish();
		const timer = window.setTimeout(publish, 0);
		return () => {
			window.clearTimeout(timer);
			onFrameHandleChange(null);
		};
	}, [onFrameHandleChange, session?.id, viewerState]);
	useEffect(() => {
		if (isActive) return;
		viewerFrameRef.current?.blur();
		if (document.fullscreenElement === panelRef.current)
			void document.exitFullscreen().catch(() => undefined);
	}, [isActive]);
	useEffect(() => {
		onSessionChange?.(session?.id ?? null);
	}, [onSessionChange, session?.id]);

	useEffect(() => {
		void loadSession();
	}, [loadSession]);

	useEffect(() => {
		if (isHost || grant) return;
		const interval = window.setInterval(() => {
			void recoverViewer();
		}, 3_000);
		return () => window.clearInterval(interval);
	}, [grant, isHost, recoverViewer]);

	useEffect(() => {
		if (!session || isHost || grant?.access === "controller") return;
		const interval = window.setInterval(() => {
			void sharedBrowserClient
				.getSession(roomCode)
				.then((current) => {
					setSession(current);
					if (!current) {
						setGrant(null);
						setSession(null);
						setViewerState("disconnected");
						window.clearInterval(interval);
						return;
					}
					if (!current.isController) return;
					return issueGrantSingleFlight(current.id, "view-only").then(
						(issued) => {
							setGrant(issued);
							setViewerState("loading");
							window.clearInterval(interval);
						},
					);
				})
				.catch((cause) => {
					if (
						cause instanceof SharedBrowserRequestError &&
						(cause.status === 401 ||
							cause.status === 403 ||
							cause.status === 404)
					) {
						setGrant(null);
						setSession(null);
						setViewerState("disconnected");
						setError(
							"This Shared Browser session ended or access was revoked. Provision or reconnect to the current room session.",
						);
						window.clearInterval(interval);
					}
				});
		}, 5_000);
		return () => window.clearInterval(interval);
	}, [session, isHost, grant?.access, issueGrantSingleFlight, roomCode]);
	useEffect(() => {
		if (!onAnnotationSubscribe || isHost) return;
		return onAnnotationSubscribe((value: unknown, senderId?: string) => {
			if (
				senderId !== hostId ||
				!value ||
				typeof value !== "object" ||
				Array.isArray(value)
			)
				return;
			const message = value as { type?: string; viewerId?: string };
			if (
				message.type === "SHARED_BROWSER_CONTROLLER_CHANGED" &&
				message.viewerId === participantId
			)
				void refreshControllerGrant();
		});
	}, [
		hostId,
		isHost,
		onAnnotationSubscribe,
		participantId,
		refreshControllerGrant,
	]);

	useEffect(() => {
		const onFullscreenChange = () =>
			setIsFullscreen(document.fullscreenElement === panelRef.current);
		document.addEventListener("fullscreenchange", onFullscreenChange);
		return () =>
			document.removeEventListener("fullscreenchange", onFullscreenChange);
	}, []);

	useEffect(() => {
		const listener = (event: MessageEvent) => {
			if (
				event.origin !== window.location.origin ||
				event.source !== viewerFrameRef.current?.contentWindow ||
				event.data?.type !== "MIRA_SHARED_BROWSER_STATE"
			)
				return;
			if (event.data.state === "connected") {
				recoveryGenerationRef.current += 1;
				setViewerState("connected");
			} else if (
				event.data.state === "disconnected" ||
				event.data.state === "failed"
			) {
				setGrant(null);
				setViewerState("loading");
				void recoverViewer();
			}
		};
		window.addEventListener("message", listener);
		return () => window.removeEventListener("message", listener);
	}, [recoverViewer]);

	useEffect(() => {
		if (!grant) return;
		const remaining = Date.parse(grant.expiresAt) - Date.now();
		if (remaining <= 0) {
			setGrant(null);
			setViewerState("disconnected");
			return;
		}
		const timeout = window.setTimeout(
			() => {
				if (!session) return;
				void issueGrantSingleFlight(session.id, "view-only")
					.then((renewed) => {
						setGrant(renewed);
						setViewerState("loading");
					})
					.catch(() => {
						setGrant(null);
						setViewerState("loading");
						void recoverViewer();
					});
			},
			Math.max(1, remaining - 30_000),
		);
		return () => window.clearTimeout(timeout);
	}, [grant, session, roomCode, issueGrantSingleFlight, recoverViewer]);

	const provision = async () => {
		sessionRequestRef.current += 1;
		setViewerState("loading");
		setError(null);
		try {
			const created = await sharedBrowserClient.provision({ roomCode });
			setSession(created);
			if (isHost) {
				const issued = await issueGrantSingleFlight(created.id, "controller");
				setAccess("controller");
				setGrant(issued);
				setViewerState("loading");
			} else {
				setGrant(null);
				setViewerState("disconnected");
			}
		} catch (cause) {
			setViewerState("failed");
			setError(cause instanceof Error ? cause.message : "Provisioning failed.");
		}
	};

	const connect = async () => {
		if (!session) return;
		if (!participantId) {
			setViewerState("failed");
			setError("Participant identity is still loading. Retry in a moment.");
			return;
		}
		setViewerState("loading");
		setError(null);
		try {
			const issued = await issueGrantSingleFlight(
				session.id,
				isHost ? access : "view-only",
			);
			setGrant(issued);
		} catch (cause) {
			if (cause instanceof SharedBrowserRequestError && cause.status === 410) {
				setGrant(null);
				setSession(null);
				setViewerState("disconnected");
				setError(null);
				return;
			}
			setViewerState("failed");
			setError(
				cause instanceof Error
					? cause.message
					: "Could not obtain a viewer grant.",
			);
		}
	};

	const revoke = async () => {
		if (!session || !grant) return;
		try {
			await sharedBrowserClient.revokeGrant(session.id, grant.id);
			setGrant(null);
			setViewerState("disconnected");
		} catch (cause) {
			setViewerState("failed");
			setError(
				cause instanceof Error ? cause.message : "Grant revocation failed.",
			);
		}
	};

	const terminate = async () => {
		if (!session) return;
		setViewerState("loading");
		try {
			await sharedBrowserClient.terminate(session.id);
			setGrant(null);
			setSession(null);
			setViewerState("disconnected");
		} catch (cause) {
			setViewerState("failed");
			setError(
				cause instanceof Error ? cause.message : "Session termination failed.",
			);
		}
	};

	const transferControl = async () => {
		if (!session || !controllerTarget) return;
		setError(null);
		try {
			await sharedBrowserClient.grantController(session.id, controllerTarget);
			await onSetAnnotationPermission?.(controllerTarget, true);
			onControllerChanged?.(controllerTarget);
			const issued = await issueGrantSingleFlight(session.id, "view-only");
			setAccess("view-only");
			setGrant(issued);
			setViewerState("loading");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Control transfer failed.",
			);
		}
	};

	const setParticipantControl = async (viewerId: string, allowed: boolean) => {
		if (!session) return;
		setControllerMutationTarget(viewerId);
		setError(null);
		try {
			if (allowed) {
				await sharedBrowserClient.grantController(session.id, viewerId);
				await onSetAnnotationPermission?.(viewerId, true);
				onControllerChanged?.(viewerId);
			} else {
				await sharedBrowserClient.revokeController(session.id, viewerId);
			}
			const current = await sharedBrowserClient.getSession(roomCode);
			setSession(current);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Controller access update failed.",
			);
		} finally {
			setControllerMutationTarget(null);
		}
	};

	const toggleFullscreen = async () => {
		if (document.fullscreenElement) await document.exitFullscreen();
		else await panelRef.current?.requestFullscreen();
	};

	const hasFullAccess =
		!isHost && Boolean(session?.isController || grant?.access === "controller");
	const statusLabel =
		viewerState === "connected"
			? "Connected"
			: viewerState === "loading" || viewerState === "checking"
				? "Connecting"
				: viewerState === "failed"
					? "Connection failed"
					: "Disconnected";

	return (
		<div
			ref={panelRef}
			className="flex h-full max-h-full min-h-0 w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[#dedee5] bg-white sm:rounded-2xl"
		>
			<header className="flex shrink-0 flex-col gap-2 border-b border-[#dedee5] bg-[#fbfbfd] px-[max(0.75rem,env(safe-area-inset-left))] py-2 pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:px-4 sm:py-3">
				<div className="flex min-w-0 items-center gap-3">
					<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#ece9ff] text-[#5d42d6]">
						<Expand className="h-4 w-4" />
					</span>
					<div className="min-w-0">
						<div className="flex max-w-full items-center gap-2 overflow-x-auto pb-1 touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible sm:pb-0">
							<h2 className="shrink-0 whitespace-nowrap font-semibold text-[#08080b]">
								Shared Browser
							</h2>
							<span
								className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${viewerState === "connected" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : viewerState === "failed" ? "border-red-200 bg-red-50 text-red-700" : "border-[#dedee5] bg-[#f0f1f5] text-[#666b77]"}`}
							>
								{statusLabel}
							</span>
						</div>
						<p className="truncate text-[11px] text-[#666b77]">
							Isolated remote browser streamed through an expiring backend grant
						</p>
					</div>
				</div>

				<div className="flex min-w-0 flex-wrap items-center gap-2 overflow-y-auto overscroll-contain [scrollbar-width:none] [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden sm:flex-1 sm:flex-nowrap sm:overflow-x-auto sm:touch-pan-x">
					{grant && (
						<span
							className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${grant.access === "controller" ? "border-[#cfc5ff] bg-[#ece9ff] text-[#5d42d6]" : "border-[#dedee5] bg-[#f0f1f5] text-[#666b77]"}`}
						>
							{grant.access === "controller" ? (
								<MousePointer2 className="h-3 w-3" />
							) : (
								<Eye className="h-3 w-3" />
							)}
							{grant.access === "controller" ? "Controller" : "View only"}
						</span>
					)}
					{hasFullAccess && (
						<span
							role="status"
							className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"
						>
							<MousePointer2 className="h-3 w-3" /> Full access
						</span>
					)}
					<div
						ref={setToolbarContainer}
						className="min-w-0 flex-1 basis-full overflow-hidden sm:basis-auto"
					/>
					<button
						type="button"
						onClick={toggleFullscreen}
						className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-[#f0f1f5] px-3 py-2 text-xs font-semibold text-[#4e535f] transition hover:bg-[#e5e7ed] sm:min-h-0 sm:py-1.5"
					>
						{isFullscreen ? (
							<Minimize2 className="h-3.5 w-3.5" />
						) : (
							<Maximize2 className="h-3.5 w-3.5" />
						)}
						{isFullscreen ? "Exit full screen" : "Full screen"}
					</button>
				</div>
			</header>

			<div className="relative min-h-0 flex-1 bg-[#070b12]">
				{grant ? (
					<>
						<iframe
							ref={viewerFrameRef}
							key={grant.id}
							src={grant.viewerUrl}
							title="Shared Browser remote viewer"
							className="h-full min-h-0 w-full border-0 bg-black"
							allow="fullscreen"
							sandbox="allow-scripts allow-same-origin allow-pointer-lock"
							referrerPolicy="no-referrer"
							onError={() => {
								setViewerState("failed");
								setError(
									"The remote viewer failed to load. Request a fresh grant to reconnect.",
								);
							}}
						/>
						{onAnnotationSubmit && session && (
							<SharedBrowserAnnotationOverlay
								sessionId={session.id}
								participantId={participantId}
								isHost={isHost}
								browserControlActive={grant.access === "controller"}
								interactive={isActive}
								toolbarContainer={toolbarContainer}
								permissions={annotationPermissions}
								initialStrokes={annotationStrokes}
								onSubmitOperation={onAnnotationSubmit}
							/>
						)}
					</>
				) : (
					<div className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto px-4 py-4 text-center sm:px-6">
						{viewerState === "loading" || viewerState === "checking" ? (
							<LoaderCircle className="mb-4 h-10 w-10 animate-spin text-cyan-300" />
						) : viewerState === "failed" ? (
							<AlertTriangle className="mb-4 h-10 w-10 text-red-300" />
						) : (
							<Unplug className="mb-4 h-10 w-10 text-slate-500" />
						)}
						<h3 className="text-lg font-semibold text-[#08080b]">
							{statusLabel}
						</h3>
						<p className="mt-2 max-w-lg text-sm leading-6 text-[#666b77]">
							{error ??
								(session
									? "Connect to request a new short-lived viewer grant. No remote endpoint or reusable credential is stored in this page."
									: isHost
										? "Provision an isolated browser before issuing controller or view-only access."
										: "The host has not provisioned a Shared Browser for this room yet.")}
						</p>
						<div className="mt-5 flex flex-wrap items-center justify-center gap-2">
							{viewerState === "failed" && (
								<button
									type="button"
									onClick={loadSession}
									className="inline-flex items-center gap-2 rounded-lg border border-[#dedee5] bg-[#f0f1f5] px-4 py-2 text-xs font-semibold text-[#4e535f] transition hover:bg-[#e5e7ed]"
								>
									<RefreshCw className="h-3.5 w-3.5" /> Retry status
								</button>
							)}
							{isHost && !session && (
								<button
									type="button"
									onClick={provision}
									className="inline-flex items-center gap-2 rounded-lg bg-[#7659ef] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#6247da]"
								>
									<Power className="h-3.5 w-3.5" /> Provision browser
								</button>
							)}
							{session &&
								viewerState !== "checking" &&
								viewerState !== "loading" && (
									<button
										type="button"
										onClick={connect}
										className="inline-flex items-center gap-2 rounded-lg bg-[#7659ef] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#6247da]"
									>
										<RefreshCw className="h-3.5 w-3.5" />{" "}
										{viewerState === "failed"
											? "Reconnect"
											: isHost
												? `Issue ${access === "controller" ? "controller" : "view-only"} grant`
												: hasFullAccess
													? "Join with full access"
													: "Connect view-only"}
									</button>
								)}
						</div>
					</div>
				)}
			</div>

			<footer className="shrink-0 overflow-y-auto overscroll-contain border-t border-[#dedee5] bg-[#fbfbfd] px-[max(0.75rem,env(safe-area-inset-left))] py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:overflow-hidden sm:px-4 sm:py-3">
				<div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
					<div className="hidden shrink-0 items-center gap-2 text-[11px] text-[#666b77] lg:flex">
						<ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
						Viewer URLs are backend-issued and expire within five minutes.
					</div>
					{isHost && session && (
						<div className="min-w-0 flex-1 space-y-2">
							{participants.some(
								(participant) => participant.id !== participantId,
							) && (
									<section
										aria-labelledby="shared-browser-drawing-permissions"
										className="rounded-lg border border-amber-200 bg-amber-50/70 p-2"
									>
										<p
											id="shared-browser-drawing-permissions"
											className="text-[11px] font-semibold text-amber-800"
										>
											Drawing permissions
										</p>
										<div className="mt-1.5 flex max-w-full flex-wrap items-center gap-2">
											{participants
												.filter((participant) => participant.id !== participantId)
												.map((participant) => {
													const allowed =
														annotationPermissions.allowedUserIds.has(
															participant.id,
														);
													return (
														<button
															key={`draw-${participant.id}`}
															type="button"
															aria-pressed={allowed}
															onClick={() =>
																void onSetAnnotationPermission?.(
																	participant.id,
																	!allowed,
																)
															}
															className={`min-h-11 rounded-lg border px-3 py-2 text-xs font-semibold ${allowed ? "border-amber-300 bg-white text-amber-700" : "border-[#dedee5] bg-white text-[#4e535f]"}`}
														>
															{allowed
																? `Revoke ${participant.name}`
																: `Allow ${participant.name}`}
														</button>
													);
												})}
										</div>
									</section>
								)}
							<div className="flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-2 overflow-y-auto overscroll-contain [scrollbar-width:none] [&>*]:min-h-11 [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden sm:flex-nowrap sm:justify-end sm:overflow-x-auto sm:touch-pan-x [&_select]:max-w-full">
								{false && participants.length > 0 && (
									<>
										<select
											value={controllerTarget}
											onChange={(event) =>
												setControllerTarget(event.target.value)
											}
											className="rounded-lg border border-[#dedee5] bg-white px-2 py-1.5 text-xs text-[#30323a] outline-none focus:border-[#7659ef]"
										>
											<option value="">Transfer control…</option>
											{participants
												.filter(
													(participant) => participant.id !== participantId,
												)
												.map((participant) => (
													<option key={participant.id} value={participant.id}>
														{participant.name}
													</option>
												))}
										</select>
										<button
											type="button"
											disabled={!controllerTarget}
											onClick={transferControl}
											className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 disabled:opacity-50"
										>
											Grant control
										</button>
									</>
								)}
								{participants
									.filter((participant) => participant.id !== participantId)
									.map((participant) => {
										const controllerAllowed =
											session.controllerUserIds?.includes(participant.id) ??
											false;
										const pending = controllerMutationTarget === participant.id;
										return (
											<button
												key={`control-${participant.id}`}
												type="button"
												disabled={pending}
												onClick={() =>
													void setParticipantControl(
														participant.id,
														!controllerAllowed,
													)
												}
												className={`rounded-lg border px-2 py-1.5 text-xs font-semibold disabled:opacity-50 ${controllerAllowed ? "border-[#cfc5ff] bg-[#ece9ff] text-[#5d42d6]" : "border-[#dedee5] bg-white text-[#4e535f]"}`}
											>
												{pending
													? "Updating…"
													: controllerAllowed
														? `Revoke control: ${participant.name}`
														: `Allow control: ${participant.name}`}
											</button>
										);
									})}
								<label className="flex items-center gap-2 text-xs text-[#666b77]">
									Access
									<select
										value={access}
										onChange={(event) =>
											setAccess(event.target.value as SharedBrowserAccess)
										}
										className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400"
									>
										<option value="controller">Controller</option>
										<option value="view-only">View only</option>
									</select>
								</label>
								{grant && (
									<button
										type="button"
										onClick={revoke}
										className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
									>
										Revoke grant
									</button>
								)}
								<button
									type="button"
									onClick={terminate}
									className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100"
								>
									Terminate browser
								</button>
							</div>
						</div>
					)}
				</div>
			</footer>
		</div>
	);
}
